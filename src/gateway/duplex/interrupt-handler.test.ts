import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { InterruptHandler, _resetInterruptSeq, type ContextRollbackResult } from "./interrupt-handler.js";
import { DuplexStateMachine } from "./state-machine.js";
import { DuplexState } from "./types.js";
import type { InterruptMessage, BargeInAckMessage } from "./types.js";
import { AudioOutputStream } from "../audio/audio-output-stream.js";

function mkAO(clock: () => number) {
  const sent: Buffer[] = [];
  return { ao: new AudioOutputStream({ send: (f) => sent.push(f), now: clock }), sent };
}

function setup(clock: () => number) {
  const sm = new DuplexStateMachine({ now: clock });
  const { ao, sent } = mkAO(clock);
  const ctrl: Array<InterruptMessage | BargeInAckMessage> = [];
  const rbResult: ContextRollbackResult = { rolledBackBytes: 512, acknowledged: true };
  const rbFn = vi.fn().mockResolvedValue(rbResult);
  sm.transition("duplex.session.start"); sm.transition("response.started");
  ao.pushAudio(Buffer.alloc(3200), 100); ao.pushAudio(Buffer.alloc(3200), 100);
  const h = new InterruptHandler({ stateMachine: sm, audioOutput: ao, rollbackContext: rbFn, sendControl: (m) => ctrl.push(m), now: clock });
  return { sm, ao, sent, ctrl, rbFn, h, rbResult };
}

describe("InterruptHandler", () => {
  let now: number; let clock: () => number;
  beforeEach(() => { now = 1000; clock = () => now; _resetInterruptSeq(); });
  afterEach(() => { _resetInterruptSeq(); });

  it("handles interrupt: truncate → rollback → ack → LISTENING", async () => {
    const { sm, h, ctrl, rbFn } = setup(clock);
    const r = await h.handleInterrupt("user_spoke");
    expect(r).not.toBeNull(); expect(r!.withinBudget).toBe(true); expect(sm.state).toBe(DuplexState.LISTENING);
    expect(ctrl).toHaveLength(2); expect(ctrl[0]!.type).toBe("interrupt"); expect(ctrl[1]!.type).toBe("barge_in.ack");
    expect((ctrl[0] as InterruptMessage).reason).toBe("user_spoke");
    expect((ctrl[1] as BargeInAckMessage).contextRolledBackBytes).toBe(512);
    expect(rbFn).toHaveBeenCalledTimes(1);
  });

  it("handles interrupt from SIMULTANEOUS", async () => {
    const sm = new DuplexStateMachine({ now: clock }); const { ao } = mkAO(clock);
    sm.transition("duplex.session.start"); sm.transition("response.started"); ao.pushAudio(Buffer.alloc(3200), 100);
    sm.transition("user.speech.started"); expect(sm.state).toBe(DuplexState.SIMULTANEOUS);
    const h = new InterruptHandler({ stateMachine: sm, audioOutput: ao, rollbackContext: vi.fn().mockResolvedValue({ rolledBackBytes: 256, acknowledged: true }), sendControl: vi.fn(), now: clock });
    expect(await h.handleInterrupt("user_spoke")).not.toBeNull(); expect(sm.state).toBe(DuplexState.LISTENING);
  });

  it("debounces rapid interrupts", async () => {
    const { h, sm } = setup(clock);
    expect(await h.handleInterrupt("user_spoke")).not.toBeNull();
    sm.transition("response.started"); expect(await h.handleInterrupt("user_spoke")).toBeNull();
    now += 300; expect(await h.handleInterrupt("user_spoke")).not.toBeNull();
  });

  it("returns null when interrupt is not allowed from current state", async () => {
    const sm = new DuplexStateMachine({ now: clock }); const { ao } = mkAO(clock);
    const h = new InterruptHandler({ stateMachine: sm, audioOutput: ao, rollbackContext: vi.fn(), sendControl: vi.fn(), now: clock });
    expect(await h.handleInterrupt("user_spoke")).toBeNull();
  });

  it("returns null when session is in LISTENING state", async () => {
    const sm = new DuplexStateMachine({ now: clock }); const { ao } = mkAO(clock);
    sm.transition("duplex.session.start");
    const h = new InterruptHandler({ stateMachine: sm, audioOutput: ao, rollbackContext: vi.fn(), sendControl: vi.fn(), now: clock });
    expect(await h.handleInterrupt("user_spoke")).toBeNull();
  });

  it("handles rollback failure gracefully", async () => {
    const sm = new DuplexStateMachine({ now: clock }); const { ao } = mkAO(clock);
    sm.transition("duplex.session.start"); sm.transition("response.started"); ao.pushAudio(Buffer.alloc(3200), 100);
    const h = new InterruptHandler({ stateMachine: sm, audioOutput: ao, rollbackContext: vi.fn().mockRejectedValue(new Error("down")), sendControl: vi.fn(), now: clock });
    const r = await h.handleInterrupt("user_spoke");
    expect(r).not.toBeNull(); expect(sm.state).toBe(DuplexState.LISTENING); expect(r!.rollbackResult.acknowledged).toBe(false);
  });

  it("survives control message send failures", async () => {
    const sm = new DuplexStateMachine({ now: clock }); const { ao } = mkAO(clock);
    sm.transition("duplex.session.start"); sm.transition("response.started"); ao.pushAudio(Buffer.alloc(3200), 100);
    const h = new InterruptHandler({ stateMachine: sm, audioOutput: ao, rollbackContext: vi.fn().mockResolvedValue({ rolledBackBytes: 0, acknowledged: true }), sendControl: vi.fn(() => { throw new Error("fail"); }), now: clock });
    expect(await h.handleInterrupt("user_spoke")).not.toBeNull(); expect(sm.state).toBe(DuplexState.LISTENING);
  });

  it("reports within budget when fast", async () => {
    const { h } = setup(clock);
    const r = await h.handleInterrupt("user_spoke");
    expect(r!.totalLatencyMs).toBe(0); expect(r!.withinBudget).toBe(true);
  });

  it("reports budget breach when slow", async () => {
    let t = 1000; let c = 0;
    const sc = () => { c++; if (c > 5) t = 1300; return t; };
    const sm = new DuplexStateMachine({ now: sc }); const { ao } = mkAO(sc);
    sm.transition("duplex.session.start"); sm.transition("response.started"); ao.pushAudio(Buffer.alloc(3200), 100);
    const h = new InterruptHandler({ stateMachine: sm, audioOutput: ao, rollbackContext: vi.fn().mockResolvedValue({ rolledBackBytes: 0, acknowledged: true }), sendControl: vi.fn(), now: sc, debounceMs: 0 });
    const r = await h.handleInterrupt("user_spoke");
    expect(r).not.toBeNull(); expect(r!.totalLatencyMs).toBe(300); expect(r!.withinBudget).toBe(false); expect(h.stats.budgetBreaches).toBe(1);
  });

  it("tracks aggregate stats", async () => {
    const { h, sm } = setup(clock);
    await h.handleInterrupt("user_spoke"); expect(h.stats.interruptCount).toBe(1);
    sm.transition("response.started"); now += 300; await h.handleInterrupt("explicit"); expect(h.stats.interruptCount).toBe(2);
  });

  it("supports explicit interrupt reason", async () => {
    const { h, ctrl } = setup(clock); await h.handleInterrupt("explicit");
    expect((ctrl[0] as InterruptMessage).reason).toBe("explicit");
  });

  it("supports timeout interrupt reason", async () => {
    const { h, ctrl } = setup(clock); await h.handleInterrupt("timeout");
    expect((ctrl[0] as InterruptMessage).reason).toBe("timeout");
  });
});
