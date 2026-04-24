/**
 * Duplex session coordinator — Phase D.1.
 */

import { DuplexStateMachine, type DuplexStateMachineOptions } from "./state-machine.js";
import { InterruptHandler, type ContextRollbackResult, type InterruptResult } from "./interrupt-handler.js";
import {
  DuplexState, type DuplexCapabilities, type DuplexSessionStartMessage, type DuplexSessionEndMessage,
  type DuplexSessionStats, type InterruptMessage, type BargeInAckMessage, type SessionStateMessage,
  type DuplexControlMessage,
} from "./types.js";
import type { AudioOutputStream } from "../audio/audio-output-stream.js";

export interface DuplexSessionOptions {
  sessionId: string;
  audioOutput: AudioOutputStream;
  sendControl: (msg: DuplexControlMessage) => void;
  rollbackContext: (audioEndMs: number) => Promise<ContextRollbackResult> | ContextRollbackResult;
  idleTimeoutMs?: number;
  interruptDebounceMs?: number;
  now?: () => number;
}

export class DuplexSession {
  readonly sessionId: string;
  readonly stateMachine: DuplexStateMachine;
  readonly interruptHandler: InterruptHandler;
  private readonly sendControl: DuplexSessionOptions["sendControl"];
  private readonly clock: () => number;
  private readonly idleTimeoutMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private capabilities: DuplexCapabilities | null = null;
  private listenStartedAt: number | null = null;
  private speakStartedAt: number | null = null;
  private totalListenTimeMs = 0;
  private totalSpeakTimeMs = 0;

  constructor(options: DuplexSessionOptions) {
    this.sessionId = options.sessionId;
    this.clock = options.now ?? (() => Date.now());
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
    this.sendControl = options.sendControl;

    this.stateMachine = new DuplexStateMachine({ now: this.clock } as DuplexStateMachineOptions);

    this.stateMachine.onTransition((t) => {
      const now = t.meta.timestamp;
      if (t.from === DuplexState.LISTENING || t.from === DuplexState.SIMULTANEOUS) {
        if (this.listenStartedAt != null) { this.totalListenTimeMs += now - this.listenStartedAt; this.listenStartedAt = null; }
      }
      if (t.from === DuplexState.AGENT_SPEAKING || t.from === DuplexState.SIMULTANEOUS) {
        if (this.speakStartedAt != null) { this.totalSpeakTimeMs += now - this.speakStartedAt; this.speakStartedAt = null; }
      }
      if (t.to === DuplexState.LISTENING) this.listenStartedAt = now;
      if (t.to === DuplexState.AGENT_SPEAKING) this.speakStartedAt = now;
      if (t.to === DuplexState.SIMULTANEOUS) {
        this.listenStartedAt = this.listenStartedAt ?? now;
        this.speakStartedAt = this.speakStartedAt ?? now;
      }
      this.broadcastState(now);
      this.resetIdleTimer();
    });

    this.interruptHandler = new InterruptHandler({
      stateMachine: this.stateMachine,
      audioOutput: options.audioOutput,
      rollbackContext: options.rollbackContext,
      sendControl: (msg: InterruptMessage | BargeInAckMessage) => this.sendControl(msg),
      now: this.clock,
      debounceMs: options.interruptDebounceMs,
    });
  }

  get state(): DuplexState { return this.stateMachine.state; }
  get isEnded(): boolean { return this.stateMachine.isTerminal; }

  start(role: "user" | "agent" = "user", capabilities?: Partial<DuplexCapabilities>): void {
    this.capabilities = {
      supportsBargein: capabilities?.supportsBargein ?? true,
      supportsTextInterrupt: capabilities?.supportsTextInterrupt ?? true,
      maxConcurrentTts: capabilities?.maxConcurrentTts ?? 1,
      ...(capabilities?.supportsVideoInterrupt !== undefined ? { supportsVideoInterrupt: capabilities.supportsVideoInterrupt } : {}),
    };
    const now = this.clock();
    this.stateMachine.transition("duplex.session.start", { timestamp: now });
    const startMsg: DuplexSessionStartMessage = {
      type: "duplex.session.start", sessionId: this.sessionId, role, capabilities: this.capabilities, initiatedAt: now,
    };
    this.sendControl(startMsg);
    this.resetIdleTimer();
  }

  end(reason: DuplexSessionEndMessage["reason"] = "user_hang_up"): void {
    if (this.isEnded) return;
    const now = this.clock();
    if (this.listenStartedAt != null) { this.totalListenTimeMs += now - this.listenStartedAt; this.listenStartedAt = null; }
    if (this.speakStartedAt != null) { this.totalSpeakTimeMs += now - this.speakStartedAt; this.speakStartedAt = null; }
    this.stateMachine.transition("duplex.session.end", { timestamp: now, reason });
    const endMsg: DuplexSessionEndMessage = {
      type: "duplex.session.end", sessionId: this.sessionId, reason, finalStats: this.getStats(),
    };
    this.sendControl(endMsg);
    this.clearIdleTimer();
  }

  onUserSpeechStarted(): void {
    const s = this.stateMachine.state;
    if (s === DuplexState.AGENT_SPEAKING) {
      this.stateMachine.transition("user.speech.started", { timestamp: this.clock() });
      if (this.capabilities?.supportsBargein !== false) void this.interruptHandler.handleInterrupt("user_spoke");
    } else if (s === DuplexState.LISTENING) {
      this.stateMachine.tryTransition("user.speech.started", { timestamp: this.clock() });
    }
  }

  onUserSpeechStopped(): void { this.stateMachine.tryTransition("user.speech.stopped", { timestamp: this.clock() }); }
  onResponseStarted(): void { this.stateMachine.tryTransition("response.started", { timestamp: this.clock() }); }
  onResponseAudioDone(): void { this.stateMachine.tryTransition("response.audio_done", { timestamp: this.clock() }); }
  pause(): void { this.stateMachine.tryTransition("session.pause", { timestamp: this.clock() }); this.clearIdleTimer(); }
  resume(): void { this.stateMachine.tryTransition("session.resume", { timestamp: this.clock() }); this.resetIdleTimer(); }

  async triggerInterrupt(reason: "explicit" | "timeout" = "explicit"): Promise<InterruptResult | null> {
    return this.interruptHandler.handleInterrupt(reason);
  }

  getStats(): DuplexSessionStats {
    const i = this.interruptHandler.stats;
    return { totalSpeakTimeMs: this.totalSpeakTimeMs, totalListenTimeMs: this.totalListenTimeMs, interruptCount: i.interruptCount, avgInterruptLatencyMs: i.avgLatencyMs };
  }

  private broadcastState(timestamp: number): void {
    const msg: SessionStateMessage = { type: "session.state", sessionId: this.sessionId, state: this.stateMachine.state, timestamp };
    try { this.sendControl(msg); } catch { /* best-effort */ }
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    if (this.isEnded) return;
    this.idleTimer = setTimeout(() => { if (!this.isEnded) this.end("timeout"); }, this.idleTimeoutMs);
    if (typeof this.idleTimer === "object" && "unref" in this.idleTimer) this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer != null) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  dispose(): void {
    this.clearIdleTimer();
    if (!this.isEnded) this.end("error");
  }
}
