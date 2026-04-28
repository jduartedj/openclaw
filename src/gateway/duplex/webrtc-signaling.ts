/**
 * WebRTC signaling handler — Phase D.4.
 *
 * Manages SDP offer/answer exchange and ICE candidate trickle over
 * the existing WebSocket multiplex control channel (streamId 0).
 *
 * Pure module: no timers, no I/O. Caller bridges WebSocket.
 * Clock injection via `now` option for deterministic testing.
 *
 * Lifecycle:
 *   1. Initiator calls `createOffer()` → gets SDP offer
 *   2. Offer sent to peer via WS control channel
 *   3. Peer calls `handleOffer()` → gets SDP answer
 *   4. Answer sent back via WS control channel
 *   5. ICE candidates trickled via `addIceCandidate()` / `onIceCandidate`
 *   6. When ICE gathering completes on both sides → connection ready
 */

import {
  NegotiationState,
  type SdpOfferMessage,
  type SdpAnswerMessage,
  type IceCandidateMessage,
  type IceGatheringCompleteMessage,
  type WebRTCSignalingMessage,
  type NegotiationRecord,
} from "./webrtc-types.js";

export interface SignalingOptions {
  /** Send a signaling message to the peer via WS control channel. */
  sendSignaling: (msg: WebRTCSignalingMessage) => void;
  /** Called when signaling completes successfully (both SDPs exchanged + ICE done). */
  onSignalingComplete?: (record: NegotiationRecord) => void;
  /** Called when signaling fails. */
  onSignalingFailed?: (negotiationId: string, reason: string) => void;
  /** Clock injection. */
  now?: () => number;
}

let negotiationSeq = 0;
function nextNegotiationId(): string {
  return `neg_${++negotiationSeq}_${Date.now().toString(36)}`;
}
/** @internal Test helper to reset sequence counter. */
export function _resetNegotiationSeq(): void {
  negotiationSeq = 0;
}

export class SignalingError extends Error {
  readonly code: "INVALID_STATE" | "INVALID_MESSAGE" | "NEGOTIATION_MISMATCH" | "DUPLICATE_OFFER";
  readonly negotiationId: string | null;
  constructor(
    code: SignalingError["code"],
    negotiationId: string | null,
    message: string,
  ) {
    super(`[webrtc-signaling:${code}] ${message}`);
    this.name = "SignalingError";
    this.code = code;
    this.negotiationId = negotiationId;
  }
}

export class WebRTCSignaling {
  private readonly sendSignaling: SignalingOptions["sendSignaling"];
  private readonly onSignalingComplete?: SignalingOptions["onSignalingComplete"];
  private readonly onSignalingFailed?: SignalingOptions["onSignalingFailed"];
  private readonly clock: () => number;

  private _state: NegotiationState = NegotiationState.IDLE;
  private _currentNegotiationId: string | null = null;
  private _localSdp: string | null = null;
  private _remoteSdp: string | null = null;
  private _iceCandidates: IceCandidateMessage[] = [];
  private _remoteIceCandidates: IceCandidateMessage[] = [];
  private _localIceComplete = false;
  private _remoteIceComplete = false;
  private _requestedStreams: number[] = [];
  private _acceptedStreams: number[] = [];

  private _records: NegotiationRecord[] = [];
  private _successCount = 0;
  private _failCount = 0;

  constructor(options: SignalingOptions) {
    this.sendSignaling = options.sendSignaling;
    this.onSignalingComplete = options.onSignalingComplete;
    this.onSignalingFailed = options.onSignalingFailed;
    this.clock = options.now ?? (() => Date.now());
  }

  get state(): NegotiationState {
    return this._state;
  }

  get currentNegotiationId(): string | null {
    return this._currentNegotiationId;
  }

  get localSdp(): string | null {
    return this._localSdp;
  }

  get remoteSdp(): string | null {
    return this._remoteSdp;
  }

  get iceCandidates(): readonly IceCandidateMessage[] {
    return this._iceCandidates;
  }

  get remoteIceCandidates(): readonly IceCandidateMessage[] {
    return this._remoteIceCandidates;
  }

  get records(): readonly NegotiationRecord[] {
    return this._records;
  }

  get stats() {
    return {
      successfulNegotiations: this._successCount,
      failedNegotiations: this._failCount,
      totalIceCandidates: this._iceCandidates.length,
      totalRemoteIceCandidates: this._remoteIceCandidates.length,
    };
  }

  // =========================================================================
  // Offer / answer
  // =========================================================================

  /**
   * Create an SDP offer and send it to the peer.
   * Only valid from IDLE state.
   */
  createOffer(sdp: string, requestedStreams: number[] = []): SdpOfferMessage {
    if (this._state !== NegotiationState.IDLE) {
      throw new SignalingError(
        "INVALID_STATE",
        this._currentNegotiationId,
        `cannot create offer in state "${this._state}" (expected "idle")`,
      );
    }

    const negotiationId = nextNegotiationId();
    this._currentNegotiationId = negotiationId;
    this._localSdp = sdp;
    this._requestedStreams = [...requestedStreams];
    this._state = NegotiationState.SIGNALING;

    const offer: SdpOfferMessage = {
      type: "webrtc.sdp.offer",
      sdp,
      negotiationId,
      ...(requestedStreams.length > 0 ? { requestedStreams } : {}),
    };

    this._records.push(this.createRecord(negotiationId));

    try {
      this.sendSignaling(offer);
    } catch {
      /* best-effort — peer may handle via other means */
    }

    return offer;
  }

  /**
   * Handle an incoming SDP offer from the peer. Returns the offer for
   * the caller to process (create an answer from it).
   * Only valid from IDLE state.
   */
  handleOffer(offer: SdpOfferMessage): SdpOfferMessage {
    if (this._state !== NegotiationState.IDLE) {
      throw new SignalingError(
        "DUPLICATE_OFFER",
        this._currentNegotiationId,
        `received offer while in state "${this._state}"`,
      );
    }

    this._currentNegotiationId = offer.negotiationId;
    this._remoteSdp = offer.sdp;
    this._requestedStreams = offer.requestedStreams ? [...offer.requestedStreams] : [];
    this._state = NegotiationState.SIGNALING;

    this._records.push(this.createRecord(offer.negotiationId));

    return offer;
  }

  /**
   * Create an SDP answer and send it to the peer.
   * Only valid from SIGNALING state after receiving an offer.
   */
  createAnswer(sdp: string, acceptedStreams: number[] = []): SdpAnswerMessage {
    if (this._state !== NegotiationState.SIGNALING) {
      throw new SignalingError(
        "INVALID_STATE",
        this._currentNegotiationId,
        `cannot create answer in state "${this._state}" (expected "signaling")`,
      );
    }
    if (this._remoteSdp === null) {
      throw new SignalingError(
        "INVALID_STATE",
        this._currentNegotiationId,
        "cannot create answer without having received an offer first",
      );
    }

    this._localSdp = sdp;
    this._acceptedStreams = [...acceptedStreams];
    this._state = NegotiationState.ICE_GATHERING;

    const answer: SdpAnswerMessage = {
      type: "webrtc.sdp.answer",
      sdp,
      negotiationId: this._currentNegotiationId!,
      ...(acceptedStreams.length > 0 ? { acceptedStreams } : {}),
    };

    this.updateCurrentRecord((r) => {
      r.acceptedStreams = [...acceptedStreams];
    });

    try {
      this.sendSignaling(answer);
    } catch {
      /* best-effort */
    }

    return answer;
  }

  /**
   * Handle an incoming SDP answer from the peer.
   * Only valid from SIGNALING state after sending an offer.
   */
  handleAnswer(answer: SdpAnswerMessage): SdpAnswerMessage {
    if (this._state !== NegotiationState.SIGNALING) {
      throw new SignalingError(
        "INVALID_STATE",
        this._currentNegotiationId,
        `cannot handle answer in state "${this._state}" (expected "signaling")`,
      );
    }
    if (answer.negotiationId !== this._currentNegotiationId) {
      throw new SignalingError(
        "NEGOTIATION_MISMATCH",
        this._currentNegotiationId,
        `answer negotiationId "${answer.negotiationId}" does not match current "${this._currentNegotiationId}"`,
      );
    }

    this._remoteSdp = answer.sdp;
    this._acceptedStreams = answer.acceptedStreams ? [...answer.acceptedStreams] : [];
    this._state = NegotiationState.ICE_GATHERING;

    this.updateCurrentRecord((r) => {
      r.acceptedStreams = [...this._acceptedStreams];
    });

    return answer;
  }

  // =========================================================================
  // ICE candidate exchange
  // =========================================================================

  /**
   * Add a local ICE candidate and send it to the peer.
   */
  addLocalIceCandidate(candidate: string, sdpMid: string | null, sdpMLineIndex: number | null): IceCandidateMessage {
    if (this._state !== NegotiationState.ICE_GATHERING && this._state !== NegotiationState.SIGNALING) {
      throw new SignalingError(
        "INVALID_STATE",
        this._currentNegotiationId,
        `cannot add ICE candidate in state "${this._state}"`,
      );
    }

    const msg: IceCandidateMessage = {
      type: "webrtc.ice.candidate",
      candidate,
      sdpMid,
      sdpMLineIndex,
      negotiationId: this._currentNegotiationId!,
    };

    this._iceCandidates.push(msg);
    this.updateCurrentRecord((r) => {
      r.iceCandidateCount++;
    });

    try {
      this.sendSignaling(msg);
    } catch {
      /* best-effort */
    }

    return msg;
  }

  /**
   * Handle an incoming ICE candidate from the peer.
   */
  addRemoteIceCandidate(msg: IceCandidateMessage): IceCandidateMessage {
    if (
      this._state !== NegotiationState.ICE_GATHERING &&
      this._state !== NegotiationState.SIGNALING &&
      this._state !== NegotiationState.CONNECTING
    ) {
      throw new SignalingError(
        "INVALID_STATE",
        this._currentNegotiationId,
        `cannot add remote ICE candidate in state "${this._state}"`,
      );
    }
    if (msg.negotiationId !== this._currentNegotiationId) {
      throw new SignalingError(
        "NEGOTIATION_MISMATCH",
        this._currentNegotiationId,
        `ICE candidate negotiationId "${msg.negotiationId}" does not match current "${this._currentNegotiationId}"`,
      );
    }

    this._remoteIceCandidates.push(msg);
    this.updateCurrentRecord((r) => {
      r.iceCandidateCount++;
    });

    return msg;
  }

  /**
   * Mark local ICE gathering as complete and notify the peer.
   */
  completeLocalIceGathering(): IceGatheringCompleteMessage {
    if (this._state !== NegotiationState.ICE_GATHERING) {
      throw new SignalingError(
        "INVALID_STATE",
        this._currentNegotiationId,
        `cannot complete ICE gathering in state "${this._state}" (expected "ice_gathering")`,
      );
    }

    this._localIceComplete = true;

    const msg: IceGatheringCompleteMessage = {
      type: "webrtc.ice.complete",
      negotiationId: this._currentNegotiationId!,
    };

    try {
      this.sendSignaling(msg);
    } catch {
      /* best-effort */
    }

    this.checkIceComplete();
    return msg;
  }

  /**
   * Handle remote ICE gathering complete notification.
   */
  handleRemoteIceComplete(msg: IceGatheringCompleteMessage): void {
    if (msg.negotiationId !== this._currentNegotiationId) {
      throw new SignalingError(
        "NEGOTIATION_MISMATCH",
        this._currentNegotiationId,
        `ICE complete negotiationId "${msg.negotiationId}" does not match current "${this._currentNegotiationId}"`,
      );
    }

    this._remoteIceComplete = true;
    this.checkIceComplete();
  }

  // =========================================================================
  // Failure handling
  // =========================================================================

  /**
   * Mark the current negotiation as failed and reset state.
   */
  fail(reason: string): void {
    const negId = this._currentNegotiationId;
    if (negId) {
      this.updateCurrentRecord((r) => {
        r.state = NegotiationState.FAILED;
        r.completedAt = this.clock();
        r.failureReason = reason;
      });
    }

    this._failCount++;
    this._state = NegotiationState.FAILED;

    try {
      this.onSignalingFailed?.(negId ?? "unknown", reason);
    } catch {
      /* swallow */
    }

    this.resetNegotiationState();
  }

  /**
   * Mark the current negotiation as successfully completed.
   * Called when DTLS/SCTP handshake succeeds and transport is ready.
   */
  complete(rttMs?: number): void {
    const negId = this._currentNegotiationId;
    if (!negId) return;

    this.updateCurrentRecord((r) => {
      r.state = NegotiationState.ACTIVE;
      r.completedAt = this.clock();
      r.rttMs = rttMs ?? null;
    });

    this._successCount++;
    this._state = NegotiationState.ACTIVE;

    const record = this._records.find((r) => r.negotiationId === negId);
    if (record) {
      try {
        this.onSignalingComplete?.(record);
      } catch {
        /* swallow */
      }
    }
  }

  /**
   * Reset the signaling handler to IDLE for a new negotiation round.
   */
  reset(): void {
    this.resetNegotiationState();
    this._state = NegotiationState.IDLE;
  }

  // =========================================================================
  // Handle incoming signaling message (dispatcher)
  // =========================================================================

  /**
   * Process an incoming WebRTC signaling message. Routes to the appropriate handler.
   * Returns the handled message or throws on error.
   */
  handleMessage(msg: WebRTCSignalingMessage): WebRTCSignalingMessage {
    switch (msg.type) {
      case "webrtc.sdp.offer":
        return this.handleOffer(msg);
      case "webrtc.sdp.answer":
        return this.handleAnswer(msg);
      case "webrtc.ice.candidate":
        return this.addRemoteIceCandidate(msg);
      case "webrtc.ice.complete":
        this.handleRemoteIceComplete(msg);
        return msg;
      default:
        throw new SignalingError(
          "INVALID_MESSAGE",
          this._currentNegotiationId,
          `signaling handler does not handle message type "${(msg as { type: string }).type}"`,
        );
    }
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private checkIceComplete(): void {
    if (this._localIceComplete && this._remoteIceComplete) {
      this._state = NegotiationState.CONNECTING;
      this.updateCurrentRecord((r) => {
        r.state = NegotiationState.CONNECTING;
      });
    }
  }

  private createRecord(negotiationId: string): NegotiationRecord {
    return {
      negotiationId,
      state: NegotiationState.SIGNALING,
      initiatedAt: this.clock(),
      completedAt: null,
      requestedStreams: [...this._requestedStreams],
      acceptedStreams: [],
      failureReason: null,
      iceCandidateCount: 0,
      rttMs: null,
    };
  }

  private updateCurrentRecord(updater: (record: NegotiationRecord) => void): void {
    if (!this._currentNegotiationId) return;
    const record = this._records.find((r) => r.negotiationId === this._currentNegotiationId);
    if (record) updater(record);
  }

  private resetNegotiationState(): void {
    this._currentNegotiationId = null;
    this._localSdp = null;
    this._remoteSdp = null;
    this._iceCandidates = [];
    this._remoteIceCandidates = [];
    this._localIceComplete = false;
    this._remoteIceComplete = false;
    this._requestedStreams = [];
    this._acceptedStreams = [];
    // State set by caller (fail/reset)
  }
}
