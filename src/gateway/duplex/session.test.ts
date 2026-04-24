import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { DuplexSession } from "./session.js";
import { DuplexState } from "./types.js";
import type { DuplexControlMessage, DuplexSessionStartMessage, DuplexSessionEndMessage, SessionStateMessage } from "./types.js";
import { AudioOutputStream } from "../audio/audio-output-stream.js";
import { _resetInterruptSeq } from "./interrupt-handler.js";

function mkSession(opts?: { idleTimeoutMs?: number; now?: () => number }) {
  let now = 1000;
  const clock = opts?.now ?? (() => now);
  const ctrl: DuplexControlMessage[] = [];
  const ao = new AudioOutputStream({ send: () => {}, now: clock });
  const rb = vi.fn().mockResolvedValue({ rolledBackBytes: 256, acknowledged: true });
  const s = new DuplexSession({ sessionId: "test-001", audioOutput: ao, sendControl: (m) => ctrl.push(m), rollbackContext: rb, idleTimeoutMs: opts?.idleTimeoutMs ?? 60_000, now: clock });
  return { s, ao, ctrl, rb, advance: (ms: number) => { now += ms; } };
}

describe("DuplexSession", () => {
  beforeEach(() => { _resetInterruptSeq(); vi.useFakeTimers(); });
  afterEach(() => { _resetInterruptSeq(); vi.useRealTimers(); });

  it("starts in INIT state", () => { const { s } = mkSession(); expect(s.state).toBe(DuplexState.INIT); });

  it("transitions to LISTENING on start()", () => {
    const { s, ctrl } = mkSession(); s.start("user"); expect(s.state).toBe(DuplexState.LISTENING);
    const m = ctrl.find(c => c.type === "duplex.session.start") as DuplexSessionStartMessage;
    expect(m).toBeDefined(); expect(m.sessionId).toBe("test-001"); expect(m.capabilities.supportsBargein).toBe(true);
  });

  it("transitions to ENDED on end()", () => {
    const { s, ctrl } = mkSession(); s.start(); s.end("user_hang_up");
    expect(s.state).toBe(DuplexState.ENDED);
    const m = ctrl.find(c => c.type === "duplex.session.end") as DuplexSessionEndMessage;
    expect(m).toBeDefined(); expect(m.reason).toBe("user_hang_up"); expect(m.finalStats).toBeDefined();
  });

  it("end() is idempotent", () => {
    const { s, ctrl } = mkSession(); s.start(); s.end("user_hang_up");
    const n = ctrl.length; s.end("user_hang_up"); expect(ctrl.length).toBe(n);
  });

  it("handles user speech lifecycle in LISTENING", () => {
    const { s } = mkSession(); s.start(); s.onUserSpeechStarted(); expect(s.state).toBe(DuplexState.LISTENING);
    s.onUserSpeechStopped(); expect(s.state).toBe(DuplexState.LISTENING);
  });

  it("handles response lifecycle", () => {
    const { s } = mkSession(); s.start(); s.onResponseStarted(); expect(s.state).toBe(DuplexState.AGENT_SPEAKING);
    s.onResponseAudioDone(); expect(s.state).toBe(DuplexState.LISTENING);
  });

  it("triggers interrupt when user speaks during agent output", async () => {
    const { s, ao, ctrl } = mkSession(); s.start(); s.onResponseStarted();
    ao.pushAudio(Buffer.alloc(3200), 100); s.onUserSpeechStarted();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.state).toBe(DuplexState.LISTENING);
    expect(ctrl.find(c => c.type === "interrupt")).toBeDefined();
    expect(ctrl.find(c => c.type === "barge_in.ack")).toBeDefined();
  });

  it("supports pause and resume", () => {
    const { s } = mkSession(); s.start(); s.pause(); expect(s.state).toBe(DuplexState.PAUSED);
    s.resume(); expect(s.state).toBe(DuplexState.LISTENING);
  });

  it("triggerInterrupt() works from AGENT_SPEAKING", async () => {
    const { s, ao } = mkSession(); s.start(); s.onResponseStarted(); ao.pushAudio(Buffer.alloc(3200), 100);
    expect(await s.triggerInterrupt("explicit")).not.toBeNull(); expect(s.state).toBe(DuplexState.LISTENING);
  });

  it("triggerInterrupt() returns null from LISTENING", async () => {
    const { s } = mkSession(); s.start(); expect(await s.triggerInterrupt("explicit")).toBeNull();
  });

  it("broadcasts session.state on every transition", () => {
    const { s, ctrl } = mkSession(); s.start(); s.onResponseStarted();
    const states = ctrl.filter(c => c.type === "session.state") as SessionStateMessage[];
    expect(states.length).toBeGreaterThanOrEqual(2);
    expect(states[0]!.state).toBe(DuplexState.LISTENING); expect(states[1]!.state).toBe(DuplexState.AGENT_SPEAKING);
  });

  it("ends session on idle timeout", () => {
    const { s } = mkSession({ idleTimeoutMs: 100 }); s.start();
    vi.advanceTimersByTime(150); expect(s.state).toBe(DuplexState.ENDED);
  });

  it("resets idle timer on activity", () => {
    const { s } = mkSession({ idleTimeoutMs: 100 }); s.start();
    vi.advanceTimersByTime(50); s.onUserSpeechStarted();
    vi.advanceTimersByTime(50); expect(s.state).toBe(DuplexState.LISTENING);
    vi.advanceTimersByTime(60); expect(s.state).toBe(DuplexState.ENDED);
  });

  it("tracks listen and speak time", () => {
    let now = 1000;
    const { s } = mkSession({ now: () => now }); s.start();
    now = 2000; s.onResponseStarted(); now = 3500; s.onResponseAudioDone();
    now = 4000; s.end("user_hang_up");
    const stats = s.getStats();
    expect(stats.totalListenTimeMs).toBe(1500); expect(stats.totalSpeakTimeMs).toBe(1500);
  });

  it("dispose() ends session if not already ended", () => {
    const { s } = mkSession(); s.start(); s.dispose(); expect(s.isEnded).toBe(true);
  });

  it("dispose() is safe on already-ended session", () => {
    const { s } = mkSession(); s.start(); s.end("user_hang_up"); expect(() => s.dispose()).not.toThrow();
  });

  it("uses default capabilities when none provided", () => {
    const { s, ctrl } = mkSession(); s.start();
    const m = ctrl.find(c => c.type === "duplex.session.start") as DuplexSessionStartMessage;
    expect(m.capabilities.supportsBargein).toBe(true); expect(m.capabilities.maxConcurrentTts).toBe(1);
  });

  it("uses custom capabilities when provided", () => {
    const { s, ctrl } = mkSession(); s.start("agent", { supportsBargein: false, maxConcurrentTts: 3 });
    const m = ctrl.find(c => c.type === "duplex.session.start") as DuplexSessionStartMessage;
    expect(m.capabilities.supportsBargein).toBe(false); expect(m.capabilities.maxConcurrentTts).toBe(3); expect(m.role).toBe("agent");
  });

  it("skips interrupt when supportsBargein is false", async () => {
    const { s, ao, ctrl } = mkSession(); s.start("user", { supportsBargein: false });
    s.onResponseStarted(); ao.pushAudio(Buffer.alloc(3200), 100); s.onUserSpeechStarted();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.state).toBe(DuplexState.SIMULTANEOUS);
    expect(ctrl.find(c => c.type === "interrupt")).toBeUndefined();
  });

  it("survives sendControl failures during state broadcast", () => {
    let fail = false; let now = 1000;
    const ao = new AudioOutputStream({ send: () => {}, now: () => now });
    const s = new DuplexSession({
      sessionId: "fail", audioOutput: ao,
      sendControl: () => { if (fail) throw new Error("fail"); },
      rollbackContext: vi.fn().mockResolvedValue({ rolledBackBytes: 0, acknowledged: true }), now: () => now,
    });
    s.start(); fail = true; expect(() => s.onResponseStarted()).not.toThrow();
  });
});
