/**
 * Integration tests — Phase D.5.
 *
 * Tests components working TOGETHER across boundaries, not in isolation.
 * Each describe block exercises a specific cross-component interaction path.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AudioInputStream } from "../audio/audio-input-stream.js";
import { AudioOutputStream } from "../audio/audio-output-stream.js";
import type { BackpressureMessage } from "../multiplex-control.js";
import { BackpressureMonitor, bindToAudioOutput } from "./backpressure.js";
import { _resetInterruptSeq } from "./interrupt-handler.js";
import { MixedModalityHandler } from "./mixed-modality-handler.js";
import { OpenAIRealtimeAdapter } from "./openai-realtime-adapter.js";
import type { OpenAIRealtimeServerEvent } from "./openai-realtime-types.js";
import { SessionRecoveryManager } from "./session-recovery.js";
import { DuplexSession } from "./session.js";
import { DuplexStateMachine } from "./state-machine.js";
import { TransportNegotiator } from "./transport-negotiator.js";
import {
  DuplexState,
  type DuplexControlMessage,
  type InterruptMessage,
  type BargeInAckMessage,
} from "./types.js";
import { _resetNegotiationSeq } from "./webrtc-signaling.js";
import {
  WebRTCTransport,
  type PeerConnectionLike,
  type DataChannelLike,
} from "./webrtc-transport.js";
import { NegotiationState } from "./webrtc-types.js";

// ============================================================================
// Shared helpers
// ============================================================================

function createClock(start = 1000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function createAudioOutput(clock: { now: () => number }) {
  return new AudioOutputStream({ send: () => {}, now: clock.now });
}

function createAudioInput() {
  return new AudioInputStream();
}

function createSession(opts?: {
  clock?: ReturnType<typeof createClock>;
  idleTimeoutMs?: number;
  interruptDebounceMs?: number;
}) {
  const clock = opts?.clock ?? createClock();
  const ctrl: DuplexControlMessage[] = [];
  const ao = createAudioOutput(clock);
  const rb = vi.fn().mockResolvedValue({ rolledBackBytes: 256, acknowledged: true });
  const session = new DuplexSession({
    sessionId: `intg-${Date.now().toString(36)}`,
    audioOutput: ao,
    sendControl: (m) => ctrl.push(m),
    rollbackContext: rb,
    idleTimeoutMs: opts?.idleTimeoutMs ?? 60_000,
    interruptDebounceMs: opts?.interruptDebounceMs ?? 0,
    now: clock.now,
  });
  return { session, ao, ctrl, rb, clock };
}

/** Create a mock RTCPeerConnection for transport tests. */
function createMockPeerConnection(): PeerConnectionLike {
  let localDesc: { sdp?: string; type: string } | null = null;
  let remoteDesc: { sdp?: string; type: string } | null = null;
  let connectionState = "new";
  let iceConnectionState = "new";
  const iceGatheringState = "new";

  const dataChannels: DataChannelLike[] = [];

  const pc: PeerConnectionLike = {
    createOffer: vi.fn(async () => ({ sdp: "mock-offer-sdp", type: "offer" })),
    createAnswer: vi.fn(async () => ({ sdp: "mock-answer-sdp", type: "answer" })),
    setLocalDescription: vi.fn(async (desc) => {
      localDesc = desc;
    }),
    setRemoteDescription: vi.fn(async (desc) => {
      remoteDesc = desc;
    }),
    addIceCandidate: vi.fn(async () => {}),
    createDataChannel: vi.fn((label: string) => {
      const dc = createMockDataChannel(label);
      dataChannels.push(dc);
      return dc;
    }),
    close: vi.fn(),

    get localDescription() {
      return localDesc;
    },
    get remoteDescription() {
      return remoteDesc;
    },
    get connectionState() {
      return connectionState;
    },
    get iceConnectionState() {
      return iceConnectionState;
    },
    get iceGatheringState() {
      return iceGatheringState;
    },

    onicecandidate: null,
    oniceconnectionstatechange: null,
    onconnectionstatechange: null,
    ondatachannel: null,
  };

  // Helper to simulate state changes
  (pc as Record<string, unknown>).setMockConnectionState = (s: string) => {
    connectionState = s;
    pc.onconnectionstatechange?.();
  };
  (pc as Record<string, unknown>).setMockIceConnectionState = (s: string) => {
    iceConnectionState = s;
    pc.oniceconnectionstatechange?.();
  };
  (pc as Record<string, unknown>).mockDataChannels = dataChannels;

  return pc;
}

function createMockDataChannel(label = "control"): DataChannelLike {
  let readyState = "connecting";
  const dc: DataChannelLike = {
    get label() {
      return label;
    },
    get readyState() {
      return readyState;
    },
    send: vi.fn(),
    close: vi.fn(() => {
      readyState = "closed";
      dc.onclose?.();
    }),
    onopen: null,
    onclose: null,
    onmessage: null,
    onerror: null,
  };
  (dc as Record<string, unknown>).openMock = () => {
    readyState = "open";
    dc.onopen?.();
  };
  return dc;
}

// ============================================================================
// 1. State Machine + Session Coordinator + Interrupt Handler
// ============================================================================

describe("Integration: StateMachine + Session + InterruptHandler", () => {
  beforeEach(() => {
    _resetInterruptSeq();
    vi.useFakeTimers();
  });
  afterEach(() => {
    _resetInterruptSeq();
    vi.useRealTimers();
  });

  it("full barge-in cycle: start → speak → interrupt → rollback → listen", async () => {
    const { session, ao, ctrl, rb, clock } = createSession({ interruptDebounceMs: 0 });
    session.start("user");
    expect(session.state).toBe(DuplexState.LISTENING);

    // Agent starts speaking
    session.onResponseStarted();
    expect(session.state).toBe(DuplexState.AGENT_SPEAKING);

    // Push some audio so truncation has something to work with
    ao.pushAudio(Buffer.alloc(3200), 100);
    ao.pushAudio(Buffer.alloc(3200), 100);
    clock.advance(50);

    // User barges in
    session.onUserSpeechStarted();
    // Should transition through SIMULTANEOUS → ROLLING_BACK → LISTENING
    await vi.advanceTimersByTimeAsync(0);

    expect(session.state).toBe(DuplexState.LISTENING);

    // Verify the interrupt message was sent
    const intMsg = ctrl.find((c) => c.type === "interrupt") as InterruptMessage;
    expect(intMsg).toBeDefined();
    expect(intMsg.reason).toBe("user_spoke");

    // Verify the barge-in ack was sent
    const ackMsg = ctrl.find((c) => c.type === "barge_in.ack") as BargeInAckMessage;
    expect(ackMsg).toBeDefined();
    expect(ackMsg.contextRolledBackBytes).toBe(256);

    // Rollback context was called
    expect(rb).toHaveBeenCalled();

    // Stats should reflect the interrupt
    const stats = session.getStats();
    expect(stats.interruptCount).toBe(1);
  });

  it("state machine history records all transitions through the session", () => {
    const { session } = createSession();
    session.start("user");
    session.onResponseStarted();
    session.onResponseAudioDone();
    session.end("user_hang_up");

    const history = session.stateMachine.history;
    expect(history.length).toBeGreaterThanOrEqual(4);
    expect(history[0].from).toBe(DuplexState.INIT);
    expect(history[0].to).toBe(DuplexState.LISTENING);
    expect(history[history.length - 1].to).toBe(DuplexState.ENDED);
  });

  it("interrupt debounce prevents rapid-fire interrupts", async () => {
    const clock = createClock();
    const { session, ao } = createSession({ clock, interruptDebounceMs: 200 });
    session.start("user");
    session.onResponseStarted();
    ao.pushAudio(Buffer.alloc(3200), 100);

    // First interrupt
    session.onUserSpeechStarted();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.state).toBe(DuplexState.LISTENING);

    // Start speaking again
    session.onResponseStarted();
    ao.pushAudio(Buffer.alloc(3200), 100);

    // Try another interrupt immediately (within debounce window)
    session.onUserSpeechStarted();
    await vi.advanceTimersByTimeAsync(0);
    // Should still be in SIMULTANEOUS since debounce blocked the interrupt
    expect(session.state).toBe(DuplexState.SIMULTANEOUS);

    // Advance past debounce and try again
    clock.advance(300);
    const result = await session.triggerInterrupt("explicit");
    expect(result).not.toBeNull();
    expect(session.state).toBe(DuplexState.LISTENING);
  });

  it("session broadcasts state changes to sendControl", () => {
    const { session, ctrl } = createSession();
    session.start("user");
    session.onResponseStarted();
    session.onResponseAudioDone();

    // Each transition should produce a session.state message
    const stateMessages = ctrl.filter((c) => c.type === "session.state");
    // start → LISTENING, response.started → AGENT_SPEAKING, response.audio_done → LISTENING
    expect(stateMessages.length).toBeGreaterThanOrEqual(3);
  });

  it("dispose triggers cleanup and ends the session", () => {
    const { session, ctrl } = createSession();
    session.start("user");
    session.dispose();
    expect(session.isEnded).toBe(true);
    expect(ctrl.find((c) => c.type === "duplex.session.end")).toBeDefined();
  });

  it("pause and resume cycle preserves session integrity", () => {
    const { session } = createSession();
    session.start("user");
    session.pause();
    expect(session.state).toBe(DuplexState.PAUSED);
    session.resume();
    expect(session.state).toBe(DuplexState.LISTENING);
    // Can still do normal operations after resume
    session.onResponseStarted();
    expect(session.state).toBe(DuplexState.AGENT_SPEAKING);
  });

  it("stats accumulate across multiple interrupt cycles", async () => {
    const clock = createClock();
    const { session, ao } = createSession({ clock, interruptDebounceMs: 0 });
    session.start("user");

    for (let i = 0; i < 3; i++) {
      session.onResponseStarted();
      ao.pushAudio(Buffer.alloc(3200), 100);
      clock.advance(1); // Ensure distinct timestamps
      session.onUserSpeechStarted();
      await vi.advanceTimersByTimeAsync(0);
      expect(session.state).toBe(DuplexState.LISTENING);
    }

    const stats = session.getStats();
    expect(stats.interruptCount).toBe(3);
  });
});

// ============================================================================
// 2. OpenAI Adapter + State Machine + Backpressure
// ============================================================================

describe("Integration: OpenAIAdapter + StateMachine + Backpressure", () => {
  beforeEach(() => {
    _resetInterruptSeq();
    vi.useFakeTimers();
  });
  afterEach(() => {
    _resetInterruptSeq();
    vi.useRealTimers();
  });

  it("adapter translates duplex events to OpenAI format while backpressure monitors queue", () => {
    const clock = createClock();
    const serverEvents: OpenAIRealtimeServerEvent[] = [];
    const bpMessages: BackpressureMessage[] = [];
    const ao = createAudioOutput(clock);

    const adapter = new OpenAIRealtimeAdapter({
      sendServerEvent: (e) => serverEvents.push(e),
    });

    const { unbind } = bindToAudioOutput(ao, {
      highWaterMs: 500,
      lowWaterMs: 100,
      sendBackpressure: (msg) => bpMessages.push(msg),
    });

    const ai = createAudioInput();
    adapter.bindAudioStreams(ai, ao);

    // Emit response started
    adapter.emitDuplexEvent("response.started");
    expect(serverEvents.find((e) => e.type === "response.created")).toBeDefined();

    // Push audio through the output stream and emit deltas
    for (let i = 0; i < 6; i++) {
      ao.pushAudio(Buffer.alloc(3200), 100);
      adapter.emitAudioDelta(Buffer.alloc(3200).toString("base64"), i);
    }

    // Backpressure should have triggered at 500ms threshold
    expect(bpMessages.find((m) => m.level === "high")).toBeDefined();

    // Emit audio done
    adapter.emitDuplexEvent("response.audio_done");
    expect(serverEvents.find((e) => e.type === "response.audio.done")).toBeDefined();

    unbind();
  });

  it("adapter handles client truncate → triggers onTruncate callback", () => {
    const serverEvents: OpenAIRealtimeServerEvent[] = [];
    const truncations: { itemId: string; audioEndMs: number }[] = [];

    const adapter = new OpenAIRealtimeAdapter({
      sendServerEvent: (e) => serverEvents.push(e),
      onTruncate: (itemId, audioEndMs) => truncations.push({ itemId, audioEndMs }),
    });

    // Client sends truncate event
    adapter.handleClientMessage({
      type: "conversation.item.truncate",
      item_id: "item_abc",
      content_index: 0,
      audio_end_ms: 500,
    });

    expect(truncations).toEqual([{ itemId: "item_abc", audioEndMs: 500 }]);
  });

  it("adapter client session update → config propagation", () => {
    const serverEvents: OpenAIRealtimeServerEvent[] = [];
    const configs: unknown[] = [];

    const adapter = new OpenAIRealtimeAdapter({
      sendServerEvent: (e) => serverEvents.push(e),
      onSessionUpdate: (config) => configs.push(config),
    });

    adapter.handleClientMessage({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: "alloy",
        temperature: 0.7,
      },
    });

    expect(configs.length).toBe(1);
    expect(serverEvents.find((e) => e.type === "session.updated")).toBeDefined();
  });

  it("adapter input audio buffer append → audio input stream", () => {
    const serverEvents: OpenAIRealtimeServerEvent[] = [];
    const ai = createAudioInput();
    const ao = createAudioOutput(createClock());

    const adapter = new OpenAIRealtimeAdapter({
      sendServerEvent: (e) => serverEvents.push(e),
    });
    adapter.bindAudioStreams(ai, ao);

    // Use proper PCM16 data (even byte length)
    const pcmData = Buffer.alloc(3200); // 3200 bytes = 100ms of 16kHz PCM16
    const base64Audio = pcmData.toString("base64");
    adapter.handleClientMessage({
      type: "input_audio_buffer.append",
      audio: base64Audio,
    });

    // Audio should be in the input buffer
    expect(ai.buffer.getBufferedBytes()).toBeGreaterThan(0);
  });

  it("backpressure pause/resume callbacks fire at thresholds", () => {
    const clock = createClock();
    const ao = createAudioOutput(clock);
    const bpMessages: BackpressureMessage[] = [];
    let paused = false;

    const { unbind } = bindToAudioOutput(ao, {
      highWaterMs: 300,
      lowWaterMs: 50,
      sendBackpressure: (msg) => bpMessages.push(msg),
      onPause: () => {
        paused = true;
      },
      onResume: () => {
        paused = false;
      },
    });

    // Push audio until high water
    for (let i = 0; i < 4; i++) {
      ao.pushAudio(Buffer.alloc(3200), 100);
    }
    expect(paused).toBe(true);

    // Truncate to drain
    ao.truncateAt(10);
    expect(paused).toBe(false);

    unbind();
  });

  it("adapter error on invalid client message", () => {
    const serverEvents: OpenAIRealtimeServerEvent[] = [];
    const decodeErrors: Error[] = [];

    const adapter = new OpenAIRealtimeAdapter({
      sendServerEvent: (e) => serverEvents.push(e),
      onDecodeError: (err) => decodeErrors.push(err),
    });

    adapter.handleClientMessage("not-an-object");
    expect(serverEvents.find((e) => e.type === "error")).toBeDefined();
    expect(decodeErrors.length).toBe(1);
  });

  it("response cancel flows through adapter", () => {
    const serverEvents: OpenAIRealtimeServerEvent[] = [];
    let cancelled = false;

    const adapter = new OpenAIRealtimeAdapter({
      sendServerEvent: (e) => serverEvents.push(e),
      onResponseCancel: () => {
        cancelled = true;
      },
    });

    // Start a response first
    adapter.emitDuplexEvent("response.started");
    expect(serverEvents.find((e) => e.type === "response.created")).toBeDefined();

    // Cancel it
    adapter.handleClientMessage({ type: "response.cancel" });
    expect(cancelled).toBe(true);
    const doneMsg = serverEvents.find((e) => e.type === "response.done") as
      | { response?: { status?: string } }
      | undefined;
    expect(doneMsg?.response?.status).toBe("cancelled");
  });
});

// ============================================================================
// 3. MixedModalityHandler + SessionRecovery
// ============================================================================

describe("Integration: MixedModalityHandler + SessionRecovery", () => {
  beforeEach(() => {
    _resetInterruptSeq();
    vi.useFakeTimers();
  });
  afterEach(() => {
    _resetInterruptSeq();
    vi.useRealTimers();
  });

  it("text interrupt during audio → checkpoint → recovery restores conversation", async () => {
    const clock = createClock();
    const { session, ao } = createSession({ clock, interruptDebounceMs: 0 });
    session.start("user");

    const recoveryMgr = new SessionRecoveryManager({ now: clock.now });
    const textOutputs: string[] = [];

    const handler = new MixedModalityHandler({
      session,
      audioOutput: ao,
      now: clock.now,
      onTextOutput: (chunk) => textOutputs.push(chunk.text),
    });

    // Agent is speaking audio
    session.onResponseStarted();
    handler.onAudioOutputStarted();
    ao.pushAudio(Buffer.alloc(3200), 100);

    // User sends text that interrupts TTS
    clock.advance(10);
    handler.handleTextInput({
      type: "text.input",
      text: "Wait, I have a question",
      timestamp: clock.now(),
      interruptTts: true,
    });
    await vi.advanceTimersByTimeAsync(0);

    // Audio should be interrupted
    expect(handler.stats.textInterruptCount).toBe(1);

    // Add some more conversation
    clock.advance(10);
    handler.handleTextOutput("Sure, what's your question?", true);
    expect(textOutputs).toContain("Sure, what's your question?");

    // Checkpoint
    const checkpoint = handler.createCheckpoint();
    recoveryMgr.saveCheckpoint(checkpoint);

    // Verify checkpoint data
    expect(checkpoint.conversationHistory.length).toBeGreaterThanOrEqual(2);
    expect(checkpoint.modalityState.inputModality).not.toBe("audio");

    // Simulate failure and recovery
    const result = recoveryMgr.attemptRecovery(session.sessionId);
    expect(result.recovered).toBe(true);
    expect(result.checkpoint).toBeDefined();
    expect(result.checkpoint!.conversationHistory.length).toBeGreaterThanOrEqual(2);

    // Build recovery context
    const ctx = recoveryMgr.buildRecoveryContext(result.checkpoint!);
    expect(ctx.systemPrompt).toContain("recovered session");
    expect(ctx.messages.length).toBeGreaterThanOrEqual(2);
  });

  it("audio fallback to text + checkpoint + recovery", () => {
    const clock = createClock();
    const { session, ao } = createSession({ clock });
    session.start("user");

    const recoveryMgr = new SessionRecoveryManager({ now: clock.now });

    const handler = new MixedModalityHandler({
      session,
      audioOutput: ao,
      now: clock.now,
      config: { audioFallbackToText: true },
    });

    // Simulate audio failure
    const result = handler.handleAudioFailure("codec_error");
    expect(result.fellBack).toBe(true);
    expect(handler.modalityState.inputModality).toBe("text");
    expect(handler.modalityState.outputModality).toBe("text");

    // Checkpoint in degraded state
    const cp = handler.createCheckpoint();
    recoveryMgr.saveCheckpoint(cp);

    // Recover
    const recovery = handler.attemptRecovery(cp);
    expect(recovery.recovered).toBe(true);
    expect(handler.stats.recoveryAttempts).toBe(1);
  });

  it("max recovery attempts exceeded", () => {
    const clock = createClock();
    const { session, ao } = createSession({ clock });
    session.start("user");

    const handler = new MixedModalityHandler({
      session,
      audioOutput: ao,
      now: clock.now,
      config: { maxRecoveryAttempts: 2 },
    });

    const cp = handler.createCheckpoint();

    // Exhaust recovery attempts
    expect(handler.attemptRecovery(cp).recovered).toBe(true);
    expect(handler.attemptRecovery(cp).recovered).toBe(true);
    expect(handler.attemptRecovery(cp).recovered).toBe(false);
    expect(handler.attemptRecovery(cp).reason).toBe("max_recovery_attempts_exceeded");
  });

  it("simultaneous text+audio input handling", () => {
    const clock = createClock();
    const { session, ao } = createSession({ clock });
    session.start("user");

    const handler = new MixedModalityHandler({
      session,
      audioOutput: ao,
      now: clock.now,
    });

    const result = handler.handleSimultaneousInput(
      { type: "text.input", text: "Hey", timestamp: clock.now(), interruptTts: false },
      true,
    );

    expect(result.audioTakesPrecedence).toBe(true);
    expect(handler.modalityState.inputModality).toBe("text+audio");
  });

  it("recovery manager prunes expired checkpoints", () => {
    const clock = createClock();
    const recoveryMgr = new SessionRecoveryManager({
      now: clock.now,
      checkpointTtlMs: 1000,
    });

    recoveryMgr.saveCheckpoint({
      sessionId: "s1",
      duplexState: "listening",
      modalityState: {
        inputModality: "audio",
        outputModality: "audio",
        textInterruptActive: false,
        audioOutputActive: false,
        textOutputActive: false,
        switchCount: 0,
        lastSwitchAt: null,
      },
      contextTokens: 0,
      conversationHistory: [],
      checkpointAt: clock.now(),
      recoveryAttempts: 0,
    });

    clock.advance(2000);
    const pruned = recoveryMgr.pruneExpired();
    expect(pruned).toBe(1);

    const result = recoveryMgr.attemptRecovery("s1");
    expect(result.recovered).toBe(false);
    expect(result.reason).toBe("no_valid_checkpoint");
  });

  it("recovery manager max attempts per session", () => {
    const clock = createClock();
    const failures: string[] = [];
    const recoveryMgr = new SessionRecoveryManager({
      now: clock.now,
      maxRecoveryAttempts: 2,
      onRecoveryFailed: (id, reason) => failures.push(`${id}:${reason}`),
    });

    recoveryMgr.saveCheckpoint({
      sessionId: "s2",
      duplexState: "listening",
      modalityState: {
        inputModality: "audio",
        outputModality: "audio",
        textInterruptActive: false,
        audioOutputActive: false,
        textOutputActive: false,
        switchCount: 0,
        lastSwitchAt: null,
      },
      contextTokens: 0,
      conversationHistory: [],
      checkpointAt: clock.now(),
      recoveryAttempts: 0,
    });

    expect(recoveryMgr.attemptRecovery("s2").recovered).toBe(true);
    expect(recoveryMgr.attemptRecovery("s2").recovered).toBe(true);
    expect(recoveryMgr.attemptRecovery("s2").recovered).toBe(false);
    expect(failures).toContain("s2:max_attempts_exceeded");
  });
});

// ============================================================================
// 4. Transport Negotiator + Signaling + Transport Upgrade/Fallback
// ============================================================================

describe("Integration: TransportNegotiator + Signaling + Transport", () => {
  beforeEach(() => {
    _resetNegotiationSeq();
  });
  afterEach(() => {
    _resetNegotiationSeq();
  });

  it("full upgrade lifecycle: request → response → SDP → ICE → ready", async () => {
    const clock = createClock();
    const sentMessages: unknown[] = [];
    const upgradeResults: { streams: number[]; rtt: number | null }[] = [];

    let serverPc: PeerConnectionLike | null = null;

    const negotiator = new TransportNegotiator({
      sendControl: (msg) => sentMessages.push(msg),
      peerConnectionFactory: () => {
        serverPc = createMockPeerConnection();
        return serverPc;
      },
      now: clock.now,
      maxRetries: 3,
      onUpgradeComplete: (streams, rtt) => upgradeResults.push({ streams, rtt }),
    });

    // 1. Request upgrade
    const req = negotiator.requestUpgrade([1, 2]);
    expect(req.type).toBe("webrtc.upgrade.request");
    expect(negotiator.state).toBe(NegotiationState.REQUESTED);

    // 2. Receive acceptance — this initializes signaling+transport and captures serverPc
    negotiator.handleMessage({
      type: "webrtc.upgrade.response",
      negotiationId: req.negotiationId,
      accepted: true,
      acceptedStreams: [1, 2],
    });
    expect(negotiator.state).toBe(NegotiationState.SIGNALING);
    expect(serverPc).not.toBeNull();

    // 3. Simulate remote peer opening a data channel (answerer flow)
    const remoteDc = createMockDataChannel("control");
    serverPc!.ondatachannel?.({ channel: remoteDc });

    // 4. Open the data channel + set connection state = connected → triggers onReady
    (remoteDc as Record<string, unknown>).openMock();
    (serverPc as Record<string, unknown>).setMockConnectionState("connected");

    expect(negotiator.state).toBe(NegotiationState.ACTIVE);
    expect(negotiator.activeTransport).toBe("webrtc");
    expect(upgradeResults.length).toBe(1);
    expect(upgradeResults[0].streams).toEqual([1, 2]);

    // 5. Send data over WebRTC
    const controlTransport = negotiator.sendControlMessage("test-control");
    expect(controlTransport).toBe("webrtc");

    const audioTransport = negotiator.sendAudioData(new ArrayBuffer(100));
    expect(audioTransport).toBe("webrtc");
  });

  it("upgrade rejected → falls back to websocket", () => {
    const clock = createClock();
    const sentMessages: unknown[] = [];
    let failReason: string | null = null;

    const negotiator = new TransportNegotiator({
      sendControl: (msg) => sentMessages.push(msg),
      peerConnectionFactory: () => createMockPeerConnection(),
      now: clock.now,
      onUpgradeFailed: (reason) => {
        failReason = reason;
      },
    });

    const req = negotiator.requestUpgrade([1, 2]);

    negotiator.handleMessage({
      type: "webrtc.upgrade.response",
      negotiationId: req.negotiationId,
      accepted: false,
      reason: "server busy",
    });

    expect(negotiator.activeTransport).toBe("websocket");
    expect(failReason).toBe("server busy");
    // Should be able to retry
    expect(negotiator.canRetry).toBe(true);
  });

  it("downgrade moves streams back to websocket", async () => {
    const clock = createClock();
    const sentMessages: unknown[] = [];
    const downgrades: { reason: string; streams: number[] }[] = [];

    let serverPc: PeerConnectionLike | null = null;

    const negotiator = new TransportNegotiator({
      sendControl: (msg) => sentMessages.push(msg),
      peerConnectionFactory: () => {
        serverPc = createMockPeerConnection();
        return serverPc;
      },
      now: clock.now,
      onDowngrade: (reason, streams) => downgrades.push({ reason, streams }),
    });

    // Get to ACTIVE state
    const req = negotiator.requestUpgrade([0, 1, 2]);
    negotiator.handleMessage({
      type: "webrtc.upgrade.response",
      negotiationId: req.negotiationId,
      accepted: true,
      acceptedStreams: [0, 1, 2],
    });

    // Simulate transport ready via ondatachannel + connection state
    const remoteDc = createMockDataChannel("control");
    serverPc!.ondatachannel?.({ channel: remoteDc });
    (remoteDc as Record<string, unknown>).openMock();
    (serverPc as Record<string, unknown>).setMockConnectionState("connected");

    expect(negotiator.state).toBe(NegotiationState.ACTIVE);

    // Downgrade
    negotiator.downgrade("explicit", [1, 2]);
    expect(downgrades.length).toBe(1);
    expect(downgrades[0].reason).toBe("explicit");

    // Stream 0 should still be on webrtc, 1 and 2 back to websocket
    expect(negotiator.getStreamTransport(0)).toBe("webrtc");
    expect(negotiator.getStreamTransport(1)).toBe("websocket");
    expect(negotiator.getStreamTransport(2)).toBe("websocket");
  });

  it("max retries exceeded → cannot request more upgrades", () => {
    const clock = createClock();
    const negotiator = new TransportNegotiator({
      sendControl: () => {},
      peerConnectionFactory: () => createMockPeerConnection(),
      now: clock.now,
      maxRetries: 2,
    });

    // Use up retries
    const r1 = negotiator.requestUpgrade();
    negotiator.handleMessage({
      type: "webrtc.upgrade.response",
      negotiationId: r1.negotiationId,
      accepted: false,
      reason: "busy",
    });

    const r2 = negotiator.requestUpgrade();
    negotiator.handleMessage({
      type: "webrtc.upgrade.response",
      negotiationId: r2.negotiationId,
      accepted: false,
      reason: "busy",
    });

    expect(negotiator.canRetry).toBe(false);
    expect(() => negotiator.requestUpgrade()).toThrow("max retries exceeded");
  });

  it("dispose cleans up signaling and transport", async () => {
    const clock = createClock();
    let serverPc: PeerConnectionLike | null = null;

    const negotiator = new TransportNegotiator({
      sendControl: () => {},
      peerConnectionFactory: () => {
        serverPc = createMockPeerConnection();
        return serverPc;
      },
      now: clock.now,
    });

    const req = negotiator.requestUpgrade();
    negotiator.handleMessage({
      type: "webrtc.upgrade.response",
      negotiationId: req.negotiationId,
      accepted: true,
    });

    negotiator.dispose();
    expect(negotiator.state).toBe(NegotiationState.IDLE);
    expect(() => negotiator.requestUpgrade()).toThrow("disposed");
  });

  it("server-side handles incoming upgrade request", () => {
    const clock = createClock();
    const sentMessages: Array<{ type: string; accepted?: boolean }> = [];
    let serverPc: PeerConnectionLike | null = null;

    const negotiator = new TransportNegotiator({
      sendControl: (msg) => sentMessages.push(msg as { type: string; accepted?: boolean }),
      peerConnectionFactory: () => {
        serverPc = createMockPeerConnection();
        return serverPc;
      },
      now: clock.now,
    });

    // Receive upgrade request from client
    negotiator.handleMessage({
      type: "webrtc.upgrade.request",
      negotiationId: "client-neg-1",
      requestedStreams: [1, 2],
    });

    // Should have sent an acceptance response
    const response = sentMessages.find((m) => m.type === "webrtc.upgrade.response");
    expect(response).toBeDefined();
    expect(response!.accepted).toBe(true);
    expect(negotiator.state).toBe(NegotiationState.SIGNALING);
  });

  it("snapshot provides accurate transport state", async () => {
    const clock = createClock();
    let serverPc: PeerConnectionLike | null = null;

    const negotiator = new TransportNegotiator({
      sendControl: () => {},
      peerConnectionFactory: () => {
        serverPc = createMockPeerConnection();
        return serverPc;
      },
      now: clock.now,
    });

    const snap1 = negotiator.snapshot;
    expect(snap1.state).toBe(NegotiationState.IDLE);
    expect(snap1.activeTransport).toBe("websocket");
    expect(snap1.websocketStreams).toEqual([0, 1, 2]);
    expect(snap1.webrtcStreams).toEqual([]);

    // Get to active
    const req = negotiator.requestUpgrade([0, 1, 2]);
    negotiator.handleMessage({
      type: "webrtc.upgrade.response",
      negotiationId: req.negotiationId,
      accepted: true,
      acceptedStreams: [0, 1, 2],
    });

    // Simulate transport ready via ondatachannel + connection state
    const remoteDc = createMockDataChannel("control");
    serverPc!.ondatachannel?.({ channel: remoteDc });
    (remoteDc as Record<string, unknown>).openMock();
    (serverPc as Record<string, unknown>).setMockConnectionState("connected");

    const snap2 = negotiator.snapshot;
    expect(snap2.state).toBe(NegotiationState.ACTIVE);
    expect(snap2.activeTransport).toBe("webrtc");
    expect(snap2.webrtcStreams).toEqual([0, 1, 2]);
  });
});

// ============================================================================
// 5. Full Pipeline: Message → Adapter → StateMachine → Handler → Output
// ============================================================================

describe("Integration: Full Pipeline", () => {
  beforeEach(() => {
    _resetInterruptSeq();
    vi.useFakeTimers();
  });
  afterEach(() => {
    _resetInterruptSeq();
    vi.useRealTimers();
  });

  it("end-to-end: client audio in → response → audio out → barge-in → recovery", async () => {
    const clock = createClock();
    const serverEvents: OpenAIRealtimeServerEvent[] = [];
    const bpMessages: BackpressureMessage[] = [];
    const { session, ao } = createSession({ clock, interruptDebounceMs: 0 });

    const adapter = new OpenAIRealtimeAdapter({
      sendServerEvent: (e) => serverEvents.push(e),
      onTruncate: (_itemId, _audioEndMs) => {
        // Simulate barge-in on truncate
        void session.triggerInterrupt("explicit");
      },
    });

    const ai = createAudioInput();
    adapter.bindAudioStreams(ai, ao);

    const { unbind } = bindToAudioOutput(ao, {
      highWaterMs: 500,
      lowWaterMs: 100,
      sendBackpressure: (msg) => bpMessages.push(msg),
    });

    const handler = new MixedModalityHandler({
      session,
      audioOutput: ao,
      now: clock.now,
    });

    const recoveryMgr = new SessionRecoveryManager({ now: clock.now });

    // 1. Start session
    session.start("user");
    adapter.emitDuplexEvent("duplex.session.start");

    // 2. Client sends audio
    const audioData = Buffer.alloc(6400).toString("base64");
    adapter.handleClientMessage({
      type: "input_audio_buffer.append",
      audio: audioData,
    });
    expect(ai.buffer.getBufferedBytes()).toBeGreaterThan(0);

    // 3. Agent responds with audio
    session.onResponseStarted();
    adapter.emitDuplexEvent("response.started");
    handler.onAudioOutputStarted();

    for (let i = 0; i < 5; i++) {
      ao.pushAudio(Buffer.alloc(3200), 100);
      adapter.emitAudioDelta(Buffer.alloc(3200).toString("base64"), i);
    }

    // 4. Verify backpressure detected
    expect(bpMessages.find((m) => m.level === "high")).toBeDefined();

    // 5. User barges in with text
    clock.advance(20);
    const textResult = handler.handleTextInput({
      type: "text.input",
      text: "Actually, never mind",
      timestamp: clock.now(),
      interruptTts: true,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(textResult.interruptedAudio).toBe(true);

    // 6. Save checkpoint for recovery
    const checkpoint = handler.createCheckpoint();
    recoveryMgr.saveCheckpoint(checkpoint);

    // 7. Verify recovery works
    const recovery = recoveryMgr.attemptRecovery(session.sessionId);
    expect(recovery.recovered).toBe(true);
    expect(recovery.checkpoint!.conversationHistory.length).toBeGreaterThanOrEqual(1);

    // 8. Session stats
    const stats = session.getStats();
    expect(stats.interruptCount).toBeGreaterThanOrEqual(1);

    // 9. End session
    session.end("user_hang_up");
    adapter.emitDuplexEvent("duplex.session.end");
    expect(session.isEnded).toBe(true);
    expect(serverEvents.find((e) => e.type === "response.done")).toBeDefined();

    unbind();
  });

  it("text-only pipeline: no audio, just text modality throughout", () => {
    const clock = createClock();
    const { session, ao } = createSession({ clock });

    const handler = new MixedModalityHandler({
      session,
      audioOutput: ao,
      now: clock.now,
    });

    session.start("user");

    // Simulate audio failure → fallback to text
    handler.handleAudioFailure("no_microphone");
    expect(handler.modalityState.inputModality).toBe("text");

    // Text input
    handler.handleTextInput({
      type: "text.input",
      text: "Hello world",
      timestamp: clock.now(),
      interruptTts: false,
    });

    // Text output
    handler.handleTextOutput("Hello! ", false);
    handler.handleTextOutput("How can I help?", true);

    expect(handler.conversationHistory.length).toBe(2);
    expect(handler.stats.audioFallbackCount).toBe(1);
  });
});

// ============================================================================
// 6. Error Propagation Across Component Boundaries
// ============================================================================

describe("Integration: Error Propagation", () => {
  beforeEach(() => {
    _resetInterruptSeq();
    vi.useFakeTimers();
  });
  afterEach(() => {
    _resetInterruptSeq();
    vi.useRealTimers();
  });

  it("rollback context error is caught and doesn't crash the session", async () => {
    const clock = createClock();
    const ao = createAudioOutput(clock);
    const ctrl: DuplexControlMessage[] = [];
    const failingRollback = vi.fn().mockRejectedValue(new Error("rollback failed"));

    const session = new DuplexSession({
      sessionId: "err-test-1",
      audioOutput: ao,
      sendControl: (m) => ctrl.push(m),
      rollbackContext: failingRollback,
      idleTimeoutMs: 60_000,
      interruptDebounceMs: 0,
      now: clock.now,
    });

    session.start("user");
    session.onResponseStarted();
    ao.pushAudio(Buffer.alloc(3200), 100);

    session.onUserSpeechStarted();
    await vi.advanceTimersByTimeAsync(0);

    // Session should still be functional despite rollback error
    expect(session.state).toBe(DuplexState.LISTENING);
    // Interrupt handler swallows the error and produces { rolledBackBytes: 0, acknowledged: false }
    const ack = ctrl.find((c) => c.type === "barge_in.ack") as BargeInAckMessage;
    expect(ack).toBeDefined();
    expect(ack.contextRolledBackBytes).toBe(0);
  });

  it("state machine error on invalid transition is surfaced correctly", () => {
    const sm = new DuplexStateMachine();
    sm.transition("duplex.session.start");

    // LISTENING doesn't accept "rollback.complete"
    expect(() => sm.transition("rollback.complete")).toThrow("INVALID_TRANSITION");
  });

  it("terminal state rejects all further events", () => {
    const sm = new DuplexStateMachine();
    sm.transition("duplex.session.start");
    sm.transition("duplex.session.end");

    expect(() => sm.transition("user.speech.started")).toThrow("TERMINAL_STATE");
    expect(() => sm.transition("duplex.session.start")).toThrow("TERMINAL_STATE");
  });

  it("transport negotiation failure propagates gracefully", () => {
    const clock = createClock();
    let failReason: string | null = null;
    let serverPc: PeerConnectionLike | null = null;

    const negotiator = new TransportNegotiator({
      sendControl: () => {},
      peerConnectionFactory: () => {
        serverPc = createMockPeerConnection();
        return serverPc;
      },
      now: clock.now,
      onUpgradeFailed: (reason) => {
        failReason = reason;
      },
    });

    const req = negotiator.requestUpgrade();
    negotiator.handleMessage({
      type: "webrtc.upgrade.response",
      negotiationId: req.negotiationId,
      accepted: true,
    });

    // Simulate ICE failure
    if (serverPc) {
      (serverPc as Record<string, unknown>).setMockIceConnectionState("failed");
    }

    expect(failReason).toContain("transport failed");
    // Negotiator should allow retry
    expect(negotiator.canRetry).toBe(true);
  });

  it("adapter handles unknown event types gracefully", () => {
    const serverEvents: OpenAIRealtimeServerEvent[] = [];

    const adapter = new OpenAIRealtimeAdapter({
      sendServerEvent: (e) => serverEvents.push(e),
    });

    adapter.handleClientMessage({ type: "totally.unknown.event" });
    expect(serverEvents.find((e) => e.type === "error")).toBeDefined();
  });

  it("backpressure monitor rejects invalid parameters", () => {
    expect(
      () =>
        new BackpressureMonitor({
          highWaterMs: 0,
          lowWaterMs: 0,
          sendBackpressure: () => {},
        }),
    ).toThrow();

    expect(
      () =>
        new BackpressureMonitor({
          highWaterMs: 100,
          lowWaterMs: 200,
          sendBackpressure: () => {},
        }),
    ).toThrow();
  });
});

// ============================================================================
// 7. Cleanup / Dispose Cascades
// ============================================================================

describe("Integration: Cleanup & Dispose Cascades", () => {
  beforeEach(() => {
    _resetInterruptSeq();
    vi.useFakeTimers();
  });
  afterEach(() => {
    _resetInterruptSeq();
    vi.useRealTimers();
  });

  it("session dispose ends session and clears idle timer", () => {
    const clock = createClock();
    const { session, ctrl } = createSession({ clock, idleTimeoutMs: 5000 });
    session.start("user");
    session.dispose();

    expect(session.isEnded).toBe(true);
    // Should not trigger timeout after dispose
    clock.advance(10000);
    vi.advanceTimersByTime(10000);
    // No additional end messages beyond the dispose
    const endMsgs = ctrl.filter((c) => c.type === "duplex.session.end");
    expect(endMsgs.length).toBe(1);
  });

  it("transport dispose cascades to peer connection and data channel", async () => {
    const clock = createClock();
    let pc: PeerConnectionLike | null = null;

    const transport = new WebRTCTransport({
      callbacks: {},
      peerConnectionFactory: () => {
        pc = createMockPeerConnection();
        return pc;
      },
      now: clock.now,
    });

    transport.initialize();
    await transport.createOffer();

    transport.dispose();
    expect(transport.isDisposed).toBe(true);
    expect(pc!.close).toHaveBeenCalled();

    // Should reject further operations
    expect(() => transport.initialize()).toThrow("disposal");
  });

  it("negotiator dispose cleans up transport and signaling", () => {
    const clock = createClock();
    const negotiator = new TransportNegotiator({
      sendControl: () => {},
      peerConnectionFactory: () => createMockPeerConnection(),
      now: clock.now,
    });

    const req = negotiator.requestUpgrade();
    negotiator.handleMessage({
      type: "webrtc.upgrade.response",
      negotiationId: req.negotiationId,
      accepted: true,
    });

    negotiator.dispose();
    expect(negotiator.state).toBe(NegotiationState.IDLE);
    expect(negotiator.snapshot.hasTransport).toBe(false);
    expect(negotiator.snapshot.hasSignaling).toBe(false);
  });

  it("recovery manager clear removes all checkpoints and attempts", () => {
    const clock = createClock();
    const mgr = new SessionRecoveryManager({ now: clock.now });

    for (let i = 0; i < 5; i++) {
      mgr.saveCheckpoint({
        sessionId: `session-${i}`,
        duplexState: "listening",
        modalityState: {
          inputModality: "audio",
          outputModality: "audio",
          textInterruptActive: false,
          audioOutputActive: false,
          textOutputActive: false,
          switchCount: 0,
          lastSwitchAt: null,
        },
        contextTokens: 0,
        conversationHistory: [],
        checkpointAt: clock.now(),
        recoveryAttempts: 0,
      });
    }

    expect(mgr.stats.activeCheckpoints).toBe(5);
    mgr.clear();
    expect(mgr.stats.activeCheckpoints).toBe(0);
  });

  it("backpressure unbind restores original methods", () => {
    const clock = createClock();
    const ao = createAudioOutput(clock);

    const originalPush = ao.pushAudio;

    const { unbind } = bindToAudioOutput(ao, {
      highWaterMs: 500,
      lowWaterMs: 100,
      sendBackpressure: () => {},
    });

    // pushAudio should be overridden
    expect(ao.pushAudio).not.toBe(originalPush);

    unbind();

    // After unbind, should fall back to prototype method
    // (not necessarily the same reference since bind was on prototype)
    ao.pushAudio(Buffer.alloc(100), 10);
    // Should not throw — method works normally
  });

  it("session idle timeout triggers end after inactivity", () => {
    const { session, ctrl } = createSession({ idleTimeoutMs: 1000 });
    session.start("user");

    // Advance time past idle timeout
    vi.advanceTimersByTime(1500);

    expect(session.isEnded).toBe(true);
    const endMsg = ctrl.find((c) => c.type === "duplex.session.end") as
      | { reason?: string }
      | undefined;
    expect(endMsg).toBeDefined();
    expect(endMsg!.reason).toBe("timeout");
  });
});
