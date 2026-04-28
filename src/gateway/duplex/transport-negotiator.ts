/**
 * Transport negotiator — Phase D.4.
 *
 * Coordinates the upgrade from WebSocket → WebRTC transport. Owns the
 * signaling handler and WebRTC transport adapter, orchestrates the
 * negotiation lifecycle, and handles graceful fallback to WebSocket.
 *
 * Pure module: no timers, no I/O. Caller drives the process.
 * Clock injection via `now` option for deterministic testing.
 *
 * Lifecycle:
 *   1. Client sends `webrtc.upgrade.request`
 *   2. Server evaluates and sends `webrtc.upgrade.response`
 *   3. If accepted → SDP offer/answer exchange via WebRTCSignaling
 *   4. ICE candidates trickled via signaling
 *   5. On success → streams bound to WebRTC transport
 *   6. On failure → fallback to WebSocket (no-op, WS already active)
 */

import {
  WebRTCSignaling,
  SignalingError,
  type SignalingOptions,
} from "./webrtc-signaling.js";
import {
  WebRTCTransport,
  type WebRTCTransportOptions,
  type WebRTCTransportCallbacks,
  type PeerConnectionFactory,
} from "./webrtc-transport.js";
import {
  NegotiationState,
  type WebRTCUpgradeRequestMessage,
  type WebRTCUpgradeResponseMessage,
  type WebRTCReadyMessage,
  type WebRTCDowngradeMessage,
  type WebRTCSignalingMessage,
  type WebRTCTransportConfig,
  type WebRTCDowngradeReason,
  type TransportType,
  type StreamTransportBinding,
  DEFAULT_WEBRTC_CONFIG,
} from "./webrtc-types.js";

// ============================================================================
// Negotiator options & types
// ============================================================================

export interface TransportNegotiatorOptions {
  /** Send a signaling/control message to the peer via WebSocket. */
  sendControl: (msg: WebRTCSignalingMessage | WebRTCUpgradeRequestMessage | WebRTCUpgradeResponseMessage | WebRTCReadyMessage | WebRTCDowngradeMessage) => void;
  /** Factory to create RTCPeerConnection instances. */
  peerConnectionFactory: PeerConnectionFactory;
  /** WebRTC transport configuration overrides. */
  config?: Partial<WebRTCTransportConfig>;
  /** Max upgrade attempts before permanent fallback. Default: 2. */
  maxRetries?: number;
  /** Called when WebRTC transport is ready and streams are bound. */
  onUpgradeComplete?: (activeStreams: number[], rttMs: number | null) => void;
  /** Called when upgrade failed and WebSocket remains active. */
  onUpgradeFailed?: (reason: string) => void;
  /** Called when a downgrade back to WebSocket occurs. */
  onDowngrade?: (reason: WebRTCDowngradeReason, streams: number[]) => void;
  /** Control message received over WebRTC data channel (replaces WS control). */
  onWebRTCControlMessage?: (message: string) => void;
  /** Audio data received over WebRTC. */
  onWebRTCAudioData?: (data: ArrayBuffer) => void;
  /** Clock injection. */
  now?: () => number;
}

export interface NegotiatorSnapshot {
  state: NegotiationState;
  upgradeAttempts: number;
  maxRetries: number;
  activeTransport: TransportType;
  webrtcStreams: number[];
  websocketStreams: number[];
  hasSignaling: boolean;
  hasTransport: boolean;
}

// ============================================================================
// Transport Negotiator
// ============================================================================

export class TransportNegotiator {
  private readonly sendControl: TransportNegotiatorOptions["sendControl"];
  private readonly peerConnectionFactory: PeerConnectionFactory;
  private readonly config: WebRTCTransportConfig;
  private readonly maxRetries: number;
  private readonly clock: () => number;

  private readonly onUpgradeComplete?: TransportNegotiatorOptions["onUpgradeComplete"];
  private readonly onUpgradeFailed?: TransportNegotiatorOptions["onUpgradeFailed"];
  private readonly onDowngrade?: TransportNegotiatorOptions["onDowngrade"];
  private readonly onWebRTCControlMessage?: TransportNegotiatorOptions["onWebRTCControlMessage"];
  private readonly onWebRTCAudioData?: TransportNegotiatorOptions["onWebRTCAudioData"];

  private signaling: WebRTCSignaling | null = null;
  private transport: WebRTCTransport | null = null;
  private _state: NegotiationState = NegotiationState.IDLE;
  private _upgradeAttempts = 0;
  private _currentRequestedStreams: number[] = [];
  private _allStreams: number[] = [0, 1, 2]; // control, audio-in, audio-out
  private _disposed = false;

  constructor(options: TransportNegotiatorOptions) {
    this.sendControl = options.sendControl;
    this.peerConnectionFactory = options.peerConnectionFactory;
    this.config = { ...DEFAULT_WEBRTC_CONFIG, ...options.config };
    this.maxRetries = options.maxRetries ?? this.config.maxRetries;
    this.clock = options.now ?? (() => Date.now());

    this.onUpgradeComplete = options.onUpgradeComplete;
    this.onUpgradeFailed = options.onUpgradeFailed;
    this.onDowngrade = options.onDowngrade;
    this.onWebRTCControlMessage = options.onWebRTCControlMessage;
    this.onWebRTCAudioData = options.onWebRTCAudioData;
  }

  get state(): NegotiationState {
    return this._state;
  }

  get upgradeAttempts(): number {
    return this._upgradeAttempts;
  }

  get canRetry(): boolean {
    return this._upgradeAttempts < this.maxRetries;
  }

  get activeTransport(): TransportType {
    return this._state === NegotiationState.ACTIVE ? "webrtc" : "websocket";
  }

  get snapshot(): NegotiatorSnapshot {
    return {
      state: this._state,
      upgradeAttempts: this._upgradeAttempts,
      maxRetries: this.maxRetries,
      activeTransport: this.activeTransport,
      webrtcStreams: this.transport ? Array.from(this.transport.streamBindings.keys()) : [],
      websocketStreams: this.getWebSocketStreams(),
      hasSignaling: this.signaling !== null,
      hasTransport: this.transport !== null,
    };
  }

  // =========================================================================
  // Upgrade request/response (initiator side)
  // =========================================================================

  /**
   * Request an upgrade to WebRTC for specific streams.
   * Sends a `webrtc.upgrade.request` to the peer.
   */
  requestUpgrade(requestedStreams: number[] = []): WebRTCUpgradeRequestMessage {
    if (this._disposed) {
      throw new Error("TransportNegotiator: already disposed");
    }
    if (this._state !== NegotiationState.IDLE && this._state !== NegotiationState.FAILED) {
      throw new Error(`TransportNegotiator: cannot request upgrade in state "${this._state}"`);
    }
    if (!this.canRetry) {
      throw new Error(`TransportNegotiator: max retries exceeded (${this._upgradeAttempts}/${this.maxRetries})`);
    }

    this._upgradeAttempts++;
    this._currentRequestedStreams = requestedStreams.length > 0 ? [...requestedStreams] : [...this._allStreams];
    this._state = NegotiationState.REQUESTED;

    const negotiationId = `upgrade_${this._upgradeAttempts}_${this.clock().toString(36)}`;

    const msg: WebRTCUpgradeRequestMessage = {
      type: "webrtc.upgrade.request",
      negotiationId,
      preferredAudioCodec: this.config.preferredAudioCodec,
      requestedStreams: this._currentRequestedStreams,
    };

    try {
      this.sendControl(msg);
    } catch {
      /* best-effort */
    }

    return msg;
  }

  // =========================================================================
  // Handle incoming messages
  // =========================================================================

  /**
   * Handle an incoming WebRTC-related control message.
   * Routes upgrade requests, responses, signaling, ready, and downgrade.
   */
  handleMessage(
    msg:
      | WebRTCSignalingMessage
      | WebRTCUpgradeRequestMessage
      | WebRTCUpgradeResponseMessage
      | WebRTCReadyMessage
      | WebRTCDowngradeMessage,
  ): void {
    switch (msg.type) {
      case "webrtc.upgrade.request":
        this.handleUpgradeRequest(msg);
        break;
      case "webrtc.upgrade.response":
        this.handleUpgradeResponse(msg);
        break;
      case "webrtc.ready":
        this.handleReady(msg);
        break;
      case "webrtc.downgrade":
        this.handleDowngrade(msg);
        break;
      // Signaling messages
      case "webrtc.sdp.offer":
      case "webrtc.sdp.answer":
      case "webrtc.ice.candidate":
      case "webrtc.ice.complete":
        this.handleSignalingMessage(msg);
        break;
      default:
        // Unknown message type — ignore
        break;
    }
  }

  // =========================================================================
  // Send functions for the active transport
  // =========================================================================

  /**
   * Send a control message via the active transport (WebRTC if upgraded, WS otherwise).
   */
  sendControlMessage(message: string): TransportType {
    if (this._state === NegotiationState.ACTIVE && this.transport?.isConnected) {
      if (this.transport.sendControl(message)) {
        return "webrtc";
      }
    }
    // Fallback: caller should use their WebSocket send
    return "websocket";
  }

  /**
   * Send audio data via the active transport.
   */
  sendAudioData(data: ArrayBuffer): TransportType {
    if (this._state === NegotiationState.ACTIVE && this.transport?.isConnected) {
      if (this.transport.sendAudio(data)) {
        return "webrtc";
      }
    }
    return "websocket";
  }

  /**
   * Get the transport type for a specific stream.
   */
  getStreamTransport(streamId: number): TransportType {
    if (this.transport?.hasStream(streamId)) {
      return "webrtc";
    }
    return "websocket";
  }

  // =========================================================================
  // Downgrade
  // =========================================================================

  /**
   * Explicitly downgrade to WebSocket for all or specific streams.
   */
  downgrade(reason: WebRTCDowngradeReason = "explicit", streams?: number[]): void {
    const streamsToDowngrade = streams ?? (this.transport ? Array.from(this.transport.streamBindings.keys()) : []);

    if (this.transport) {
      for (const streamId of streamsToDowngrade) {
        this.transport.unbindStream(streamId);
      }
    }

    const msg: WebRTCDowngradeMessage = {
      type: "webrtc.downgrade",
      negotiationId: this.signaling?.currentNegotiationId ?? `dg_${this.clock().toString(36)}`,
      reason,
      streams: streamsToDowngrade,
    };

    try {
      this.sendControl(msg);
    } catch {
      /* best-effort */
    }

    // If all streams downgraded, tear down WebRTC
    if (!this.transport || this.transport.streamBindings.size === 0) {
      this.teardownWebRTC();
      this._state = NegotiationState.IDLE;
    }

    try {
      this.onDowngrade?.(reason, streamsToDowngrade);
    } catch {
      /* swallow */
    }
  }

  // =========================================================================
  // Dispose
  // =========================================================================

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    this.teardownWebRTC();
    this._state = NegotiationState.IDLE;
  }

  // =========================================================================
  // Private: upgrade request/response handlers
  // =========================================================================

  private handleUpgradeRequest(msg: WebRTCUpgradeRequestMessage): void {
    // Server-side: evaluate and respond
    const accepted = !this._disposed && this.canRetry;

    const acceptedStreams = accepted ? (msg.requestedStreams ?? [...this._allStreams]) : [];

    const response: WebRTCUpgradeResponseMessage = {
      type: "webrtc.upgrade.response",
      negotiationId: msg.negotiationId,
      accepted,
      ...(accepted ? { acceptedStreams } : { reason: this._disposed ? "transport disposed" : "max retries exceeded" }),
    };

    try {
      this.sendControl(response);
    } catch {
      /* best-effort */
    }

    if (accepted) {
      this._upgradeAttempts++;
      this._currentRequestedStreams = [...acceptedStreams];
      this._state = NegotiationState.SIGNALING;
      this.initSignalingAndTransport();
    }
  }

  private handleUpgradeResponse(msg: WebRTCUpgradeResponseMessage): void {
    if (this._state !== NegotiationState.REQUESTED) {
      return; // Unexpected response — ignore
    }

    if (!msg.accepted) {
      this._state = NegotiationState.FAILED;
      try {
        this.onUpgradeFailed?.(msg.reason ?? "peer rejected upgrade");
      } catch {
        /* swallow */
      }
      // Allow retry if under limit
      if (this.canRetry) {
        this._state = NegotiationState.IDLE;
      }
      return;
    }

    this._currentRequestedStreams = msg.acceptedStreams ?? [...this._currentRequestedStreams];
    this._state = NegotiationState.SIGNALING;
    this.initSignalingAndTransport();
  }

  // =========================================================================
  // Private: signaling & transport setup
  // =========================================================================

  private initSignalingAndTransport(): void {
    // Initialize signaling
    this.signaling = new WebRTCSignaling({
      sendSignaling: (msg) => {
        try {
          this.sendControl(msg);
        } catch {
          /* best-effort */
        }
      },
      onSignalingComplete: () => {
        // Signaling done → transport should be connecting
        this._state = NegotiationState.CONNECTING;
      },
      onSignalingFailed: (_id, reason) => {
        this.handleNegotiationFailure(reason);
      },
      now: this.clock,
    });

    // Initialize transport
    const transportCallbacks: WebRTCTransportCallbacks = {
      onControlMessage: (message) => {
        try {
          this.onWebRTCControlMessage?.(message);
        } catch {
          /* swallow */
        }
      },
      onAudioData: (data) => {
        try {
          this.onWebRTCAudioData?.(data);
        } catch {
          /* swallow */
        }
      },
      onIceCandidate: (candidate, sdpMid, sdpMLineIndex) => {
        if (this.signaling && (this.signaling.state === NegotiationState.ICE_GATHERING || this.signaling.state === NegotiationState.SIGNALING)) {
          try {
            this.signaling.addLocalIceCandidate(candidate, sdpMid, sdpMLineIndex);
          } catch {
            /* swallow */
          }
        }
      },
      onIceGatheringComplete: () => {
        if (this.signaling && this.signaling.state === NegotiationState.ICE_GATHERING) {
          try {
            this.signaling.completeLocalIceGathering();
          } catch {
            /* swallow */
          }
        }
      },
      onReady: () => {
        this.handleTransportReady();
      },
      onFailed: (reason) => {
        this.handleNegotiationFailure(`transport failed: ${reason}`);
      },
      onDataChannelOpen: () => {
        // Data channel open — part of readiness check
      },
      onDataChannelClose: () => {
        if (this._state === NegotiationState.ACTIVE) {
          this.downgrade("peer_disconnected");
        }
      },
      onConnectionStateChange: () => {
        // Monitored by transport internally
      },
    };

    this.transport = new WebRTCTransport({
      config: this.config,
      callbacks: transportCallbacks,
      peerConnectionFactory: this.peerConnectionFactory,
      now: this.clock,
    });

    this.transport.initialize();
  }

  private handleSignalingMessage(msg: WebRTCSignalingMessage): void {
    if (!this.signaling) {
      // If we receive signaling messages without an active signaling handler,
      // it might be the peer initiating. We need signaling + transport.
      if (msg.type === "webrtc.sdp.offer" && (this._state === NegotiationState.SIGNALING || this._state === NegotiationState.IDLE)) {
        if (!this.transport) {
          this.initSignalingAndTransport();
        }
      } else {
        return; // Ignore stale signaling
      }
    }

    try {
      this.signaling!.handleMessage(msg);
    } catch (err) {
      if (err instanceof SignalingError) {
        this.handleNegotiationFailure(err.message);
      }
    }
  }

  // =========================================================================
  // Private: transport ready / failure
  // =========================================================================

  private handleTransportReady(): void {
    if (!this.transport) return;

    // Bind requested streams to WebRTC transport
    const negotiationId = this.signaling?.currentNegotiationId ?? null;
    for (const streamId of this._currentRequestedStreams) {
      this.transport.bindStream(streamId, negotiationId);
    }

    this._state = NegotiationState.ACTIVE;

    // Send ready message to peer
    const readyMsg: WebRTCReadyMessage = {
      type: "webrtc.ready",
      negotiationId: negotiationId ?? `ready_${this.clock().toString(36)}`,
      activeStreams: [...this._currentRequestedStreams],
      estimatedRttMs: this.transport.stats.lastRttMs ?? undefined,
    };

    try {
      this.sendControl(readyMsg);
    } catch {
      /* best-effort */
    }

    // Complete signaling
    if (this.signaling) {
      this.signaling.complete(this.transport.stats.lastRttMs ?? undefined);
    }

    try {
      this.onUpgradeComplete?.(
        [...this._currentRequestedStreams],
        this.transport.stats.lastRttMs,
      );
    } catch {
      /* swallow */
    }
  }

  private handleReady(msg: WebRTCReadyMessage): void {
    // Peer reports ready — confirm our side
    if (this._state === NegotiationState.CONNECTING || this._state === NegotiationState.ICE_GATHERING) {
      if (this.transport && !this.transport.isConnected) {
        // Peer is ready but we're not yet — wait for our transport ready callback
        return;
      }
      // Both sides ready
      this._state = NegotiationState.ACTIVE;
    }
  }

  private handleDowngrade(msg: WebRTCDowngradeMessage): void {
    const streams = msg.streams ?? (this.transport ? Array.from(this.transport.streamBindings.keys()) : []);

    if (this.transport) {
      for (const streamId of streams) {
        this.transport.unbindStream(streamId);
      }
    }

    if (!this.transport || this.transport.streamBindings.size === 0) {
      this.teardownWebRTC();
      this._state = NegotiationState.IDLE;
    }

    try {
      this.onDowngrade?.(msg.reason, streams);
    } catch {
      /* swallow */
    }
  }

  private handleNegotiationFailure(reason: string): void {
    if (this.signaling) {
      try {
        this.signaling.fail(reason);
      } catch {
        /* swallow */
      }
    }

    this.teardownWebRTC();

    if (this.canRetry) {
      this._state = NegotiationState.IDLE;
    } else {
      this._state = NegotiationState.FAILED;
    }

    try {
      this.onUpgradeFailed?.(reason);
    } catch {
      /* swallow */
    }
  }

  // =========================================================================
  // Private: teardown
  // =========================================================================

  private teardownWebRTC(): void {
    if (this.transport) {
      this.transport.dispose();
      this.transport = null;
    }
    if (this.signaling) {
      this.signaling.reset();
      this.signaling = null;
    }
  }

  private getWebSocketStreams(): number[] {
    if (!this.transport) return [...this._allStreams];
    return this._allStreams.filter((id) => !this.transport!.hasStream(id));
  }
}
