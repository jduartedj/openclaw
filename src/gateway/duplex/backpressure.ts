/**
 * Backpressure monitor — Phase D.2.
 *
 * Watches an AudioOutputStream's queue depth and emits flow-control
 * signals (high / low) via a control-channel callback, plus an optional
 * provider-pause callback to throttle the upstream LLM/TTS source.
 *
 * Drop policy: when queue grows past `maxQueuedMs`, the monitor invokes
 * `onOverflow` with the bytes/ms that should be discarded so the
 * AudioOutputStream owner can truncate (we do not call `truncateAt`
 * directly here — the duplex coordinator owns playback timeline).
 *
 * Hysteresis prevents flapping: once "high" is signalled, queue must
 * drop below `lowWaterMs` before "low" is emitted.
 *
 * Pure module: no timers, no I/O. Caller drives `evaluate()` after
 * meaningful queue-changing events (push, drain, truncate).
 */

import type { AudioOutputStream } from "../audio/audio-output-stream.js";
import type { BackpressureLevel, BackpressureMessage } from "../multiplex-control.js";

export interface BackpressureMonitorOptions {
  /** Queue depth (ms) at or above which we signal "high". */
  highWaterMs: number;
  /** Queue depth (ms) at or below which we signal "low" again. */
  lowWaterMs: number;
  /**
   * Hard ceiling — when queue exceeds this, drop policy fires.
   * Defaults to `highWaterMs * 2`.
   */
  maxQueuedMs?: number;
  /** Stream id this monitor reports against (for the BackpressureMessage). */
  streamId?: number;
  /** Send a backpressure control message to the peer / consumer. */
  sendBackpressure: (msg: BackpressureMessage) => void;
  /**
   * Called when queue crosses the "high" threshold — signal upstream
   * (LLM provider) to pause synthesis.
   */
  onPause?: () => void;
  /** Called when queue drains back below `lowWaterMs`. */
  onResume?: () => void;
  /**
   * Called when the queue exceeds `maxQueuedMs`. Receives the
   * truncate-at timeline position the caller should apply.
   */
  onOverflow?: (truncateAtMs: number, droppedMs: number) => void;
}

export interface BackpressureSnapshot {
  queuedMs: number;
  level: BackpressureLevel | null;
  isPaused: boolean;
  highSignals: number;
  lowSignals: number;
  overflows: number;
}

export class BackpressureMonitor {
  private readonly opts: Required<
    Omit<BackpressureMonitorOptions, "onPause" | "onResume" | "onOverflow" | "streamId">
  > &
    Pick<BackpressureMonitorOptions, "onPause" | "onResume" | "onOverflow" | "streamId">;

  private currentLevel: BackpressureLevel | null = null;
  private paused = false;
  private highSignals = 0;
  private lowSignals = 0;
  private overflows = 0;

  constructor(options: BackpressureMonitorOptions) {
    if (!Number.isFinite(options.highWaterMs) || options.highWaterMs <= 0) {
      throw new RangeError("BackpressureMonitor.highWaterMs must be > 0");
    }
    if (!Number.isFinite(options.lowWaterMs) || options.lowWaterMs < 0) {
      throw new RangeError("BackpressureMonitor.lowWaterMs must be >= 0");
    }
    if (options.lowWaterMs >= options.highWaterMs) {
      throw new RangeError("BackpressureMonitor.lowWaterMs must be < highWaterMs (hysteresis)");
    }
    const maxQueuedMs = options.maxQueuedMs ?? options.highWaterMs * 2;
    if (maxQueuedMs <= options.highWaterMs) {
      throw new RangeError("BackpressureMonitor.maxQueuedMs must be > highWaterMs");
    }
    this.opts = {
      highWaterMs: options.highWaterMs,
      lowWaterMs: options.lowWaterMs,
      maxQueuedMs,
      streamId: options.streamId,
      sendBackpressure: options.sendBackpressure,
      onPause: options.onPause,
      onResume: options.onResume,
      onOverflow: options.onOverflow,
    };
  }

  get snapshot(): BackpressureSnapshot {
    return {
      queuedMs: 0, // populated by evaluate()
      level: this.currentLevel,
      isPaused: this.paused,
      highSignals: this.highSignals,
      lowSignals: this.lowSignals,
      overflows: this.overflows,
    };
  }

  /**
   * Inspect the queue depth and emit signals as thresholds are crossed.
   *
   * @param queuedMs Current outbound queue depth in ms.
   * @param playbackPositionMs Optional current playback head — required
   *   if `onOverflow` should compute a truncate-at position.
   */
  evaluate(queuedMs: number, playbackPositionMs = 0): BackpressureSnapshot {
    if (!Number.isFinite(queuedMs) || queuedMs < 0) {
      throw new RangeError(`BackpressureMonitor.evaluate: queuedMs must be >= 0 (got ${queuedMs})`);
    }

    // Overflow: caller asked us to bound queue absolutely.
    if (queuedMs > this.opts.maxQueuedMs && this.opts.onOverflow) {
      const droppedMs = queuedMs - this.opts.maxQueuedMs;
      const truncateAtMs = playbackPositionMs + this.opts.maxQueuedMs;
      this.overflows++;
      try {
        this.opts.onOverflow(truncateAtMs, droppedMs);
      } catch {
        /* swallow — never poison the audio path */
      }
      // After overflow, queue is presumed bounded; recompute.
      queuedMs = this.opts.maxQueuedMs;
    }

    // High edge.
    if (queuedMs >= this.opts.highWaterMs && this.currentLevel !== "high") {
      this.currentLevel = "high";
      this.highSignals++;
      this.signal("high", queuedMs);
      if (!this.paused) {
        this.paused = true;
        try {
          this.opts.onPause?.();
        } catch {
          /* swallow */
        }
      }
    }
    // Low edge.
    else if (queuedMs <= this.opts.lowWaterMs && this.currentLevel === "high") {
      this.currentLevel = "low";
      this.lowSignals++;
      this.signal("low", queuedMs);
      if (this.paused) {
        this.paused = false;
        try {
          this.opts.onResume?.();
        } catch {
          /* swallow */
        }
      }
    }

    return {
      queuedMs,
      level: this.currentLevel,
      isPaused: this.paused,
      highSignals: this.highSignals,
      lowSignals: this.lowSignals,
      overflows: this.overflows,
    };
  }

  /** Force-reset (e.g., session end). */
  reset(): void {
    this.currentLevel = null;
    this.paused = false;
  }

  private signal(level: BackpressureLevel, queuedMs: number): void {
    const msg: BackpressureMessage = {
      type: "backpressure",
      level,
      ...(this.opts.streamId !== undefined ? { streamId: this.opts.streamId } : {}),
    };
    // Queue depth in bytes is unknown here (ms-based monitor) — leave
    // queuedFrames out unless caller wants to wrap.
    if (queuedMs > 0) {
      msg.queuedFrames = Math.ceil(queuedMs);
    }
    try {
      this.opts.sendBackpressure(msg);
    } catch {
      /* swallow */
    }
  }
}

/**
 * Convenience: bind a monitor to an AudioOutputStream so every
 * `pushAudio` automatically re-evaluates queue depth.
 *
 * Returns the monitor plus an `unbind()` to stop instrumenting.
 */
export interface BoundBackpressureMonitor {
  monitor: BackpressureMonitor;
  unbind: () => void;
}

export function bindToAudioOutput(
  audioOutput: AudioOutputStream,
  options: BackpressureMonitorOptions,
): BoundBackpressureMonitor {
  const monitor = new BackpressureMonitor(options);
  // Capture prototype methods bound to instance so unbind can restore them precisely
  // (avoids leaving the instance with bound versions that fail
  // identity checks in callers' diagnostics).
  const originalPush = audioOutput.pushAudio.bind(audioOutput);
  const originalTruncate = audioOutput.truncateAt.bind(audioOutput);
  // Track pending (un-played) ms ourselves. Wall-clock-based playback
  // position can race the test in setup-heavy environments; we want a
  // deterministic queue-depth signal that reflects what we've shipped
  // since the last truncate or reset.
  let pendingMs = 0;

  audioOutput.pushAudio = ((payload, durationMs, opts) => {
    const result = originalPush.call(audioOutput, payload, durationMs, opts);
    if (result != null) {
      pendingMs += durationMs;
    }
    monitor.evaluate(pendingMs, audioOutput.stats.playbackPositionMs);
    return result;
  }) as typeof audioOutput.pushAudio;

  audioOutput.truncateAt = ((atMs) => {
    const result = originalTruncate.call(audioOutput, atMs);
    // After truncate, pending shrinks to whatever survived (if any).
    pendingMs = Math.max(0, audioOutput.stats.totalEnqueuedMs - atMs);
    monitor.evaluate(pendingMs, audioOutput.stats.playbackPositionMs);
    return result;
  }) as typeof audioOutput.truncateAt;

  return {
    monitor,
    unbind: () => {
      // Delete the per-instance overrides so subsequent reads fall
      // back to the prototype, restoring original method identity.
      delete (audioOutput as { pushAudio?: AudioOutputStream["pushAudio"] }).pushAudio;
      delete (audioOutput as { truncateAt?: AudioOutputStream["truncateAt"] }).truncateAt;
    },
  };
}
