import { describe, expect, it, vi, beforeEach } from "vitest";
import { DuplexStateMachine, DuplexStateMachineError } from "./state-machine.js";
import { DuplexState } from "./types.js";
import type { DuplexEvent, StateTransition } from "./types.js";

describe("DuplexStateMachine", () => {
  let sm: DuplexStateMachine;
  let now: number;
  let clock: () => number;

  beforeEach(() => { now = 1000; clock = () => now; sm = new DuplexStateMachine({ now: clock }); });

  it("starts in INIT state by default", () => { expect(sm.state).toBe(DuplexState.INIT); expect(sm.isTerminal).toBe(false); expect(sm.history).toHaveLength(0); });
  it("accepts custom initial state", () => { expect(new DuplexStateMachine({ initialState: DuplexState.LISTENING }).state).toBe(DuplexState.LISTENING); });

  it("transitions through a normal conversation cycle", () => {
    sm.transition("duplex.session.start"); expect(sm.state).toBe(DuplexState.LISTENING);
    sm.transition("user.speech.started"); expect(sm.state).toBe(DuplexState.LISTENING);
    sm.transition("user.speech.stopped"); expect(sm.state).toBe(DuplexState.LISTENING);
    sm.transition("response.started"); expect(sm.state).toBe(DuplexState.AGENT_SPEAKING);
    sm.transition("response.audio_done"); expect(sm.state).toBe(DuplexState.LISTENING);
    sm.transition("duplex.session.end"); expect(sm.state).toBe(DuplexState.ENDED); expect(sm.isTerminal).toBe(true);
  });

  it("handles interrupt from AGENT_SPEAKING", () => {
    sm.transition("duplex.session.start"); sm.transition("response.started");
    sm.transition("interrupt"); expect(sm.state).toBe(DuplexState.ROLLING_BACK);
    sm.transition("rollback.complete"); expect(sm.state).toBe(DuplexState.LISTENING);
  });

  it("handles interrupt from SIMULTANEOUS", () => {
    sm.transition("duplex.session.start"); sm.transition("response.started"); sm.transition("user.speech.started");
    expect(sm.state).toBe(DuplexState.SIMULTANEOUS);
    sm.transition("interrupt"); expect(sm.state).toBe(DuplexState.ROLLING_BACK);
    sm.transition("rollback.complete"); expect(sm.state).toBe(DuplexState.LISTENING);
  });

  it("transitions SIMULTANEOUS → AGENT_SPEAKING on user.speech.stopped", () => {
    sm.transition("duplex.session.start"); sm.transition("response.started"); sm.transition("user.speech.started");
    sm.transition("user.speech.stopped"); expect(sm.state).toBe(DuplexState.AGENT_SPEAKING);
  });

  it("transitions SIMULTANEOUS → LISTENING on response.audio_done", () => {
    sm.transition("duplex.session.start"); sm.transition("response.started"); sm.transition("user.speech.started");
    sm.transition("response.audio_done"); expect(sm.state).toBe(DuplexState.LISTENING);
  });

  it("supports pause from LISTENING", () => {
    sm.transition("duplex.session.start"); sm.transition("session.pause"); expect(sm.state).toBe(DuplexState.PAUSED);
    sm.transition("session.resume"); expect(sm.state).toBe(DuplexState.LISTENING);
  });

  it("supports pause from AGENT_SPEAKING", () => {
    sm.transition("duplex.session.start"); sm.transition("response.started");
    sm.transition("session.pause"); expect(sm.state).toBe(DuplexState.PAUSED);
  });

  it("transitions to ERROR from any non-terminal state", () => {
    const states: [DuplexEvent[], DuplexState][] = [
      [[], DuplexState.INIT], [["duplex.session.start"], DuplexState.LISTENING],
      [["duplex.session.start", "response.started"], DuplexState.AGENT_SPEAKING],
      [["duplex.session.start", "response.started", "interrupt"], DuplexState.ROLLING_BACK],
      [["duplex.session.start", "session.pause"], DuplexState.PAUSED],
    ];
    for (const [events, expected] of states) {
      const m = new DuplexStateMachine({ now: clock });
      for (const e of events) m.transition(e);
      expect(m.state).toBe(expected); m.transition("session.error");
      expect(m.state).toBe(DuplexState.ERROR); expect(m.isTerminal).toBe(true);
    }
  });

  it("throws TERMINAL_STATE from ENDED", () => {
    sm.transition("duplex.session.start"); sm.transition("duplex.session.end");
    expect(() => sm.transition("duplex.session.start")).toThrow(DuplexStateMachineError);
    try { sm.transition("duplex.session.start"); } catch (e: unknown) {
      expect((e as DuplexStateMachineError).code).toBe("TERMINAL_STATE");
    }
  });

  it("throws TERMINAL_STATE from ERROR", () => {
    sm.transition("session.error");
    expect(() => sm.transition("session.resume")).toThrow(DuplexStateMachineError);
  });

  it("throws INVALID_TRANSITION for illegal events", () => {
    expect(() => sm.transition("response.started")).toThrow(DuplexStateMachineError);
    try { sm.transition("response.started"); } catch (e: unknown) {
      expect((e as DuplexStateMachineError).code).toBe("INVALID_TRANSITION");
    }
  });

  it("rejects interrupt from LISTENING", () => {
    sm.transition("duplex.session.start");
    expect(() => sm.transition("interrupt")).toThrow(DuplexStateMachineError);
  });

  it("rejects user.speech.started from ROLLING_BACK", () => {
    sm.transition("duplex.session.start"); sm.transition("response.started"); sm.transition("interrupt");
    expect(() => sm.transition("user.speech.started")).toThrow(DuplexStateMachineError);
  });

  it("tryTransition returns null for invalid events", () => {
    expect(sm.tryTransition("response.started")).toBeNull();
    expect(sm.state).toBe(DuplexState.INIT);
  });

  it("tryTransition returns transition for valid events", () => {
    const t = sm.tryTransition("duplex.session.start");
    expect(t).not.toBeNull(); expect(t!.from).toBe(DuplexState.INIT); expect(t!.to).toBe(DuplexState.LISTENING);
  });

  it("canTransition returns true/false correctly", () => {
    expect(sm.canTransition("duplex.session.start")).toBe(true);
    expect(sm.canTransition("interrupt")).toBe(false);
  });

  it("allowedEvents returns correct set", () => {
    const a = sm.allowedEvents();
    expect(a.has("duplex.session.start")).toBe(true); expect(a.has("interrupt")).toBe(false);
  });

  it("records transition history", () => {
    sm.transition("duplex.session.start"); sm.transition("response.started");
    expect(sm.history).toHaveLength(2);
    expect(sm.history[0]!.from).toBe(DuplexState.INIT);
    expect(sm.history[1]!.to).toBe(DuplexState.AGENT_SPEAKING);
  });

  it("calls transition listeners", () => {
    const l = vi.fn(); sm.onTransition(l); sm.transition("duplex.session.start");
    expect(l).toHaveBeenCalledTimes(1);
    const t = l.mock.calls[0]![0] as StateTransition;
    expect(t.from).toBe(DuplexState.INIT); expect(t.to).toBe(DuplexState.LISTENING);
  });

  it("unsubscribe removes listener", () => {
    const l = vi.fn(); const u = sm.onTransition(l);
    sm.transition("duplex.session.start"); u();
    sm.transition("response.started"); expect(l).toHaveBeenCalledTimes(1);
  });

  it("listener errors do not poison the machine", () => {
    const bad = vi.fn(() => { throw new Error("boom"); }); const good = vi.fn();
    sm.onTransition(bad); sm.onTransition(good); sm.transition("duplex.session.start");
    expect(bad).toHaveBeenCalledTimes(1); expect(good).toHaveBeenCalledTimes(1);
    expect(sm.state).toBe(DuplexState.LISTENING);
  });

  it("uses injected clock for timestamps", () => {
    now = 5000; expect(sm.transition("duplex.session.start").meta.timestamp).toBe(5000);
  });

  it("allows custom meta overrides", () => {
    const t = sm.transition("duplex.session.start", { timestamp: 9999, reason: "test" });
    expect(t.meta.timestamp).toBe(9999); expect(t.meta.reason).toBe("test");
  });

  it("timeout transitions to ENDED from all non-terminal states", () => {
    const setups: [DuplexEvent[], DuplexState][] = [
      [[], DuplexState.INIT], [["duplex.session.start"], DuplexState.LISTENING],
      [["duplex.session.start", "response.started"], DuplexState.AGENT_SPEAKING],
      [["duplex.session.start", "response.started", "interrupt"], DuplexState.ROLLING_BACK],
      [["duplex.session.start", "session.pause"], DuplexState.PAUSED],
    ];
    for (const [events, expected] of setups) {
      const m = new DuplexStateMachine({ now: clock });
      for (const e of events) m.transition(e);
      expect(m.state).toBe(expected); m.transition("timeout"); expect(m.state).toBe(DuplexState.ENDED);
    }
  });

  it("duplex.session.end transitions to ENDED from SIMULTANEOUS", () => {
    sm.transition("duplex.session.start"); sm.transition("response.started"); sm.transition("user.speech.started");
    sm.transition("duplex.session.end"); expect(sm.state).toBe(DuplexState.ENDED);
  });
});
