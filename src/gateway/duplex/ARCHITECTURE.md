# Duplex Streaming Architecture — Phase D

> Real-time bidirectional audio/text/video streaming with WebRTC upgrade path.

## Overview

The duplex streaming subsystem enables real-time conversational AI with simultaneous
send/receive capabilities. It sits between the WebSocket multiplex transport layer
(Phase B) and the LLM/TTS provider adapters, managing session state, barge-in
interrupts, mixed modality (text + audio), backpressure, session recovery, and
optional WebRTC transport upgrade.

All modules are **pure** — no I/O, no timers at module level. Clock injection
(`now?: () => number`) enables deterministic testing throughout.

## Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Client (Browser/App)                          │
│  WebSocket ──────────────────┬──────────────── WebRTC (optional)       │
└──────────────────────────────┼─────────────────────┬────────────────────┘
                               │                     │
                    ┌──────────▼──────────┐   ┌──────▼──────────┐
                    │  Multiplex Demuxer  │   │ WebRTC Transport│
                    │  (streamId routing) │   │  (data channel  │
                    └──┬────┬────┬────────┘   │   + media)      │
                       │    │    │            └──────┬──────────┘
              ┌────────┘    │    └────────┐          │
              ▼             ▼             ▼          ▼
       ┌──────────┐  ┌──────────┐  ┌──────────────────────┐
       │ Audio In │  │ Control  │  │  Transport Negotiator │
       │ Stream   │  │ Channel  │  │  (WS ↔ WebRTC)       │
       │ (s=1)    │  │ (s=0)    │  └──────────┬───────────┘
       └────┬─────┘  └────┬─────┘             │
            │              │          ┌────────┴────────┐
            │              │          │ WebRTC Signaling │
            │              │          └─────────────────┘
            │              │
       ┌────▼──────────────▼────────────────────────────┐
       │              OpenAI Realtime Adapter            │
       │  (client msg ↔ internal duplex protocol)       │
       └────────────────────┬───────────────────────────┘
                            │
       ┌────────────────────▼───────────────────────────┐
       │               DuplexSession                     │
       │  ┌────────────────┐  ┌───────────────────┐     │
       │  │ State Machine  │  │ Interrupt Handler  │     │
       │  │ (FSM)          │◄─┤ (barge-in)         │     │
       │  └────────────────┘  └───────────────────┘     │
       └────────────────────┬───────────────────────────┘
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐
  │ Backpressure │  │Mixed Modality│  │ Session Recovery  │
  │ Monitor      │  │ Handler      │  │ Manager           │
  └──────┬───────┘  └──────┬───────┘  └──────────────────┘
         │                 │
         ▼                 ▼
  ┌──────────────┐  ┌──────────────┐
  │ Audio Output │  │ Conversation │
  │ Stream (s=2) │  │ History      │
  └──────────────┘  └──────────────┘
```

## Data Flow Diagrams

### Normal Conversation Turn

```
User speaks          Agent processes       Agent responds
────────────         ──────────────        ──────────────

AudioInputStream     DuplexSession         AudioOutputStream
    │                    │                      ▲
    │ append(pcm)        │                      │ pushAudio()
    │ commit()           │                      │
    ▼                    ▼                      │
 "user.speech.       State Machine          LLM/TTS
  started"           LISTENING →            Provider
    │                AGENT_SPEAKING              │
    │                    │                      │
    │                    │ response.started      │
    │                    │──────────────────────►│
    │                    │                      │
    │                    │ response.audio_done   │
    │                    │◄─────────────────────│
    │                    │                      │
    │                State Machine              │
    │                AGENT_SPEAKING →            │
    │                LISTENING                   │
```

### Barge-In (Interrupt) Flow

```
Time ─────────────────────────────────────────────────►

Agent speaking         User barges in           Rollback complete
──────────────         ──────────────           ────────────────

State: AGENT_SPEAKING → SIMULTANEOUS → ROLLING_BACK → LISTENING

  1. user.speech.started     3. interrupt          5. rollback.complete
  2. InterruptHandler        4. audioOutput.       6. State → LISTENING
     .handleInterrupt()         truncateAt()
                                rollbackContext()

Messages sent:
  ├─ InterruptMessage { reason: "user_spoke", interruptedAtMs }
  └─ BargeInAckMessage { contextRolledBackBytes, newTtsInitiatedAt }
```

### WebRTC Upgrade Flow

```
Client                        Server
──────                        ──────
  │                             │
  │  webrtc.upgrade.request     │
  │────────────────────────────►│
  │                             │ TransportNegotiator
  │  webrtc.upgrade.response    │  .handleUpgradeRequest()
  │◄────────────────────────────│
  │                             │
  │  webrtc.sdp.offer           │ WebRTCSignaling
  │────────────────────────────►│  .handleOffer()
  │                             │
  │  webrtc.sdp.answer          │ WebRTCTransport
  │◄────────────────────────────│  .handleOffer() → answer
  │                             │
  │  webrtc.ice.candidate       │ ICE trickle
  │◄───────────────────────────►│
  │  webrtc.ice.complete        │
  │◄───────────────────────────►│
  │                             │
  │  [DTLS/SCTP handshake]      │
  │◄═══════════════════════════►│
  │                             │
  │  webrtc.ready               │ TransportNegotiator
  │◄────────────────────────────│  .handleTransportReady()
  │                             │
  │  ═══ WebRTC active ═══      │ Streams bound to WebRTC
  │  Data channel: control      │
  │  Media: audio               │
```

## API Reference

### DuplexStateMachine

Finite state machine governing the duplex session lifecycle.

```typescript
class DuplexStateMachine {
  state: DuplexState; // Current state
  history: readonly StateTransition[]; // Transition log
  isTerminal: boolean; // ENDED or ERROR

  transition(event: DuplexEvent, meta?): StateTransition; // Strict transition
  tryTransition(event: DuplexEvent, meta?): StateTransition | null; // Silent fail
  canTransition(event: DuplexEvent): boolean; // Check validity
  onTransition(listener): () => void; // Subscribe (returns unsubscribe)
  allowedEvents(): ReadonlySet<DuplexEvent>; // Valid events from current state
}
```

**States:** `INIT → LISTENING → AGENT_SPEAKING → SIMULTANEOUS → ROLLING_BACK → PAUSED → ENDED | ERROR`

### DuplexSession

Session coordinator — wires state machine, interrupt handler, and lifecycle.

```typescript
class DuplexSession {
  sessionId: string;
  stateMachine: DuplexStateMachine;
  interruptHandler: InterruptHandler;
  state: DuplexState;
  isEnded: boolean;

  start(role?, capabilities?): void; // Begin session
  end(reason?): void; // End session
  onUserSpeechStarted(): void; // User started talking
  onUserSpeechStopped(): void; // User stopped talking
  onResponseStarted(): void; // Agent output begins
  onResponseAudioDone(): void; // Agent output complete
  pause(): void; // Pause session
  resume(): void; // Resume session
  triggerInterrupt(reason?): Promise<InterruptResult | null>;
  getStats(): DuplexSessionStats;
  dispose(): void; // Cleanup
}
```

### InterruptHandler

Manages barge-in: truncates audio, rolls back context, sends control messages.

```typescript
class InterruptHandler {
  stats: { interruptCount; avgLatencyMs; budgetBreaches };

  handleInterrupt(reason?): Promise<InterruptResult | null>;
}

// Latency budget: 250ms (INTERRUPT_LATENCY_BUDGET_MS)
```

### OpenAIRealtimeAdapter

Translates between OpenAI Realtime WebSocket protocol and internal duplex protocol.

```typescript
class OpenAIRealtimeAdapter {
  handleClientMessage(rawJson: unknown): void; // Parse + dispatch client event
  bindAudioStreams(audioIn, audioOut): void; // Connect audio streams
  emitDuplexEvent(event: DuplexEvent, meta?): void; // Internal → OpenAI format
  emitAudioDelta(base64Audio, contentIndex?): void; // Ship audio to client
  snapshot(): { sessionId; lastResponseId; hasAudioIn; hasAudioOut };
}
```

**Client → Server mapping:**
| OpenAI Event | Internal Action |
|---|---|
| `session.update` | Config update |
| `input_audio_buffer.append` | `AudioInputStream.buffer.append()` |
| `input_audio_buffer.commit` | `AudioInputStream.commit()` |
| `response.create` | Signal downstream provider |
| `response.cancel` | Cancel in-flight response |
| `conversation.item.truncate` | Barge-in trigger |

### BackpressureMonitor

Flow control for the audio output queue. Uses hysteresis (high/low watermarks).

```typescript
class BackpressureMonitor {
  evaluate(queuedMs, playbackPositionMs?): BackpressureSnapshot;
  reset(): void;
  snapshot: BackpressureSnapshot;
}

// Convenience binding:
function bindToAudioOutput(audioOutput, options): BoundBackpressureMonitor;
```

**Thresholds:**

- `highWaterMs` — signal "high" + pause upstream
- `lowWaterMs` — signal "low" + resume upstream
- `maxQueuedMs` — overflow: call `onOverflow` (default: `highWaterMs × 2`)

### MixedModalityHandler

Manages text + audio modality switching, simultaneous input, and text-interrupts.

```typescript
class MixedModalityHandler {
  modalityState: Readonly<ModalityState>;
  conversationHistory: readonly ConversationItem[];
  stats: { switchCount, textInterruptCount, audioFallbackCount, ... };

  handleTextInput(message: TextInputMessage): { processed, interruptedAudio, previousModality };
  handleTextOutput(text, isFinal): void;
  onAudioOutputStarted(): void;
  onAudioOutputDone(): void;
  handleAudioFailure(reason): { fellBack: boolean };
  handleSimultaneousInput(textMsg, hasAudioActive): { textQueued, audioTakesPrecedence };
  createCheckpoint(): SessionRecoveryState;
  attemptRecovery(checkpoint): { recovered, reason? };
  addAudioTranscript(role, transcript): void;
  resetModality(): void;
}
```

**Modalities:** `"audio"`, `"text"`, `"text+audio"`

### SessionRecoveryManager

Manages checkpoints for session recovery after disconnects or errors.

```typescript
class SessionRecoveryManager {
  stats: { activeCheckpoints; totalCheckpoints; totalRecoveries; totalFailures };

  saveCheckpoint(state: SessionRecoveryState): void;
  getCheckpoint(sessionId): SessionRecoveryState | null;
  attemptRecovery(sessionId): { recovered; checkpoint?; reason? };
  removeCheckpoint(sessionId): boolean;
  pruneExpired(): number;
  buildRecoveryContext(checkpoint): { systemPrompt; messages };
  clear(): void;
}
```

### WebRTCSignaling

SDP offer/answer exchange and ICE candidate trickle over WebSocket.

```typescript
class WebRTCSignaling {
  state: NegotiationState;
  currentNegotiationId: string | null;
  localSdp / remoteSdp: string | null;
  stats: { successfulNegotiations, failedNegotiations, ... };

  createOffer(sdp, requestedStreams?): SdpOfferMessage;
  handleOffer(offer): SdpOfferMessage;
  createAnswer(sdp, acceptedStreams?): SdpAnswerMessage;
  handleAnswer(answer): SdpAnswerMessage;
  addLocalIceCandidate(candidate, sdpMid, sdpMLineIndex): IceCandidateMessage;
  addRemoteIceCandidate(msg): IceCandidateMessage;
  completeLocalIceGathering(): IceGatheringCompleteMessage;
  handleRemoteIceComplete(msg): void;
  handleMessage(msg: WebRTCSignalingMessage): WebRTCSignalingMessage;
  fail(reason): void;
  complete(rttMs?): void;
  reset(): void;
}
```

**Negotiation states:** `IDLE → SIGNALING → ICE_GATHERING → CONNECTING → ACTIVE | FAILED`

### WebRTCTransport

Wraps RTCPeerConnection with SCTP data channel and audio tracks.

```typescript
class WebRTCTransport {
  state: NegotiationState;
  isConnected: boolean;
  isDisposed: boolean;
  stats: WebRTCTransportStats;
  streamBindings: ReadonlyMap<number, StreamTransportBinding>;

  initialize(): PeerConnectionLike;
  createOffer(): Promise<string>;
  handleOffer(sdp): Promise<string>;
  handleAnswer(sdp): Promise<void>;
  addIceCandidate(candidate, sdpMid, sdpMLineIndex): Promise<void>;
  sendControl(message: string): boolean;
  sendAudio(data: ArrayBuffer): boolean;
  bindStream(streamId, negotiationId): void;
  unbindStream(streamId): boolean;
  activate(rttMs?): void;
  dispose(): void;
}
```

### TransportNegotiator

Orchestrates the full WS → WebRTC upgrade lifecycle with retry and fallback.

```typescript
class TransportNegotiator {
  state: NegotiationState;
  upgradeAttempts: number;
  canRetry: boolean;
  activeTransport: TransportType; // "websocket" | "webrtc"
  snapshot: NegotiatorSnapshot;

  requestUpgrade(requestedStreams?): WebRTCUpgradeRequestMessage;
  handleMessage(msg): void; // Routes all WebRTC-related messages
  sendControlMessage(message): TransportType; // Auto-routes via active transport
  sendAudioData(data): TransportType;
  getStreamTransport(streamId): TransportType;
  downgrade(reason?, streams?): void;
  dispose(): void;
}
```

## Configuration Points

| Component                | Config                        | Default       | Description                          |
| ------------------------ | ----------------------------- | ------------- | ------------------------------------ |
| `DuplexSession`          | `idleTimeoutMs`               | 60,000        | Auto-end on inactivity               |
| `DuplexSession`          | `interruptDebounceMs`         | 200           | Min time between interrupts          |
| `InterruptHandler`       | `INTERRUPT_LATENCY_BUDGET_MS` | 250           | Target interrupt latency             |
| `BackpressureMonitor`    | `highWaterMs`                 | —             | Queue depth to signal "high"         |
| `BackpressureMonitor`    | `lowWaterMs`                  | —             | Queue depth to signal "low"          |
| `BackpressureMonitor`    | `maxQueuedMs`                 | `highWater×2` | Hard overflow ceiling                |
| `MixedModalityHandler`   | `textInterruptsTts`           | true          | Text input interrupts audio          |
| `MixedModalityHandler`   | `audioFallbackToText`         | true          | Fall back to text on audio failure   |
| `MixedModalityHandler`   | `maxRecoveryItems`            | 50            | Max conversation items in checkpoint |
| `MixedModalityHandler`   | `modalitySwitchDebounceMs`    | 100           | Min time between modality switches   |
| `MixedModalityHandler`   | `maxRecoveryAttempts`         | 3             | Max recovery attempts                |
| `SessionRecoveryManager` | `checkpointTtlMs`             | 300,000       | Checkpoint expiry (5 min)            |
| `WebRTCTransportConfig`  | `negotiationTimeoutMs`        | 10,000        | Negotiation timeout                  |
| `WebRTCTransportConfig`  | `iceGatheringTimeoutMs`       | 5,000         | ICE gathering timeout                |
| `WebRTCTransportConfig`  | `maxRetries`                  | 2             | Upgrade retry limit                  |
| `WebRTCTransportConfig`  | `preferredAudioCodec`         | "opus"        | Preferred audio codec                |
| `WebRTCTransportConfig`  | `trickleIce`                  | true          | Enable trickle ICE                   |
| `WebRTCTransportConfig`  | `dataChannelLabel`            | "control"     | Data channel label                   |

## Error Handling Strategy

1. **Never poison the pipeline.** All listener callbacks and optional handlers are
   wrapped in `try/catch` blocks that swallow errors — a misbehaving listener
   must never break the state machine or audio pipeline.

2. **Graceful degradation.** When a component fails:
   - Rollback context failure → interrupt still completes with `{ rolledBackBytes: 0 }`
   - Audio failure → `MixedModalityHandler.handleAudioFailure()` falls back to text
   - WebRTC failure → `TransportNegotiator` falls back to WebSocket (always available)
   - Recovery failure → session continues without checkpoint restoration

3. **Strict state machine.** Invalid transitions throw `DuplexStateMachineError` with
   structured codes (`INVALID_TRANSITION`, `TERMINAL_STATE`). The `tryTransition()`
   method provides a silent fallback when failure is expected (e.g., user speech
   events during unexpected states).

4. **Backpressure overflow.** When the audio queue exceeds `maxQueuedMs`, the overflow
   callback fires. The coordinator decides whether to truncate — the monitor never
   truncates directly.

5. **Transport negotiation failure.** WebRTC upgrade failures are counted. After
   `maxRetries` (default: 2), the negotiator permanently falls back to WebSocket.
   The `onUpgradeFailed` callback notifies the coordinator.

## How WebRTC Upgrade Works

WebRTC is an **optional** transport upgrade. WebSocket remains the default and
always-available fallback. The upgrade path is:

1. **Request** — Client or server sends `webrtc.upgrade.request` specifying which
   multiplex streams to upgrade (e.g., `[1, 2]` for audio in/out, or all).

2. **Response** — Peer evaluates (retry budget, capabilities) and responds with
   `webrtc.upgrade.response`. If rejected, nothing changes.

3. **SDP Exchange** — On acceptance, `TransportNegotiator` creates `WebRTCSignaling`
   and `WebRTCTransport` instances. SDP offer/answer is exchanged over the existing
   WebSocket control channel.

4. **ICE Gathering** — ICE candidates are trickled over WebSocket. Both sides signal
   ICE gathering complete.

5. **Connection** — DTLS/SCTP handshake occurs. The transport monitors
   `connectionState` and `iceConnectionState` on the peer connection.

6. **Ready** — When the data channel opens and the peer connection reaches
   `"connected"` state, the transport fires `onReady`. The negotiator binds the
   requested streams to WebRTC and sends a `webrtc.ready` message.

7. **Hybrid Mode** — Individual streams can be selectively upgraded. Stream 0
   (control) might stay on WebSocket while streams 1-2 (audio) move to WebRTC.
   `getStreamTransport(streamId)` reports which transport carries each stream.

8. **Downgrade** — If WebRTC fails (ICE failure, DTLS failure, peer disconnect),
   streams automatically fall back to WebSocket. Explicit downgrade via
   `downgrade(reason, streams)` is also supported. A `webrtc.downgrade` message
   notifies the peer.

9. **Retry** — Up to `maxRetries` upgrade attempts are allowed. After exhaustion,
   `canRetry` returns `false` and further upgrade requests throw.

## File Map

```
src/gateway/duplex/
├── types.ts                    # Core types: DuplexState, events, messages
├── state-machine.ts            # FSM for session lifecycle
├── session.ts                  # Session coordinator
├── interrupt-handler.ts        # Barge-in interrupt logic
├── openai-realtime-types.ts    # OpenAI Realtime API type definitions
├── openai-realtime-adapter.ts  # OpenAI ↔ internal protocol bridge
├── backpressure.ts             # Queue depth monitoring + flow control
├── mixed-modality-types.ts     # Modality types + config
├── mixed-modality-handler.ts   # Text/audio switching + conversation history
├── session-recovery.ts         # Checkpoint + recovery manager
├── webrtc-types.ts             # WebRTC signaling/transport types
├── webrtc-signaling.ts         # SDP + ICE exchange handler
├── webrtc-transport.ts         # RTCPeerConnection adapter
├── transport-negotiator.ts     # WS ↔ WebRTC upgrade orchestrator
├── index.ts                    # Barrel exports
├── integration.test.ts         # Cross-component integration tests
├── *.test.ts                   # Per-component unit tests
└── ARCHITECTURE.md             # This document
```
