/**
 * Session recovery manager — Phase D.3.
 * Pure module with clock injection.
 */
import type { SessionRecoveryState } from "./mixed-modality-types.js";
import { DEFAULT_MIXED_MODALITY_CONFIG } from "./mixed-modality-types.js";

export interface SessionRecoveryManagerOptions {
  checkpointTtlMs?: number;
  maxRecoveryItems?: number;
  maxRecoveryAttempts?: number;
  now?: () => number;
  onRecovered?: (state: SessionRecoveryState) => void;
  onRecoveryFailed?: (sessionId: string, reason: string) => void;
}

export class SessionRecoveryManager {
  private readonly checkpointTtlMs: number;
  private readonly maxRecoveryItems: number;
  private readonly maxRecoveryAttempts: number;
  private readonly clock: () => number;
  private readonly onRecovered?: (state: SessionRecoveryState) => void;
  private readonly onRecoveryFailed?: (sessionId: string, reason: string) => void;
  private readonly checkpoints = new Map<string, SessionRecoveryState>();
  private readonly attempts = new Map<string, number>();
  private cpCount = 0;
  private okCount = 0;
  private failCount = 0;

  constructor(options: SessionRecoveryManagerOptions = {}) {
    this.checkpointTtlMs = options.checkpointTtlMs ?? 300_000;
    this.maxRecoveryItems = options.maxRecoveryItems ?? DEFAULT_MIXED_MODALITY_CONFIG.maxRecoveryItems;
    this.maxRecoveryAttempts = options.maxRecoveryAttempts ?? DEFAULT_MIXED_MODALITY_CONFIG.maxRecoveryAttempts;
    this.clock = options.now ?? (() => Date.now());
    this.onRecovered = options.onRecovered;
    this.onRecoveryFailed = options.onRecoveryFailed;
  }

  get stats() {
    return { activeCheckpoints: this.checkpoints.size, totalCheckpoints: this.cpCount, totalRecoveries: this.okCount, totalFailures: this.failCount };
  }

  saveCheckpoint(state: SessionRecoveryState): void {
    const trimmed: SessionRecoveryState = { ...state, conversationHistory: state.conversationHistory.slice(-this.maxRecoveryItems), checkpointAt: this.clock() };
    this.checkpoints.set(state.sessionId, trimmed);
    this.cpCount++;
  }

  getCheckpoint(sessionId: string): SessionRecoveryState | null {
    const cp = this.checkpoints.get(sessionId);
    if (!cp) return null;
    if (this.clock() - cp.checkpointAt > this.checkpointTtlMs) { this.checkpoints.delete(sessionId); return null; }
    return cp;
  }

  attemptRecovery(sessionId: string): { recovered: boolean; checkpoint?: SessionRecoveryState; reason?: string } {
    const cp = this.getCheckpoint(sessionId);
    if (!cp) {
      this.failCount++;
      try { this.onRecoveryFailed?.(sessionId, "no_valid_checkpoint"); } catch { /* */ }
      return { recovered: false, reason: "no_valid_checkpoint" };
    }
    const cur = (this.attempts.get(sessionId) ?? 0) + 1;
    this.attempts.set(sessionId, cur);
    if (cur > this.maxRecoveryAttempts) {
      this.failCount++;
      this.checkpoints.delete(sessionId);
      try { this.onRecoveryFailed?.(sessionId, "max_attempts_exceeded"); } catch { /* */ }
      return { recovered: false, reason: "max_attempts_exceeded" };
    }
    this.okCount++;
    const recovered: SessionRecoveryState = { ...cp, recoveryAttempts: cur };
    try { this.onRecovered?.(recovered); } catch { /* */ }
    return { recovered: true, checkpoint: recovered };
  }

  removeCheckpoint(sessionId: string): boolean { this.attempts.delete(sessionId); return this.checkpoints.delete(sessionId); }

  pruneExpired(): number {
    const now = this.clock();
    let pruned = 0;
    for (const [id, cp] of this.checkpoints) {
      if (now - cp.checkpointAt > this.checkpointTtlMs) { this.checkpoints.delete(id); this.attempts.delete(id); pruned++; }
    }
    return pruned;
  }

  buildRecoveryContext(checkpoint: SessionRecoveryState): { systemPrompt: string; messages: Array<{ role: string; content: string }> } {
    const messages = checkpoint.conversationHistory.map((item) => ({
      role: item.role,
      content: item.modality === "audio" ? `[audio transcript] ${item.content}` : item.content,
    }));
    return {
      systemPrompt: "This is a recovered session. The user was previously in a conversation that was interrupted. Continue naturally from the context below.",
      messages,
    };
  }

  clear(): void { this.checkpoints.clear(); this.attempts.clear(); }
}
