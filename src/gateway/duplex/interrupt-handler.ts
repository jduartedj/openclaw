/**
 * Interrupt handler — Phase D.1.
 */

import type { AudioOutputStream } from "../audio/audio-output-stream.js";
import type { TruncateResult } from "../audio/output-buffer.js";
import type { InterruptMessage, BargeInAckMessage } from "./types.js";
import type { DuplexStateMachine } from "./state-machine.js";

export interface ContextRollbackResult {
  rolledBackBytes: number;
  acknowledged: boolean;
}

export interface InterruptHandlerOptions {
  stateMachine: DuplexStateMachine;
  audioOutput: AudioOutputStream;
  rollbackContext: (audioEndMs: number) => Promise<ContextRollbackResult> | ContextRollbackResult;
  sendControl: (msg: InterruptMessage | BargeInAckMessage) => void;
  now?: () => number;
  debounceMs?: number;
}

export interface InterruptResult {
  interruptId: string;
  totalLatencyMs: number;
  truncateLatencyMs: number;
  rollbackLatencyMs: number;
  truncateResult: TruncateResult;
  rollbackResult: ContextRollbackResult;
  withinBudget: boolean;
}

let interruptSeq = 0;
function nextInterruptId(): string { return `int_${++interruptSeq}_${Date.now().toString(36)}`; }
export function _resetInterruptSeq(): void { interruptSeq = 0; }
export const INTERRUPT_LATENCY_BUDGET_MS = 250;

export class InterruptHandler {
  private readonly sm: DuplexStateMachine;
  private readonly audioOutput: AudioOutputStream;
  private readonly rollbackContext: InterruptHandlerOptions["rollbackContext"];
  private readonly sendControl: InterruptHandlerOptions["sendControl"];
  private readonly clock: () => number;
  private readonly debounceMs: number;
  private lastInterruptAt = 0;
  private _interruptCount = 0;
  private _totalLatencyMs = 0;
  private _budgetBreaches = 0;

  constructor(options: InterruptHandlerOptions) {
    this.sm = options.stateMachine;
    this.audioOutput = options.audioOutput;
    this.rollbackContext = options.rollbackContext;
    this.sendControl = options.sendControl;
    this.clock = options.now ?? (() => Date.now());
    this.debounceMs = options.debounceMs ?? 200;
  }

  get stats() {
    return {
      interruptCount: this._interruptCount,
      avgLatencyMs: this._interruptCount > 0 ? this._totalLatencyMs / this._interruptCount : 0,
      budgetBreaches: this._budgetBreaches,
    };
  }

  async handleInterrupt(reason: "user_spoke" | "explicit" | "timeout" = "user_spoke"): Promise<InterruptResult | null> {
    const now = this.clock();
    if (now - this.lastInterruptAt < this.debounceMs) return null;
    if (!this.sm.canTransition("interrupt")) return null;

    const startMs = now;
    this.lastInterruptAt = now;
    const interruptId = nextInterruptId();
    const playbackPositionMs = this.audioOutput.buffer.getPlaybackPosition();

    this.sm.transition("interrupt", { timestamp: now, reason: `interrupt:${reason}` });

    const interruptMsg: InterruptMessage = {
      type: "interrupt", interruptId, streamId: 2, reason, interruptedAtMs: playbackPositionMs,
    };
    try { this.sendControl(interruptMsg); } catch { /* best-effort */ }

    const truncateStart = this.clock();
    const truncateResult = this.audioOutput.truncateAt(playbackPositionMs);
    const truncateEnd = this.clock();

    const rollbackStart = this.clock();
    let rollbackResult: ContextRollbackResult;
    try { rollbackResult = await this.rollbackContext(playbackPositionMs); }
    catch { rollbackResult = { rolledBackBytes: 0, acknowledged: false }; }
    const rollbackEnd = this.clock();

    const ackMsg: BargeInAckMessage = {
      type: "barge_in.ack", interruptId, contextRolledBackBytes: rollbackResult.rolledBackBytes,
      newTtsInitiatedAt: rollbackEnd, expectedLatencyMs: 0,
    };
    try { this.sendControl(ackMsg); } catch { /* best-effort */ }

    this.sm.transition("rollback.complete", { timestamp: this.clock(), reason: "interrupt resolved" });

    const totalLatencyMs = this.clock() - startMs;
    const withinBudget = totalLatencyMs <= INTERRUPT_LATENCY_BUDGET_MS;
    this._interruptCount++;
    this._totalLatencyMs += totalLatencyMs;
    if (!withinBudget) this._budgetBreaches++;

    return {
      interruptId, totalLatencyMs,
      truncateLatencyMs: truncateEnd - truncateStart,
      rollbackLatencyMs: rollbackEnd - rollbackStart,
      truncateResult, rollbackResult, withinBudget,
    };
  }
}
