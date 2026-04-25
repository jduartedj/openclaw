/**
 * Tests for BackpressureMonitor — Phase D.2.
 */
import { describe, expect, it, vi } from "vitest";
import { AudioOutputStream } from "../audio/audio-output-stream.js";
import type { BackpressureMessage } from "../multiplex-control.js";
import {
  BackpressureMonitor,
  bindToAudioOutput,
  type BackpressureMonitorOptions,
} from "./backpressure.js";

function makeMonitor(overrides: Partial<BackpressureMonitorOptions> = {}) {
  const messages: BackpressureMessage[] = [];
  const monitor = new BackpressureMonitor({
    highWaterMs: 1000,
    lowWaterMs: 200,
    maxQueuedMs: 3000,
    sendBackpressure: (m) => messages.push(m),
    ...overrides,
  });
  return { monitor, messages };
}

describe("BackpressureMonitor — construction", () => {
  it("rejects non-positive highWaterMs", () => {
    expect(
      () =>
        new BackpressureMonitor({
          highWaterMs: 0,
          lowWaterMs: 0,
          sendBackpressure: () => {},
        }),
    ).toThrow(/highWaterMs/);
  });

  it("rejects negative lowWaterMs", () => {
    expect(
      () =>
        new BackpressureMonitor({
          highWaterMs: 100,
          lowWaterMs: -1,
          sendBackpressure: () => {},
        }),
    ).toThrow(/lowWaterMs/);
  });

  it("rejects lowWaterMs >= highWaterMs", () => {
    expect(
      () =>
        new BackpressureMonitor({
          highWaterMs: 100,
          lowWaterMs: 100,
          sendBackpressure: () => {},
        }),
    ).toThrow(/hysteresis/);
  });

  it("rejects maxQueuedMs <= highWaterMs", () => {
    expect(
      () =>
        new BackpressureMonitor({
          highWaterMs: 1000,
          lowWaterMs: 200,
          maxQueuedMs: 1000,
          sendBackpressure: () => {},
        }),
    ).toThrow(/maxQueuedMs/);
  });

  it("defaults maxQueuedMs to 2x highWaterMs", () => {
    const { monitor } = makeMonitor({ maxQueuedMs: undefined });
    // Push above 2x — should overflow.
    let overflows = 0;
    const m2 = new BackpressureMonitor({
      highWaterMs: 100,
      lowWaterMs: 10,
      sendBackpressure: () => {},
      onOverflow: () => overflows++,
    });
    m2.evaluate(250); // > 200 default max
    expect(overflows).toBe(1);
    expect(monitor).toBeDefined();
  });
});

describe("BackpressureMonitor — threshold signals", () => {
  it("does not signal under high water", () => {
    const { monitor, messages } = makeMonitor();
    monitor.evaluate(500);
    expect(messages).toHaveLength(0);
    expect(monitor.snapshot.level).toBeNull();
  });

  it("emits 'high' once when crossing threshold", () => {
    const { monitor, messages } = makeMonitor();
    monitor.evaluate(1500);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.type).toBe("backpressure");
    expect(messages[0]?.level).toBe("high");
    // Stay above; no duplicate.
    monitor.evaluate(1800);
    expect(messages).toHaveLength(1);
  });

  it("emits 'low' only after dropping below lowWaterMs (hysteresis)", () => {
    const { monitor, messages } = makeMonitor();
    monitor.evaluate(1500); // high
    monitor.evaluate(800); // between thresholds — no signal
    expect(messages).toHaveLength(1);
    monitor.evaluate(150); // <= lowWater
    expect(messages).toHaveLength(2);
    expect(messages[1]?.level).toBe("low");
  });

  it("emits 'high' again after going low → high", () => {
    const { monitor, messages } = makeMonitor();
    monitor.evaluate(1500);
    monitor.evaluate(100);
    monitor.evaluate(1500);
    const levels = messages.map((m) => m.level);
    expect(levels).toEqual(["high", "low", "high"]);
  });

  it("includes streamId when configured", () => {
    const { monitor, messages } = makeMonitor({ streamId: 2 });
    monitor.evaluate(1500);
    expect(messages[0]?.streamId).toBe(2);
  });

  it("omits streamId when not configured", () => {
    const { monitor, messages } = makeMonitor();
    monitor.evaluate(1500);
    expect(messages[0]?.streamId).toBeUndefined();
  });
});

describe("BackpressureMonitor — pause/resume callbacks", () => {
  it("invokes onPause on first 'high'", () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    const { monitor } = makeMonitor({ onPause, onResume });
    monitor.evaluate(1500);
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalled();
  });

  it("invokes onResume on transition back to low", () => {
    const onPause = vi.fn();
    const onResume = vi.fn();
    const { monitor } = makeMonitor({ onPause, onResume });
    monitor.evaluate(1500);
    monitor.evaluate(100);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("does not double-invoke onPause if already paused", () => {
    const onPause = vi.fn();
    const { monitor } = makeMonitor({ onPause });
    monitor.evaluate(1500);
    monitor.evaluate(2000);
    monitor.evaluate(1800);
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it("survives onPause throwing", () => {
    const onPause = vi.fn(() => {
      throw new Error("provider unavailable");
    });
    const { monitor } = makeMonitor({ onPause });
    expect(() => monitor.evaluate(1500)).not.toThrow();
    expect(monitor.snapshot.isPaused).toBe(true);
  });

  it("survives onResume throwing", () => {
    const onResume = vi.fn(() => {
      throw new Error("provider unreachable");
    });
    const { monitor } = makeMonitor({ onResume });
    monitor.evaluate(1500);
    expect(() => monitor.evaluate(100)).not.toThrow();
  });
});

describe("BackpressureMonitor — drop policy / overflow", () => {
  it("invokes onOverflow when exceeding maxQueuedMs", () => {
    const onOverflow = vi.fn();
    const { monitor } = makeMonitor({ onOverflow });
    monitor.evaluate(3500, 1000);
    expect(onOverflow).toHaveBeenCalledTimes(1);
    const [truncateAtMs, droppedMs] = onOverflow.mock.calls[0];
    expect(droppedMs).toBe(500);
    expect(truncateAtMs).toBe(1000 + 3000);
  });

  it("does not overflow at exact max", () => {
    const onOverflow = vi.fn();
    const { monitor } = makeMonitor({ onOverflow });
    monitor.evaluate(3000);
    expect(onOverflow).not.toHaveBeenCalled();
  });

  it("counts overflows in snapshot", () => {
    const onOverflow = vi.fn();
    const { monitor } = makeMonitor({ onOverflow });
    monitor.evaluate(3500);
    monitor.evaluate(100);
    monitor.evaluate(3700);
    expect(monitor.snapshot.overflows).toBe(2);
  });

  it("survives onOverflow throwing", () => {
    const onOverflow = vi.fn(() => {
      throw new Error("buffer locked");
    });
    const { monitor } = makeMonitor({ onOverflow });
    expect(() => monitor.evaluate(5000)).not.toThrow();
    expect(monitor.snapshot.overflows).toBe(1);
  });

  it("after overflow, signals high (queue clamped)", () => {
    const { monitor, messages } = makeMonitor({ onOverflow: () => {} });
    monitor.evaluate(5000);
    expect(messages.some((m) => m.level === "high")).toBe(true);
  });
});

describe("BackpressureMonitor — input validation", () => {
  it("rejects negative queuedMs", () => {
    const { monitor } = makeMonitor();
    expect(() => monitor.evaluate(-1)).toThrow(/queuedMs/);
  });

  it("rejects NaN queuedMs", () => {
    const { monitor } = makeMonitor();
    expect(() => monitor.evaluate(Number.NaN)).toThrow(/queuedMs/);
  });
});

describe("BackpressureMonitor — reset()", () => {
  it("clears level and paused state", () => {
    const { monitor } = makeMonitor();
    monitor.evaluate(1500);
    expect(monitor.snapshot.isPaused).toBe(true);
    monitor.reset();
    expect(monitor.snapshot.level).toBeNull();
    expect(monitor.snapshot.isPaused).toBe(false);
  });
});

describe("BackpressureMonitor — sendBackpressure errors swallowed", () => {
  it("does not throw if sendBackpressure throws", () => {
    const monitor = new BackpressureMonitor({
      highWaterMs: 100,
      lowWaterMs: 10,
      sendBackpressure: () => {
        throw new Error("ws closed");
      },
    });
    expect(() => monitor.evaluate(500)).not.toThrow();
  });
});

describe("bindToAudioOutput", () => {
  function makeOutput() {
    const sent: Buffer[] = [];
    const stream = new AudioOutputStream({
      send: (f) => sent.push(f),
      // Tiny buffer so a few chunks blow the threshold.
    });
    return { stream, sent };
  }

  it("auto-evaluates monitor on every pushAudio", () => {
    const messages: BackpressureMessage[] = [];
    const { stream } = makeOutput();
    const { monitor, unbind } = bindToAudioOutput(stream, {
      highWaterMs: 100,
      lowWaterMs: 20,
      sendBackpressure: (m) => messages.push(m),
    });

    stream.pushAudio(Buffer.alloc(160), 50);
    expect(messages).toHaveLength(0);
    stream.pushAudio(Buffer.alloc(160), 60); // total 110 ms — high
    expect(messages).toHaveLength(1);
    expect(messages[0]?.level).toBe("high");
    unbind();
    expect(monitor.snapshot.level).toBe("high");
  });

  it("re-evaluates after truncateAt drains the queue", () => {
    const messages: BackpressureMessage[] = [];
    const { stream } = makeOutput();
    bindToAudioOutput(stream, {
      highWaterMs: 100,
      lowWaterMs: 20,
      sendBackpressure: (m) => messages.push(m),
    });

    stream.pushAudio(Buffer.alloc(160), 50);
    stream.pushAudio(Buffer.alloc(160), 80); // high
    stream.truncateAt(0); // drop everything
    const levels = messages.map((m) => m.level);
    expect(levels).toContain("high");
    expect(levels).toContain("low");
  });

  it("unbind() restores original methods", () => {
    const { stream } = makeOutput();
    const originalPush = stream.pushAudio;
    const { unbind } = bindToAudioOutput(stream, {
      highWaterMs: 1000,
      lowWaterMs: 100,
      sendBackpressure: () => {},
    });
    expect(stream.pushAudio).not.toBe(originalPush);
    unbind();
    expect(stream.pushAudio).toBe(originalPush);
  });
});
