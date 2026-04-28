import { describe, expect, it, vi, beforeEach } from "vitest";
import { WebRTCSignaling, SignalingError, _resetNegotiationSeq } from "./webrtc-signaling.js";
import { NegotiationState } from "./webrtc-types.js";
import type {
  SdpOfferMessage,
  SdpAnswerMessage,
  IceCandidateMessage,
  IceGatheringCompleteMessage,
  WebRTCSignalingMessage,
  NegotiationRecord,
} from "./webrtc-types.js";

describe("WebRTCSignaling", () => {
  let signaling: WebRTCSignaling;
  let sentMessages: WebRTCSignalingMessage[];
  let now: number;
  let clock: () => number;
  let onComplete: ReturnType<typeof vi.fn>;
  let onFailed: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetNegotiationSeq();
    now = 1000;
    clock = () => now;
    sentMessages = [];
    onComplete = vi.fn();
    onFailed = vi.fn();
    signaling = new WebRTCSignaling({
      sendSignaling: (msg) => sentMessages.push(msg),
      onSignalingComplete: onComplete,
      onSignalingFailed: onFailed,
      now: clock,
    });
  });

  // =========================================================================
  // Initial state
  // =========================================================================

  describe("initial state", () => {
    it("starts in IDLE state", () => {
      expect(signaling.state).toBe(NegotiationState.IDLE);
    });

    it("has no current negotiation", () => {
      expect(signaling.currentNegotiationId).toBeNull();
    });

    it("has no SDP", () => {
      expect(signaling.localSdp).toBeNull();
      expect(signaling.remoteSdp).toBeNull();
    });

    it("has empty candidate lists", () => {
      expect(signaling.iceCandidates).toHaveLength(0);
      expect(signaling.remoteIceCandidates).toHaveLength(0);
    });

    it("has zero stats", () => {
      expect(signaling.stats).toEqual({
        successfulNegotiations: 0,
        failedNegotiations: 0,
        totalIceCandidates: 0,
        totalRemoteIceCandidates: 0,
      });
    });
  });

  // =========================================================================
  // Offer creation (initiator)
  // =========================================================================

  describe("createOffer", () => {
    it("creates an offer and transitions to SIGNALING", () => {
      const offer = signaling.createOffer("v=0\r\no=- sdp offer");
      expect(signaling.state).toBe(NegotiationState.SIGNALING);
      expect(offer.type).toBe("webrtc.sdp.offer");
      expect(offer.sdp).toBe("v=0\r\no=- sdp offer");
      expect(offer.negotiationId).toBeTruthy();
    });

    it("sends the offer via signaling callback", () => {
      signaling.createOffer("sdp-offer");
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]!.type).toBe("webrtc.sdp.offer");
    });

    it("stores local SDP", () => {
      signaling.createOffer("sdp-offer");
      expect(signaling.localSdp).toBe("sdp-offer");
    });

    it("sets current negotiation ID", () => {
      const offer = signaling.createOffer("sdp");
      expect(signaling.currentNegotiationId).toBe(offer.negotiationId);
    });

    it("includes requestedStreams when provided", () => {
      const offer = signaling.createOffer("sdp", [1, 2]);
      expect(offer.requestedStreams).toEqual([1, 2]);
    });

    it("omits requestedStreams when empty", () => {
      const offer = signaling.createOffer("sdp");
      expect(offer.requestedStreams).toBeUndefined();
    });

    it("creates a negotiation record", () => {
      signaling.createOffer("sdp", [1, 2]);
      expect(signaling.records).toHaveLength(1);
      expect(signaling.records[0]!.state).toBe(NegotiationState.SIGNALING);
      expect(signaling.records[0]!.requestedStreams).toEqual([1, 2]);
    });

    it("throws if not in IDLE state", () => {
      signaling.createOffer("sdp");
      expect(() => signaling.createOffer("sdp2")).toThrow(SignalingError);
      try {
        signaling.createOffer("sdp2");
      } catch (e: unknown) {
        expect((e as SignalingError).code).toBe("INVALID_STATE");
      }
    });

    it("survives sendSignaling throwing", () => {
      const brokenSignaling = new WebRTCSignaling({
        sendSignaling: () => { throw new Error("send failed"); },
        now: clock,
      });
      expect(() => brokenSignaling.createOffer("sdp")).not.toThrow();
      expect(brokenSignaling.state).toBe(NegotiationState.SIGNALING);
    });
  });

  // =========================================================================
  // Handle incoming offer (answerer)
  // =========================================================================

  describe("handleOffer", () => {
    it("handles an offer and transitions to SIGNALING", () => {
      const offer: SdpOfferMessage = {
        type: "webrtc.sdp.offer",
        sdp: "remote-sdp",
        negotiationId: "neg_remote_1",
      };
      signaling.handleOffer(offer);
      expect(signaling.state).toBe(NegotiationState.SIGNALING);
      expect(signaling.remoteSdp).toBe("remote-sdp");
      expect(signaling.currentNegotiationId).toBe("neg_remote_1");
    });

    it("creates a record for the incoming negotiation", () => {
      signaling.handleOffer({
        type: "webrtc.sdp.offer",
        sdp: "sdp",
        negotiationId: "neg_1",
        requestedStreams: [0, 1],
      });
      expect(signaling.records).toHaveLength(1);
      expect(signaling.records[0]!.requestedStreams).toEqual([0, 1]);
    });

    it("throws DUPLICATE_OFFER if already in SIGNALING", () => {
      signaling.handleOffer({
        type: "webrtc.sdp.offer",
        sdp: "sdp1",
        negotiationId: "neg_1",
      });
      expect(() =>
        signaling.handleOffer({
          type: "webrtc.sdp.offer",
          sdp: "sdp2",
          negotiationId: "neg_2",
        }),
      ).toThrow(SignalingError);
    });
  });

  // =========================================================================
  // Answer creation & handling
  // =========================================================================

  describe("createAnswer", () => {
    beforeEach(() => {
      signaling.handleOffer({
        type: "webrtc.sdp.offer",
        sdp: "remote-sdp",
        negotiationId: "neg_1",
      });
    });

    it("creates an answer and transitions to ICE_GATHERING", () => {
      const answer = signaling.createAnswer("local-answer-sdp", [1, 2]);
      expect(signaling.state).toBe(NegotiationState.ICE_GATHERING);
      expect(answer.type).toBe("webrtc.sdp.answer");
      expect(answer.sdp).toBe("local-answer-sdp");
      expect(answer.negotiationId).toBe("neg_1");
      expect(answer.acceptedStreams).toEqual([1, 2]);
    });

    it("sends the answer via signaling callback", () => {
      signaling.createAnswer("answer-sdp");
      // handleOffer doesn't send; createAnswer does
      expect(sentMessages.some((m) => m.type === "webrtc.sdp.answer")).toBe(true);
    });

    it("stores local SDP", () => {
      signaling.createAnswer("answer-sdp");
      expect(signaling.localSdp).toBe("answer-sdp");
    });

    it("throws if not in SIGNALING state", () => {
      signaling.createAnswer("sdp"); // now ICE_GATHERING
      expect(() => signaling.createAnswer("sdp2")).toThrow(SignalingError);
    });

    it("throws if no offer was received", () => {
      const fresh = new WebRTCSignaling({
        sendSignaling: () => {},
        now: clock,
      });
      fresh.createOffer("offer-sdp"); // we sent an offer, but no remote SDP
      expect(() => fresh.createAnswer("answer-sdp")).toThrow(SignalingError);
    });
  });

  describe("handleAnswer", () => {
    it("handles an answer and transitions to ICE_GATHERING", () => {
      const offer = signaling.createOffer("offer-sdp");
      const answer: SdpAnswerMessage = {
        type: "webrtc.sdp.answer",
        sdp: "remote-answer",
        negotiationId: offer.negotiationId,
        acceptedStreams: [0, 1, 2],
      };
      signaling.handleAnswer(answer);
      expect(signaling.state).toBe(NegotiationState.ICE_GATHERING);
      expect(signaling.remoteSdp).toBe("remote-answer");
    });

    it("throws NEGOTIATION_MISMATCH for wrong negotiationId", () => {
      signaling.createOffer("sdp");
      expect(() =>
        signaling.handleAnswer({
          type: "webrtc.sdp.answer",
          sdp: "answer",
          negotiationId: "wrong_id",
        }),
      ).toThrow(SignalingError);
      try {
        signaling.handleAnswer({
          type: "webrtc.sdp.answer",
          sdp: "answer",
          negotiationId: "wrong_id",
        });
      } catch (e: unknown) {
        expect((e as SignalingError).code).toBe("NEGOTIATION_MISMATCH");
      }
    });

    it("throws if not in SIGNALING state", () => {
      expect(() =>
        signaling.handleAnswer({
          type: "webrtc.sdp.answer",
          sdp: "answer",
          negotiationId: "neg_1",
        }),
      ).toThrow(SignalingError);
    });
  });

  // =========================================================================
  // ICE candidate exchange
  // =========================================================================

  describe("ICE candidates", () => {
    beforeEach(() => {
      signaling.handleOffer({
        type: "webrtc.sdp.offer",
        sdp: "remote-sdp",
        negotiationId: "neg_1",
      });
      signaling.createAnswer("local-answer");
    });

    it("addLocalIceCandidate sends candidate to peer", () => {
      signaling.addLocalIceCandidate("candidate:1", "0", 0);
      expect(sentMessages.some((m) => m.type === "webrtc.ice.candidate")).toBe(true);
      expect(signaling.iceCandidates).toHaveLength(1);
    });

    it("addRemoteIceCandidate stores remote candidate", () => {
      const candidateMsg: IceCandidateMessage = {
        type: "webrtc.ice.candidate",
        candidate: "candidate:remote",
        sdpMid: "0",
        sdpMLineIndex: 0,
        negotiationId: "neg_1",
      };
      signaling.addRemoteIceCandidate(candidateMsg);
      expect(signaling.remoteIceCandidates).toHaveLength(1);
    });

    it("addRemoteIceCandidate throws for wrong negotiationId", () => {
      expect(() =>
        signaling.addRemoteIceCandidate({
          type: "webrtc.ice.candidate",
          candidate: "candidate:1",
          sdpMid: "0",
          sdpMLineIndex: 0,
          negotiationId: "wrong_neg",
        }),
      ).toThrow(SignalingError);
    });

    it("updates record iceCandidateCount", () => {
      signaling.addLocalIceCandidate("c1", "0", 0);
      signaling.addLocalIceCandidate("c2", "0", 0);
      signaling.addRemoteIceCandidate({
        type: "webrtc.ice.candidate",
        candidate: "c3",
        sdpMid: "0",
        sdpMLineIndex: 0,
        negotiationId: "neg_1",
      });
      expect(signaling.records[0]!.iceCandidateCount).toBe(3);
    });

    it("throws when adding candidate in IDLE state", () => {
      const fresh = new WebRTCSignaling({
        sendSignaling: () => {},
        now: clock,
      });
      expect(() => fresh.addLocalIceCandidate("c1", "0", 0)).toThrow(SignalingError);
    });
  });

  // =========================================================================
  // ICE gathering complete
  // =========================================================================

  describe("ICE gathering complete", () => {
    beforeEach(() => {
      signaling.handleOffer({
        type: "webrtc.sdp.offer",
        sdp: "remote-sdp",
        negotiationId: "neg_1",
      });
      signaling.createAnswer("local-answer");
    });

    it("completeLocalIceGathering sends complete message", () => {
      signaling.completeLocalIceGathering();
      expect(sentMessages.some((m) => m.type === "webrtc.ice.complete")).toBe(true);
    });

    it("transitions to CONNECTING when both sides complete", () => {
      signaling.completeLocalIceGathering();
      expect(signaling.state).toBe(NegotiationState.ICE_GATHERING); // Only local done

      signaling.handleRemoteIceComplete({
        type: "webrtc.ice.complete",
        negotiationId: "neg_1",
      });
      expect(signaling.state).toBe(NegotiationState.CONNECTING);
    });

    it("transitions to CONNECTING when remote completes first", () => {
      signaling.handleRemoteIceComplete({
        type: "webrtc.ice.complete",
        negotiationId: "neg_1",
      });
      expect(signaling.state).toBe(NegotiationState.ICE_GATHERING);

      signaling.completeLocalIceGathering();
      expect(signaling.state).toBe(NegotiationState.CONNECTING);
    });

    it("handleRemoteIceComplete throws for wrong negotiationId", () => {
      expect(() =>
        signaling.handleRemoteIceComplete({
          type: "webrtc.ice.complete",
          negotiationId: "wrong_neg",
        }),
      ).toThrow(SignalingError);
    });

    it("throws if completing ICE in wrong state", () => {
      const fresh = new WebRTCSignaling({
        sendSignaling: () => {},
        now: clock,
      });
      expect(() => fresh.completeLocalIceGathering()).toThrow(SignalingError);
    });
  });

  // =========================================================================
  // Complete & fail
  // =========================================================================

  describe("complete", () => {
    it("marks negotiation as ACTIVE", () => {
      signaling.handleOffer({
        type: "webrtc.sdp.offer",
        sdp: "sdp",
        negotiationId: "neg_1",
      });
      signaling.createAnswer("answer");
      signaling.completeLocalIceGathering();
      signaling.handleRemoteIceComplete({
        type: "webrtc.ice.complete",
        negotiationId: "neg_1",
      });
      signaling.complete(42);
      expect(signaling.state).toBe(NegotiationState.ACTIVE);
      expect(signaling.stats.successfulNegotiations).toBe(1);
      expect(signaling.records[0]!.rttMs).toBe(42);
    });

    it("calls onSignalingComplete callback", () => {
      signaling.handleOffer({
        type: "webrtc.sdp.offer",
        sdp: "sdp",
        negotiationId: "neg_1",
      });
      signaling.createAnswer("answer");
      signaling.complete();
      expect(onComplete).toHaveBeenCalledTimes(1);
    });
  });

  describe("fail", () => {
    it("marks negotiation as FAILED", () => {
      signaling.handleOffer({
        type: "webrtc.sdp.offer",
        sdp: "sdp",
        negotiationId: "neg_1",
      });
      signaling.fail("ICE timeout");
      expect(signaling.state).toBe(NegotiationState.FAILED);
      expect(signaling.stats.failedNegotiations).toBe(1);
    });

    it("calls onSignalingFailed callback", () => {
      signaling.handleOffer({
        type: "webrtc.sdp.offer",
        sdp: "sdp",
        negotiationId: "neg_1",
      });
      signaling.fail("timeout");
      expect(onFailed).toHaveBeenCalledWith("neg_1", "timeout");
    });

    it("resets internal state after failure", () => {
      signaling.handleOffer({
        type: "webrtc.sdp.offer",
        sdp: "sdp",
        negotiationId: "neg_1",
      });
      signaling.fail("error");
      expect(signaling.currentNegotiationId).toBeNull();
      expect(signaling.localSdp).toBeNull();
      expect(signaling.remoteSdp).toBeNull();
    });

    it("survives callback throwing", () => {
      const s = new WebRTCSignaling({
        sendSignaling: () => {},
        onSignalingFailed: () => { throw new Error("boom"); },
        now: clock,
      });
      s.handleOffer({ type: "webrtc.sdp.offer", sdp: "s", negotiationId: "n1" });
      expect(() => s.fail("test")).not.toThrow();
    });
  });

  // =========================================================================
  // Reset
  // =========================================================================

  describe("reset", () => {
    it("resets to IDLE for a new round", () => {
      signaling.handleOffer({
        type: "webrtc.sdp.offer",
        sdp: "sdp",
        negotiationId: "neg_1",
      });
      signaling.reset();
      expect(signaling.state).toBe(NegotiationState.IDLE);
      expect(signaling.currentNegotiationId).toBeNull();
    });

    it("allows new negotiation after reset", () => {
      signaling.createOffer("sdp1");
      signaling.reset();
      expect(() => signaling.createOffer("sdp2")).not.toThrow();
      expect(signaling.state).toBe(NegotiationState.SIGNALING);
    });
  });

  // =========================================================================
  // handleMessage dispatcher
  // =========================================================================

  describe("handleMessage", () => {
    it("routes SDP offer", () => {
      signaling.handleMessage({
        type: "webrtc.sdp.offer",
        sdp: "offer-sdp",
        negotiationId: "neg_1",
      });
      expect(signaling.state).toBe(NegotiationState.SIGNALING);
      expect(signaling.remoteSdp).toBe("offer-sdp");
    });

    it("routes SDP answer", () => {
      const offer = signaling.createOffer("offer-sdp");
      signaling.handleMessage({
        type: "webrtc.sdp.answer",
        sdp: "answer-sdp",
        negotiationId: offer.negotiationId,
      });
      expect(signaling.state).toBe(NegotiationState.ICE_GATHERING);
    });

    it("routes ICE candidate", () => {
      signaling.handleOffer({
        type: "webrtc.sdp.offer",
        sdp: "sdp",
        negotiationId: "neg_1",
      });
      signaling.createAnswer("answer");
      signaling.handleMessage({
        type: "webrtc.ice.candidate",
        candidate: "c1",
        sdpMid: "0",
        sdpMLineIndex: 0,
        negotiationId: "neg_1",
      });
      expect(signaling.remoteIceCandidates).toHaveLength(1);
    });

    it("routes ICE complete", () => {
      signaling.handleOffer({
        type: "webrtc.sdp.offer",
        sdp: "sdp",
        negotiationId: "neg_1",
      });
      signaling.createAnswer("answer");
      signaling.completeLocalIceGathering();
      signaling.handleMessage({
        type: "webrtc.ice.complete",
        negotiationId: "neg_1",
      });
      expect(signaling.state).toBe(NegotiationState.CONNECTING);
    });

    it("throws for non-signaling message types", () => {
      expect(() =>
        signaling.handleMessage({
          type: "webrtc.upgrade.request" as any,
          negotiationId: "neg_1",
        } as any),
      ).toThrow(SignalingError);
    });
  });

  // =========================================================================
  // Full negotiation flow
  // =========================================================================

  describe("full negotiation flow", () => {
    it("completes a full offer → answer → ICE → complete cycle", () => {
      // Answerer side
      const answerer = signaling;
      const offerer = new WebRTCSignaling({
        sendSignaling: (msg) => sentMessages.push(msg),
        now: clock,
      });

      // 1. Offerer creates offer
      const offer = offerer.createOffer("offerer-sdp", [1, 2]);
      expect(offerer.state).toBe(NegotiationState.SIGNALING);

      // 2. Answerer handles offer
      answerer.handleOffer(offer);
      expect(answerer.state).toBe(NegotiationState.SIGNALING);

      // 3. Answerer creates answer
      const answer = answerer.createAnswer("answerer-sdp", [1, 2]);
      expect(answerer.state).toBe(NegotiationState.ICE_GATHERING);

      // 4. Offerer handles answer
      offerer.handleAnswer(answer);
      expect(offerer.state).toBe(NegotiationState.ICE_GATHERING);

      // 5. Exchange ICE candidates
      const offererCandidate = offerer.addLocalIceCandidate("c:offerer", "0", 0);
      answerer.addRemoteIceCandidate(offererCandidate);

      const answererCandidate = answerer.addLocalIceCandidate("c:answerer", "0", 0);
      // Manually adjust negotiation ID for offerer
      offerer.addRemoteIceCandidate({
        ...answererCandidate,
        negotiationId: offer.negotiationId,
      });

      // 6. ICE gathering complete
      offerer.completeLocalIceGathering();
      answerer.completeLocalIceGathering();

      offerer.handleRemoteIceComplete({
        type: "webrtc.ice.complete",
        negotiationId: offer.negotiationId,
      });
      answerer.handleRemoteIceComplete({
        type: "webrtc.ice.complete",
        negotiationId: offer.negotiationId,
      });

      expect(offerer.state).toBe(NegotiationState.CONNECTING);
      expect(answerer.state).toBe(NegotiationState.CONNECTING);

      // 7. Complete
      offerer.complete(15);
      answerer.complete(15);

      expect(offerer.state).toBe(NegotiationState.ACTIVE);
      expect(answerer.state).toBe(NegotiationState.ACTIVE);
      expect(offerer.stats.successfulNegotiations).toBe(1);
    });

    it("handles failure mid-negotiation gracefully", () => {
      signaling.createOffer("sdp");
      expect(signaling.state).toBe(NegotiationState.SIGNALING);

      signaling.fail("network error");
      expect(signaling.state).toBe(NegotiationState.FAILED);
      expect(signaling.stats.failedNegotiations).toBe(1);
      expect(signaling.records[0]!.failureReason).toBe("network error");
    });
  });

  // =========================================================================
  // Clock injection
  // =========================================================================

  describe("clock injection", () => {
    it("uses injected clock for record timestamps", () => {
      now = 5000;
      signaling.createOffer("sdp");
      expect(signaling.records[0]!.initiatedAt).toBe(5000);
    });

    it("uses injected clock for completion timestamp", () => {
      signaling.handleOffer({
        type: "webrtc.sdp.offer",
        sdp: "sdp",
        negotiationId: "neg_1",
      });
      now = 9000;
      signaling.complete();
      expect(signaling.records[0]!.completedAt).toBe(9000);
    });
  });
});
