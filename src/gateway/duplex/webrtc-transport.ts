/**
 * WebRTC transport adapter — Phase D.4.
 *
 * Implements the same send/receive interface as the WebSocket transport
 * so DuplexSession doesn't care which transport is active. Wraps a
 * WebRTC peer connection with SCTP data channel for control messages
 * and audio tracks for media.
 *
 * Pure module: depends on injected peer connection factory (no `wrtc`
 * import at module level). Clock injection for testing.
 *
 * The adapter manages:
 *   - Data channel for control messages (replaces WS control when upgraded)
 *   - Audio track for media frames (replaces WS audio when upgraded)
 *   - Connection state monitoring
 *   - Graceful teardown
 */

import {
  NegotiationState,
  type TransportType,
  type StreamTransportBinding,
  type WebRTCTransportConfig,
  type WebRTCTransportStats,
  type WebRTCDowngradeReason,
  INITIAL_WEBRTC_STATS,
  DEFAULT_WEBRTC_CONFIG,
} from "./webrtc-types.js";

// ============================================================================
// Abstraction over RTCPeerConnection for testability
// ============================================================================

/**
 * Minimal RTCPeerConnection interface — covers what we actually use.
 * Allows injecting a mock or the `wrtc` npm package implementation.
 */
export interface PeerConnectionLike {
  createOffer(): Promise<{ sdp?: string; type: string }>;
  createAnswer(): Promise<{ sdp?: string; type: string }>;
  setLocalDescription(desc: { sdp?: string; type: string }): Promise<void>;
  setRemoteDescription(desc: { sdp?: string; type: string }): Promise<void>;
  addIceCandidate(candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }): Promise<void>;
  createDataChannel(label: string, options?: { ordered?: boolean }): DataChannelLike;
  close(): void;

  readonly localDescription: { sdp?: string; type: string } | null;
  readonly remoteDescription: { sdp?: string; type: string } | null;
  readonly connectionState: string;
  readonly iceConnectionState: string;
  readonly iceGatheringState: string;

  onicecandidate: ((event: { candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } | null }) => void) | null;
  oniceconnectionstatechange: (() => void) | null;
  onconnectionstatechange: (() => void) | null;
  ondatachannel: ((event: { channel: DataChannelLike }) => void) | null;
}

/**
 * Minimal RTCDataChannel interface.
 */
export interface DataChannelLike {
  readonly label: string;
  readonly readyState: string;
  send(data: string | ArrayBuffer): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null;
  onerror: ((event: { error?: Error }) => void) | null;
}

/**
 * Factory to create a PeerConnectionLike. Caller injects this so we
 * don't depend on `wrtc` at module level.
 */
export type PeerConnectionFactory = (config: { iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> }) => PeerConnectionLike;

// ============================================================================
// Transport event callbacks
// ============================================================================

export interface WebRTCTransportCallbacks {
  /** Control message received over data channel. */
  onControlMessage?: (message: string) => void;
  /** Audio data received over data channel (binary). */
  onAudioData?: (data: ArrayBuffer) => void;
  /** Data channel opened — transport ready for control messages. */
  onDataChannelOpen?: () => void;
  /** Data channel closed. */
  onDataChannelClose?: () => void;
  /** ICE candidate generated — caller should send to peer via signaling. */
  onIceCandidate?: (candidate: string, sdpMid: string | null, sdpMLineIndex: number | null) => void;
  /** ICE gathering complete. */
  onIceGatheringComplete?: () => void;
  /** Connection state changed. */
  onConnectionStateChange?: (state: string) => void;
  /** Transport is fully ready (data channel open + ICE connected). */
  onReady?: () => void;
  /** Transport failed or disconnected. */
  onFailed?: (reason: WebRTCDowngradeReason) => void;
}

// ============================================================================
// WebRTC Transport Adapter
// ============================================================================

export interface WebRTCTransportOptions {
  config?: Partial<WebRTCTransportConfig>;
  callbacks: WebRTCTransportCallbacks;
  peerConnectionFactory: PeerConnectionFactory;
  now?: () => number;
}

export class WebRTCTransport {
  private readonly config: WebRTCTransportConfig;
  private readonly callbacks: WebRTCTransportCallbacks;
  private readonly peerConnectionFactory: PeerConnectionFactory;
  private readonly clock: () => number;

  private pc: PeerConnectionLike | null = null;
  private dataChannel: DataChannelLike | null = null;
  private _state: NegotiationState = NegotiationState.IDLE;
  private _streamBindings: Map<number, StreamTransportBinding> = new Map();
  private _stats: WebRTCTransportStats = { ...INITIAL_WEBRTC_STATS };
  private _disposed = false;

  constructor(options: WebRTCTransportOptions) {
    this.config = { ...DEFAULT_WEBRTC_CONFIG, ...options.config };
    this.callbacks = options.callbacks;
    this.peerConnectionFactory = options.peerConnectionFactory;
    this.clock = options.now ?? (() => Date.now());
  }

  get state(): NegotiationState {
    return this._state;
  }

  get isConnected(): boolean {
    return this._state === NegotiationState.ACTIVE;
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  get stats(): WebRTCTransportStats {
    return { ...this._stats };
  }

  get streamBindings(): ReadonlyMap<number, StreamTransportBinding> {
    return this._streamBindings;
  }

  // =========================================================================
  // Peer connection lifecycle
  // =========================================================================

  /**
   * Initialize the peer connection. Must be called before creating offers/answers.
   */
  initialize(): PeerConnectionLike {
    if (this._disposed) {
      throw new Error("WebRTCTransport: cannot initialize after disposal");
    }
    if (this.pc) {
      throw new Error("WebRTCTransport: already initialized");
    }

    this.pc = this.peerConnectionFactory({
      iceServers: this.config.iceServers,
    });

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        try {
          this.callbacks.onIceCandidate?.(
            event.candidate.candidate,
            event.candidate.sdpMid,
            event.candidate.sdpMLineIndex,
          );
        } catch {
          /* swallow */
        }
      } else {
        // Null candidate = ICE gathering complete
        try {
          this.callbacks.onIceGatheringComplete?.();
        } catch {
          /* swallow */
        }
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const iceState = this.pc?.iceConnectionState;
      if (iceState === "failed") {
        this.handleFailure("ice_failed");
      } else if (iceState === "disconnected") {
        this.handleFailure("peer_disconnected");
      }
    };

    this.pc.onconnectionstatechange = () => {
      const connState = this.pc?.connectionState;
      try {
        this.callbacks.onConnectionStateChange?.(connState ?? "unknown");
      } catch {
        /* swallow */
      }

      if (connState === "connected") {
        this.checkReady();
      } else if (connState === "failed") {
        this.handleFailure("dtls_failed");
      } else if (connState === "disconnected") {
        this.handleFailure("peer_disconnected");
      }
    };

    this.pc.ondatachannel = (event) => {
      this.setupDataChannel(event.channel);
    };

    return this.pc;
  }

  /**
   * Create an SDP offer. Caller is the offerer (creates data channel).
   */
  async createOffer(): Promise<string> {
    this.ensureInitialized();

    // Create data channel before offer (offerer creates it)
    const dc = this.pc!.createDataChannel(this.config.dataChannelLabel, {
      ordered: this.config.dataChannelOrdered,
    });
    this.setupDataChannel(dc);

    const offer = await this.pc!.createOffer();
    await this.pc!.setLocalDescription(offer);
    this._state = NegotiationState.SIGNALING;
    this._stats.negotiationState = NegotiationState.SIGNALING;

    return offer.sdp ?? "";
  }

  /**
   * Handle a remote SDP offer and create an answer.
   */
  async handleOffer(sdp: string): Promise<string> {
    this.ensureInitialized();

    await this.pc!.setRemoteDescription({ type: "offer", sdp });
    const answer = await this.pc!.createAnswer();
    await this.pc!.setLocalDescription(answer);
    this._state = NegotiationState.ICE_GATHERING;
    this._stats.negotiationState = NegotiationState.ICE_GATHERING;

    return answer.sdp ?? "";
  }

  /**
   * Handle a remote SDP answer.
   */
  async handleAnswer(sdp: string): Promise<void> {
    this.ensureInitialized();

    await this.pc!.setRemoteDescription({ type: "answer", sdp });
    this._state = NegotiationState.ICE_GATHERING;
    this._stats.negotiationState = NegotiationState.ICE_GATHERING;
  }

  /**
   * Add a remote ICE candidate.
   */
  async addIceCandidate(candidate: string, sdpMid: string | null, sdpMLineIndex: number | null): Promise<void> {
    this.ensureInitialized();
    await this.pc!.addIceCandidate({ candidate, sdpMid, sdpMLineIndex });
  }

  // =========================================================================
  // Data channel operations
  // =========================================================================

  /**
   * Send a control message over the data channel.
   */
  sendControl(message: string): boolean {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      return false;
    }

    try {
      this.dataChannel.send(message);
      this._stats.dataChannelBytesSent += message.length;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send binary audio data over the data channel.
   */
  sendAudio(data: ArrayBuffer): boolean {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      return false;
    }

    try {
      this.dataChannel.send(data);
      this._stats.dataChannelBytesSent += data.byteLength;
      this._stats.audioFramesSent++;
      return true;
    } catch {
      return false;
    }
  }

  // =========================================================================
  // Stream binding
  // =========================================================================

  /**
   * Bind a stream to this WebRTC transport.
   */
  bindStream(streamId: number, negotiationId: string | null): void {
    const binding: StreamTransportBinding = {
      streamId,
      transport: "webrtc" as TransportType,
      boundAt: this.clock(),
      negotiationId,
    };
    this._streamBindings.set(streamId, binding);

    // Update stats
    this._stats.webrtcStreams = Array.from(this._streamBindings.keys());
  }

  /**
   * Unbind a stream from this WebRTC transport (back to WebSocket).
   */
  unbindStream(streamId: number): boolean {
    const deleted = this._streamBindings.delete(streamId);
    this._stats.webrtcStreams = Array.from(this._streamBindings.keys());
    return deleted;
  }

  /**
   * Check if a stream is bound to this transport.
   */
  hasStream(streamId: number): boolean {
    return this._streamBindings.has(streamId);
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /**
   * Mark transport as active (connection established).
   */
  activate(rttMs?: number): void {
    this._state = NegotiationState.ACTIVE;
    this._stats.negotiationState = NegotiationState.ACTIVE;
    this._stats.successfulNegotiations++;
    if (rttMs !== undefined) {
      this._stats.lastRttMs = rttMs;
    }

    try {
      this.callbacks.onReady?.();
    } catch {
      /* swallow */
    }
  }

  /**
   * Dispose the transport — close peer connection and data channel.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    if (this.dataChannel) {
      try {
        this.dataChannel.close();
      } catch {
        /* swallow */
      }
      this.dataChannel = null;
    }

    if (this.pc) {
      try {
        this.pc.close();
      } catch {
        /* swallow */
      }
      this.pc = null;
    }

    this._streamBindings.clear();
    this._stats.webrtcStreams = [];
    this._state = NegotiationState.IDLE;
    this._stats.negotiationState = NegotiationState.IDLE;
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private ensureInitialized(): void {
    if (this._disposed) {
      throw new Error("WebRTCTransport: already disposed");
    }
    if (!this.pc) {
      throw new Error("WebRTCTransport: not initialized (call initialize() first)");
    }
  }

  private setupDataChannel(dc: DataChannelLike): void {
    this.dataChannel = dc;

    dc.onopen = () => {
      try {
        this.callbacks.onDataChannelOpen?.();
      } catch {
        /* swallow */
      }
      this.checkReady();
    };

    dc.onclose = () => {
      try {
        this.callbacks.onDataChannelClose?.();
      } catch {
        /* swallow */
      }
    };

    dc.onmessage = (event) => {
      if (typeof event.data === "string") {
        this._stats.dataChannelBytesReceived += event.data.length;
        try {
          this.callbacks.onControlMessage?.(event.data);
        } catch {
          /* swallow */
        }
      } else if (event.data instanceof ArrayBuffer) {
        this._stats.dataChannelBytesReceived += event.data.byteLength;
        this._stats.audioFramesReceived++;
        try {
          this.callbacks.onAudioData?.(event.data);
        } catch {
          /* swallow */
        }
      }
    };

    dc.onerror = () => {
      this.handleFailure("error");
    };
  }

  private checkReady(): void {
    const dcReady = this.dataChannel?.readyState === "open";
    const pcReady = this.pc?.connectionState === "connected";

    if (dcReady && pcReady && this._state !== NegotiationState.ACTIVE) {
      this.activate();
    }
  }

  private handleFailure(reason: WebRTCDowngradeReason): void {
    if (this._state === NegotiationState.FAILED) return; // already failed

    this._state = NegotiationState.FAILED;
    this._stats.negotiationState = NegotiationState.FAILED;
    this._stats.failedNegotiations++;

    try {
      this.callbacks.onFailed?.(reason);
    } catch {
      /* swallow */
    }
  }
}
