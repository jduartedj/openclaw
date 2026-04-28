/**
 * WebRTC transport types — Phase D.4.
 *
 * Type definitions for WebRTC signaling, transport negotiation, and
 * the upgrade path from WebSocket to WebRTC. These types extend the
 * existing duplex control protocol (streamId 0) with SDP/ICE messages.
 *
 * Design: WebRTC is an OPTIONAL upgrade — WebSocket remains default.
 * Signaling is tunnelled over the existing WebSocket control channel.
 */

// ============================================================================
// Signaling message types (sent over WebSocket control channel, streamId 0)
// ============================================================================

/**
 * SDP offer from initiator (client or server).
 * Sent over WebSocket control channel to begin WebRTC negotiation.
 */
export interface SdpOfferMessage {
  type: "webrtc.sdp.offer";
  sdp: string;
  /** Unique negotiation round — allows concurrent renegotiations. */
  negotiationId: string;
  /**
   * Which streams the offerer wants to move to WebRTC.
   * Empty = all eligible streams. Allows hybrid mode.
   */
  requestedStreams?: number[];
}

/**
 * SDP answer from the peer.
 */
export interface SdpAnswerMessage {
  type: "webrtc.sdp.answer";
  sdp: string;
  negotiationId: string;
  /** Streams the answerer accepted for WebRTC transport. */
  acceptedStreams?: number[];
}

/**
 * ICE candidate exchange — trickle ICE over WebSocket.
 */
export interface IceCandidateMessage {
  type: "webrtc.ice.candidate";
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  negotiationId: string;
}

/**
 * Signal that ICE gathering is complete (no more candidates).
 */
export interface IceGatheringCompleteMessage {
  type: "webrtc.ice.complete";
  negotiationId: string;
}

/**
 * WebRTC upgrade request — client asks server to upgrade transport.
 */
export interface WebRTCUpgradeRequestMessage {
  type: "webrtc.upgrade.request";
  negotiationId: string;
  /** Optional: prefer specific codec for audio (default: opus). */
  preferredAudioCodec?: string;
  /** Optional: which streams to upgrade (default: all). */
  requestedStreams?: number[];
}

/**
 * WebRTC upgrade response — server accepts/rejects the upgrade.
 */
export interface WebRTCUpgradeResponseMessage {
  type: "webrtc.upgrade.response";
  negotiationId: string;
  accepted: boolean;
  reason?: string;
  /** Streams that will be upgraded (subset of requested). */
  acceptedStreams?: number[];
}

/**
 * WebRTC transport is now active — peer confirms data channel open
 * and media tracks connected.
 */
export interface WebRTCReadyMessage {
  type: "webrtc.ready";
  negotiationId: string;
  /** Which streams are now on WebRTC. */
  activeStreams: number[];
  /** RTT estimate from ICE connectivity check (ms). */
  estimatedRttMs?: number;
}

/**
 * WebRTC downgrade — revert to WebSocket for specified streams.
 */
export interface WebRTCDowngradeMessage {
  type: "webrtc.downgrade";
  negotiationId: string;
  reason: WebRTCDowngradeReason;
  /** Streams to move back to WebSocket. Empty = all. */
  streams?: number[];
}

export type WebRTCDowngradeReason =
  | "ice_failed"
  | "dtls_failed"
  | "peer_disconnected"
  | "explicit"
  | "timeout"
  | "error";

/**
 * Union of all WebRTC signaling messages.
 */
export type WebRTCSignalingMessage =
  | SdpOfferMessage
  | SdpAnswerMessage
  | IceCandidateMessage
  | IceGatheringCompleteMessage
  | WebRTCUpgradeRequestMessage
  | WebRTCUpgradeResponseMessage
  | WebRTCReadyMessage
  | WebRTCDowngradeMessage;

export const WEBRTC_MESSAGE_TYPES = [
  "webrtc.sdp.offer",
  "webrtc.sdp.answer",
  "webrtc.ice.candidate",
  "webrtc.ice.complete",
  "webrtc.upgrade.request",
  "webrtc.upgrade.response",
  "webrtc.ready",
  "webrtc.downgrade",
] as const;

export type WebRTCMessageType = (typeof WEBRTC_MESSAGE_TYPES)[number];

export function isWebRTCMessageType(type: string): type is WebRTCMessageType {
  return (WEBRTC_MESSAGE_TYPES as readonly string[]).includes(type);
}

// ============================================================================
// Transport abstraction
// ============================================================================

/** Transport type discriminator. */
export type TransportType = "websocket" | "webrtc";

/**
 * Per-stream transport binding — tracks which transport carries each
 * multiplex stream. Enables hybrid mode where some streams use WebRTC
 * and others stay on WebSocket.
 */
export interface StreamTransportBinding {
  streamId: number;
  transport: TransportType;
  /** When this binding was established. */
  boundAt: number;
  /** Negotiation that created this binding (null for initial WS). */
  negotiationId: string | null;
}

// ============================================================================
// Transport negotiation state
// ============================================================================

export enum NegotiationState {
  /** No negotiation in progress. */
  IDLE = "idle",
  /** Upgrade requested, waiting for peer response. */
  REQUESTED = "requested",
  /** Peer accepted, SDP offer/answer in progress. */
  SIGNALING = "signaling",
  /** SDP exchanged, ICE candidates being gathered/exchanged. */
  ICE_GATHERING = "ice_gathering",
  /** ICE complete, waiting for DTLS/SCTP handshake. */
  CONNECTING = "connecting",
  /** WebRTC transport is active for negotiated streams. */
  ACTIVE = "active",
  /** Negotiation failed; fell back to WebSocket. */
  FAILED = "failed",
  /** Downgrade in progress — moving streams back to WebSocket. */
  DOWNGRADING = "downgrading",
}

export interface NegotiationRecord {
  negotiationId: string;
  state: NegotiationState;
  initiatedAt: number;
  completedAt: number | null;
  requestedStreams: number[];
  acceptedStreams: number[];
  failureReason: string | null;
  /** Number of ICE candidates exchanged. */
  iceCandidateCount: number;
  /** Measured RTT from connectivity check. */
  rttMs: number | null;
}

// ============================================================================
// WebRTC transport configuration
// ============================================================================

export interface WebRTCTransportConfig {
  /** ICE servers for STUN/TURN. */
  iceServers: RTCIceServerConfig[];
  /** Timeout for the entire negotiation process (ms). Default: 10000. */
  negotiationTimeoutMs: number;
  /** Timeout for ICE gathering specifically (ms). Default: 5000. */
  iceGatheringTimeoutMs: number;
  /** Preferred audio codec. Default: "opus". */
  preferredAudioCodec: string;
  /** Max retries before permanent fallback to WebSocket. Default: 2. */
  maxRetries: number;
  /** Whether to use trickle ICE. Default: true. */
  trickleIce: boolean;
  /** SCTP data channel label for control messages. Default: "control". */
  dataChannelLabel: string;
  /** SCTP data channel ordered mode. Default: true (reliable ordered). */
  dataChannelOrdered: boolean;
}

export interface RTCIceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export const DEFAULT_WEBRTC_CONFIG: WebRTCTransportConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  negotiationTimeoutMs: 10_000,
  iceGatheringTimeoutMs: 5_000,
  preferredAudioCodec: "opus",
  maxRetries: 2,
  trickleIce: true,
  dataChannelLabel: "control",
  dataChannelOrdered: true,
};

// ============================================================================
// Transport statistics
// ============================================================================

export interface WebRTCTransportStats {
  /** Current negotiation state. */
  negotiationState: NegotiationState;
  /** Number of completed negotiations (success). */
  successfulNegotiations: number;
  /** Number of failed negotiations. */
  failedNegotiations: number;
  /** Streams currently on WebRTC. */
  webrtcStreams: number[];
  /** Streams currently on WebSocket. */
  websocketStreams: number[];
  /** Last measured RTT (ms) from ICE. */
  lastRttMs: number | null;
  /** Total bytes sent over WebRTC data channel. */
  dataChannelBytesSent: number;
  /** Total bytes received over WebRTC data channel. */
  dataChannelBytesReceived: number;
  /** Total audio frames sent over WebRTC media track. */
  audioFramesSent: number;
  /** Total audio frames received over WebRTC media track. */
  audioFramesReceived: number;
}

export const INITIAL_WEBRTC_STATS: WebRTCTransportStats = {
  negotiationState: NegotiationState.IDLE,
  successfulNegotiations: 0,
  failedNegotiations: 0,
  webrtcStreams: [],
  websocketStreams: [],
  lastRttMs: null,
  dataChannelBytesSent: 0,
  dataChannelBytesReceived: 0,
  audioFramesSent: 0,
  audioFramesReceived: 0,
};
