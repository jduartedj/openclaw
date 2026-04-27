import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { MixedModalityHandler } from "./mixed-modality-handler.js";
import { DuplexSession } from "./session.js";
import { DuplexState } from "./types.js";
import { AudioOutputStream } from "../audio/audio-output-stream.js";
import { _resetInterruptSeq } from "./interrupt-handler.js";

function mkHandler(opts?: {
  textInterruptsTts?: boolean; audioFallbackToText?: boolean;
  maxRecoveryItems?: number; modalitySwitchDebounceMs?: number;
}) {
  let now = 1000;
  const clock = () => now;
  const ctrl: unknown[] = [];
  const ao = new AudioOutputStream({ send: () => {}, now: clock });
  const rb = vi.fn().mockResolvedValue({ rolledBackBytes: 0, acknowledged: true });
  const session = new DuplexSession({
    sessionId: "mm-test", audioOutput: ao, sendControl: (m) => ctrl.push(m),
    rollbackContext: rb, now: clock, idleTimeoutMs: 600_000,
  });
  const onTextInput = vi.fn();
  const onTextOutput = vi.fn();
  const onModalitySwitch = vi.fn();
  const onAudioFallback = vi.fn();
  const onRecoveryAttempt = vi.fn();
  const handler = new MixedModalityHandler({
    session, audioOutput: ao,
    config: {
      textInterruptsTts: opts?.textInterruptsTts ?? true,
      audioFallbackToText: opts?.audioFallbackToText ?? true,
      maxRecoveryItems: opts?.maxRecoveryItems ?? 50,
      modalitySwitchDebounceMs: opts?.modalitySwitchDebounceMs ?? 0,
    },
    now: clock, onTextInput, onTextOutput, onModalitySwitch, onAudioFallback, onRecoveryAttempt,
  });
  return { handler, session, ao, ctrl, rb, onTextInput, onTextOutput, onModalitySwitch, onAudioFallback, onRecoveryAttempt, advance: (ms: number) => { now += ms; } };
}

describe("MixedModalityHandler", () => {
  beforeEach(() => { _resetInterruptSeq(); vi.useFakeTimers(); });
  afterEach(() => { _resetInterruptSeq(); vi.useRealTimers(); });

  it("processes text input in LISTENING", () => {
    const { handler, session, onTextInput } = mkHandler();
    session.start();
    const r = handler.handleTextInput({ type: "text.input", text: "Hello", timestamp: 2000, interruptTts: false });
    expect(r.processed).toBe(true);
    expect(r.interruptedAudio).toBe(false);
    expect(onTextInput).toHaveBeenCalledWith("Hello", false);
  });

  it("rejects text input in ENDED", () => {
    const { handler, session } = mkHandler();
    session.start(); session.end();
    expect(handler.handleTextInput({ type: "text.input", text: "Hello", timestamp: 2000, interruptTts: false }).processed).toBe(false);
  });

  it("switches input modality from audio to text", () => {
    const { handler, session, onModalitySwitch } = mkHandler();
    session.start();
    handler.handleTextInput({ type: "text.input", text: "Hello", timestamp: 2000, interruptTts: false });
    expect(handler.modalityState.inputModality).toBe("text");
    expect(onModalitySwitch).toHaveBeenCalledWith("audio", "text", "input");
  });

  it("adds text to conversation history", () => {
    const { handler, session } = mkHandler();
    session.start();
    handler.handleTextInput({ type: "text.input", text: "Hello", timestamp: 2000, interruptTts: false });
    expect(handler.conversationHistory.length).toBe(1);
    expect(handler.conversationHistory[0].content).toBe("Hello");
  });

  it("interrupts TTS during AGENT_SPEAKING", () => {
    const { handler, session, ao, advance } = mkHandler();
    session.start(); session.onResponseStarted();
    ao.pushAudio(Buffer.from([1, 2, 3, 4]), 100);
    handler.onAudioOutputStarted();
    advance(50);
    const r = handler.handleTextInput({ type: "text.input", text: "Stop!", timestamp: 1050, interruptTts: true });
    expect(r.interruptedAudio).toBe(true);
    expect(handler.stats.textInterruptCount).toBe(1);
  });

  it("does not interrupt when textInterruptsTts=false", () => {
    const { handler, session, ao, advance } = mkHandler({ textInterruptsTts: false });
    session.start(); session.onResponseStarted();
    ao.pushAudio(Buffer.from([1, 2, 3, 4]), 100);
    handler.onAudioOutputStarted();
    advance(50);
    expect(handler.handleTextInput({ type: "text.input", text: "Hello", timestamp: 1050, interruptTts: true }).interruptedAudio).toBe(false);
  });

  it("does not interrupt when interruptTts flag is false", () => {
    const { handler, session, ao, advance } = mkHandler();
    session.start(); session.onResponseStarted();
    ao.pushAudio(Buffer.from([1, 2, 3, 4]), 100);
    handler.onAudioOutputStarted();
    advance(50);
    expect(handler.handleTextInput({ type: "text.input", text: "Hello", timestamp: 1050, interruptTts: false }).interruptedAudio).toBe(false);
  });

  it("handles streaming text output", () => {
    const { handler, session, onTextOutput } = mkHandler();
    session.start();
    handler.handleTextOutput("Hello ", false);
    handler.handleTextOutput("world", true);
    expect(onTextOutput).toHaveBeenCalledTimes(2);
    expect(handler.conversationHistory.length).toBe(1);
    expect(handler.conversationHistory[0].content).toBe("Hello world");
  });

  it("sets textOutputActive during streaming", () => {
    const { handler, session } = mkHandler();
    session.start();
    handler.handleTextOutput("Hello ", false);
    expect(handler.modalityState.textOutputActive).toBe(true);
    handler.handleTextOutput("world", true);
    expect(handler.modalityState.textOutputActive).toBe(false);
  });

  it("switches output modality when text starts during audio", () => {
    const { handler, session } = mkHandler();
    session.start();
    handler.onAudioOutputStarted();
    handler.handleTextOutput("Hello", false);
    expect(handler.modalityState.outputModality).toBe("text+audio");
  });

  it("tracks audio output state", () => {
    const { handler, session } = mkHandler();
    session.start();
    handler.onAudioOutputStarted();
    expect(handler.modalityState.audioOutputActive).toBe(true);
    handler.onAudioOutputDone();
    expect(handler.modalityState.audioOutputActive).toBe(false);
  });

  it("resets textInterruptActive on audio done", () => {
    const { handler, session, ao, advance } = mkHandler();
    session.start(); session.onResponseStarted();
    ao.pushAudio(Buffer.from([1, 2, 3, 4]), 100);
    handler.onAudioOutputStarted();
    advance(50);
    handler.handleTextInput({ type: "text.input", text: "Stop!", timestamp: 1050, interruptTts: true });
    handler.onAudioOutputDone();
    expect(handler.modalityState.textInterruptActive).toBe(false);
  });

  it("falls back to text on audio failure", () => {
    const { handler, session, onAudioFallback } = mkHandler();
    session.start();
    expect(handler.handleAudioFailure("codec not supported").fellBack).toBe(true);
    expect(handler.modalityState.inputModality).toBe("text");
    expect(handler.modalityState.outputModality).toBe("text");
    expect(onAudioFallback).toHaveBeenCalledWith("codec not supported");
  });

  it("does not fall back when disabled", () => {
    const { handler, session } = mkHandler({ audioFallbackToText: false });
    session.start();
    expect(handler.handleAudioFailure("err").fellBack).toBe(false);
  });

  it("handles text+audio simultaneous (audio precedence)", () => {
    const { handler, session } = mkHandler();
    session.start();
    const r = handler.handleSimultaneousInput(
      { type: "text.input", text: "Hello", timestamp: 2000, interruptTts: false }, true,
    );
    expect(r.audioTakesPrecedence).toBe(true);
    expect(r.textQueued).toBe(true);
    expect(handler.modalityState.inputModality).toBe("text+audio");
  });

  it("handles text-only when no audio active", () => {
    const { handler, session } = mkHandler();
    session.start();
    const r = handler.handleSimultaneousInput(
      { type: "text.input", text: "Hello", timestamp: 2000, interruptTts: false }, false,
    );
    expect(r.audioTakesPrecedence).toBe(false);
  });

  it("debounces rapid switches", () => {
    const { handler, session, onModalitySwitch } = mkHandler({ modalitySwitchDebounceMs: 500 });
    session.start();
    handler.handleTextInput({ type: "text.input", text: "Hello", timestamp: 1000, interruptTts: false });
    handler.handleAudioFailure("test");
    expect(onModalitySwitch).toHaveBeenCalledTimes(1);
  });

  it("tracks switch count", () => {
    const { handler, session, advance } = mkHandler();
    session.start();
    handler.handleTextInput({ type: "text.input", text: "Hello", timestamp: 1000, interruptTts: false });
    advance(100);
    handler.handleAudioFailure("test");
    expect(handler.stats.switchCount).toBeGreaterThanOrEqual(2);
  });

  it("preserves history across modalities", () => {
    const { handler, session, advance } = mkHandler();
    session.start();
    handler.handleTextInput({ type: "text.input", text: "Hello", timestamp: 1000, interruptTts: false });
    handler.addAudioTranscript("assistant", "Hi there");
    advance(100);
    handler.handleTextInput({ type: "text.input", text: "How are you?", timestamp: 1100, interruptTts: false });
    expect(handler.conversationHistory.length).toBe(3);
    expect(handler.conversationHistory[1].modality).toBe("audio");
  });

  it("trims history exceeding max", () => {
    const { handler, session, advance } = mkHandler({ maxRecoveryItems: 3 });
    session.start();
    for (let i = 0; i < 5; i++) { advance(100); handler.handleTextInput({ type: "text.input", text: `msg${i}`, timestamp: 1000 + i * 100, interruptTts: false }); }
    expect(handler.conversationHistory.length).toBe(3);
    expect(handler.conversationHistory[0].content).toBe("msg2");
  });

  it("addAudioTranscript adds to history", () => {
    const { handler, session } = mkHandler();
    session.start();
    handler.addAudioTranscript("user", "test");
    expect(handler.conversationHistory[0].modality).toBe("audio");
  });

  it("creates checkpoint", () => {
    const { handler, session } = mkHandler();
    session.start();
    handler.handleTextInput({ type: "text.input", text: "Hello", timestamp: 1000, interruptTts: false });
    const cp = handler.createCheckpoint();
    expect(cp.sessionId).toBe("mm-test");
    expect(cp.conversationHistory.length).toBe(1);
  });

  it("recovers from checkpoint", () => {
    const { handler, session, onRecoveryAttempt } = mkHandler();
    session.start();
    handler.handleTextInput({ type: "text.input", text: "Hello", timestamp: 1000, interruptTts: false });
    const cp = handler.createCheckpoint();
    handler.resetModality();
    expect(handler.attemptRecovery(cp).recovered).toBe(true);
    expect(handler.conversationHistory.length).toBe(1);
    expect(onRecoveryAttempt).toHaveBeenCalled();
  });

  it("limits recovery attempts", () => {
    const { handler, session } = mkHandler();
    session.start();
    const cp = handler.createCheckpoint();
    handler.attemptRecovery(cp); handler.attemptRecovery(cp); handler.attemptRecovery(cp);
    expect(handler.attemptRecovery(cp).recovered).toBe(false);
  });

  it("resets active flags on recovery", () => {
    const { handler, session } = mkHandler();
    session.start();
    handler.onAudioOutputStarted();
    const cp = handler.createCheckpoint();
    handler.attemptRecovery(cp);
    expect(handler.modalityState.audioOutputActive).toBe(false);
  });

  it("resets to default modality state", () => {
    const { handler, session } = mkHandler();
    session.start();
    handler.handleTextInput({ type: "text.input", text: "Hello", timestamp: 1000, interruptTts: false });
    handler.resetModality();
    expect(handler.modalityState.inputModality).toBe("audio");
    expect(handler.modalityState.outputModality).toBe("audio");
  });

  it("preserves switch count across reset", () => {
    const { handler, session } = mkHandler();
    session.start();
    handler.handleTextInput({ type: "text.input", text: "Hello", timestamp: 1000, interruptTts: false });
    const count = handler.modalityState.switchCount;
    handler.resetModality();
    expect(handler.modalityState.switchCount).toBe(count);
  });

  it("reports comprehensive stats", () => {
    const { handler, session } = mkHandler();
    session.start();
    handler.handleTextInput({ type: "text.input", text: "Hello", timestamp: 1000, interruptTts: false });
    handler.handleTextOutput("Hi", true);
    expect(handler.stats.conversationItems).toBe(2);
    expect(handler.stats.events).toBeGreaterThan(0);
  });

  it("swallows onTextInput errors", () => {
    const { handler, session, onTextInput } = mkHandler();
    session.start();
    onTextInput.mockImplementation(() => { throw new Error("boom"); });
    expect(() => handler.handleTextInput({ type: "text.input", text: "Hello", timestamp: 1000, interruptTts: false })).not.toThrow();
  });

  it("swallows onTextOutput errors", () => {
    const { handler, session, onTextOutput } = mkHandler();
    session.start();
    onTextOutput.mockImplementation(() => { throw new Error("boom"); });
    expect(() => handler.handleTextOutput("test", true)).not.toThrow();
  });

  it("swallows onAudioFallback errors", () => {
    const { handler, session, onAudioFallback } = mkHandler();
    session.start();
    onAudioFallback.mockImplementation(() => { throw new Error("boom"); });
    expect(() => handler.handleAudioFailure("test")).not.toThrow();
  });
});
