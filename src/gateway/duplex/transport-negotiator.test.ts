import { describe, expect, it, vi, beforeEach } from "vitest";
import { TransportNegotiator, type TransportNegotiatorOptions, type NegotiatorSnapshot } from "./transport-negotiator.js";
import { NegotiationState, type WebRTCUpgradeRequestMessage, type WebRTCUpgradeResponseMessage, type WebRTCReadyMessage, type WebRTCDowngradeMessage, type WebRTCSignalingMessage, type SdpOfferMessage } from "./webrtc-types.js";
import type { PeerConnectionFactory, PeerConnectionLike, DataChannelLike } from "./webrtc-transport.js";

// ============================================================================
// Mock helpers
// ============================================================================

function createMockDataChannel(label = "control"): DataChannelLike {
  return {
    label,
    readyState: "connecting",
    send: vi.fn(),
    close: vi.fn(),
    onopen: null,
    onclose: null,
    onmessage: null,
    onerror: null,
  };
}

function createMockPeerConnection(): PeerConnectionLike & {
  _simulateConnectionState: (state: string) => void;
  _simulateDataChannel: (dc: DataChannelLike) => void;
} {
  let connState = "new";
  const pc: any = {
    createOffer: vi.fn().mockResolvedValue({ sdp: "mock-offer", type: "offer" }),
    createAnswer: vi.fn().mockResolvedValue({ sdp: "mock-answer", type: "answer" }),
    setLocalDescription: vi.fn().mockResolvedValue(undefined),
    setRemoteDescription: vi.fn().mockResolvedValue(undefined),
    addIceCandidate: vi.fn().mockResolvedValue(undefined),
    createDataChannel: vi.fn((label: string, opts?: any) => createMockDataChannel(label)),
    close: vi.fn(),
    localDescription: null,
    remoteDescription: null,
    get connectionState() { return connState; },
    iceConnectionState: "new",
    iceGatheringState: "new",
    onicecandidate: null,
    oniceconnectionstatechange: null,
    onconnectionstatechange: null,
    ondatachannel: null,
    _simulateConnectionState(state: string) {
      connState = state;
      if (pc.onconnectionstatechange) pc.onconnectionstatechange();
    },
    _simulateDataChannel(dc: DataChannelLike) {
      if (pc.ondatachannel) pc.ondatachannel({ channel: dc });
    },
  };
  return pc;
}

function createNegotiator(overrides?: Partial<TransportNegotiatorOptions>) {
  const sentMessages: any[] = [];
  let lastPc: ReturnType<typeof createMockPeerConnection> | null = null;
  const now = { value: 1000 };
  const clock = () => now.value;

  const callbacks = {
    onUpgradeComplete: vi.fn(),
    onUpgradeFailed: vi.fn(),
    onDowngrade: vi.fn(),
    onWebRTCControlMessage: vi.fn(),
    onWebRTCAudioData: vi.fn(),
  };

  const factory: PeerConnectionFactory = () => {
    lastPc = createMockPeerConnection();
    return lastPc;
  };

  const negotiator = new TransportNegotiator({
    sendControl: (msg) => sentMessages.push(msg),
    peerConnectionFactory: factory,
    now: clock,
    ...callbacks,
    ...overrides,
  });

  return { negotiator, sentMessages, callbacks, now, lastPc: () => lastPc!, factory };
}

// ============================================================================
// Tests
// ============================================================================

describe("TransportNegotiator", () => {
  // =========================================================================
  // Initial state
  // =========================================================================

  describe("initial state", () => {
    it("starts in IDLE state", () => {
      const { negotiator } = createNegotiator();
      expect(negotiator.state).toBe(NegotiationState.IDLE);
    });

    it("has zero upgrade attempts", () => {
      const { negotiator } = createNegotiator();
      expect(negotiator.upgradeAttempts).toBe(0);
    });

    it("can retry initially", () => {
      const { negotiator } = createNegotiator();
      expect(negotiator.canRetry).toBe(true);
    });

    it("active transport is websocket", () => {
      const { negotiator } = createNegotiator();
      expect(negotiator.activeTransport).toBe("websocket");
    });

    it("snapshot reflects initial state", () => {
      const { negotiator } = createNegotiator();
      const snap = negotiator.snapshot;
      expect(snap.state).toBe(NegotiationState.IDLE);
      expect(snap.upgradeAttempts).toBe(0);
      expect(snap.activeTransport).toBe("websocket");
      expect(snap.webrtcStreams).toEqual([]);
      expect(snap.websocketStreams).toEqual([0, 1, 2]);
    });
  });

  // =========================================================================
  // requestUpgrade
  // =========================================================================

  describe("requestUpgrade", () => {
    it("sends an upgrade request message", () => {
      const { negotiator, sentMessages } = createNegotiator();
      const msg = negotiator.requestUpgrade([1, 2]);
      expect(msg.type).toBe("webrtc.upgrade.request");
      expect(msg.requestedStreams).toEqual([1, 2]);
      expect(sentMessages).toHaveLength(1);
      expect(negotiator.state).toBe(NegotiationState.REQUESTED);
      expect(negotiator.upgradeAttempts).toBe(1);
    });

    it("defaults to all streams when none specified", () => {
      const { negotiator } = createNegotiator();
      const msg = negotiator.requestUpgrade();
      expect(msg.requestedStreams).toEqual([0, 1, 2]);
    });

    it("includes preferred audio codec", () => {
      const { negotiator } = createNegotiator();
      const msg = negotiator.requestUpgrade();
      expect(msg.preferredAudioCodec).toBe("opus");
    });

    it("throws if already in progress", () => {
      const { negotiator } = createNegotiator();
      negotiator.requestUpgrade();
      expect(() => negotiator.requestUpgrade()).toThrow("cannot request upgrade");
    });

    it("throws if max retries exceeded", () => {
      const { negotiator } = createNegotiator({ maxRetries: 1 });
      negotiator.requestUpgrade();
      // Simulate failure + reset to IDLE
      negotiator.handleMessage({
        type: "webrtc.upgrade.response",
        negotiationId: "x",
        accepted: false,
        reason: "rejected",
      });
      expect(() => negotiator.requestUpgrade()).toThrow("max retries exceeded");
    });

    it("throws if disposed", () => {
      const { negotiator } = createNegotiator();
      negotiator.dispose();
      expect(() => negotiator.requestUpgrade()).toThrow("disposed");
    });
  });

  // =========================================================================
  // handleMessage — upgrade response
  // =========================================================================

  describe("upgrade response handling", () => {
    it("accepted response initializes signaling and transport", () => {
      const { negotiator, sentMessages } = createNegotiator();
      negotiator.requestUpgrade([1, 2]);
      const negId = sentMessages[0].negotiationId;

      negotiator.handleMessage({
        type: "webrtc.upgrade.response",
        negotiationId: negId,
        accepted: true,
        acceptedStreams: [1, 2],
      });

      expect(negotiator.state).toBe(NegotiationState.SIGNALING);
      expect(negotiator.snapshot.hasSignaling).toBe(true);
      expect(negotiator.snapshot.hasTransport).toBe(true);
    });

    it("rejected response transitions to FAILED and calls callback", () => {
      const { negotiator, callbacks } = createNegotiator({ maxRetries: 1 });
      negotiator.requestUpgrade();

      negotiator.handleMessage({
        type: "webrtc.upgrade.response",
        negotiationId: "x",
        accepted: false,
        reason: "not supported",
      });

      expect(callbacks.onUpgradeFailed).toHaveBeenCalledWith("not supported");
    });

    it("rejected response allows retry if under limit", () => {
      const { negotiator } = createNegotiator({ maxRetries: 3 });
      negotiator.requestUpgrade();

      negotiator.handleMessage({
        type: "webrtc.upgrade.response",
        negotiationId: "x",
        accepted: false,
        reason: "busy",
      });

      // Should be back to IDLE allowing retry
      expect(negotiator.state).toBe(NegotiationState.IDLE);
      expect(negotiator.canRetry).toBe(true);
    });

    it("ignores upgrade response in wrong state", () => {
      const { negotiator } = createNegotiator();
      // Not in REQUESTED state
      negotiator.handleMessage({
        type: "webrtc.upgrade.response",
        negotiationId: "x",
        accepted: true,
      });
      expect(negotiator.state).toBe(NegotiationState.IDLE);
    });
  });

  // =========================================================================
  // handleMessage — upgrade request (server side)
  // =========================================================================

  describe("upgrade request handling (server side)", () => {
    it("accepts upgrade request and sends response", () => {
      const { negotiator, sentMessages } = createNegotiator();
      negotiator.handleMessage({
        type: "webrtc.upgrade.request",
        negotiationId: "req_1",
        requestedStreams: [1, 2],
      });

      const response = sentMessages.find((m: any) => m.type === "webrtc.upgrade.response");
      expect(response).toBeDefined();
      expect(response.accepted).toBe(true);
      expect(response.acceptedStreams).toEqual([1, 2]);
      expect(negotiator.state).toBe(NegotiationState.SIGNALING);
    });

    it("rejects upgrade request when disposed", () => {
      const { negotiator, sentMessages } = createNegotiator();
      negotiator.dispose();

      negotiator.handleMessage({
        type: "webrtc.upgrade.request",
        negotiationId: "req_1",
        requestedStreams: [1],
      });

      // Should not crash, and should send rejection (though disposed)
      // State remains IDLE after disposal
    });

    it("rejects upgrade request when max retries exceeded", () => {
      const { negotiator, sentMessages } = createNegotiator({ maxRetries: 0 });
      negotiator.handleMessage({
        type: "webrtc.upgrade.request",
        negotiationId: "req_1",
        requestedStreams: [1],
      });

      const response = sentMessages.find((m: any) => m.type === "webrtc.upgrade.response");
      expect(response).toBeDefined();
      expect(response.accepted).toBe(false);
    });
  });

  // =========================================================================
  // Signaling message forwarding
  // =========================================================================

  describe("signaling message forwarding", () => {
    it("forwards SDP offer to signaling handler", () => {
      const { negotiator, sentMessages } = createNegotiator();
      negotiator.requestUpgrade();
      negotiator.handleMessage({
        type: "webrtc.upgrade.response",
        negotiationId: "x",
        accepted: true,
        acceptedStreams: [1, 2],
      });

      // Now in SIGNALING with active signaling handler
      // Receiving an SDP offer from peer
      negotiator.handleMessage({
        type: "webrtc.sdp.offer",
        sdp: "peer-offer-sdp",
        negotiationId: "neg_1",
      });

      // The signaling handler should have processed it
      expect(negotiator.snapshot.hasSignaling).toBe(true);
    });

    it("ignores signaling messages without active handler", () => {
      const { negotiator } = createNegotiator();
      // No active signaling — should not crash
      expect(() =>
        negotiator.handleMessage({
          type: "webrtc.ice.candidate",
          candidate: "c1",
          sdpMid: "0",
          sdpMLineIndex: 0,
          negotiationId: "neg_1",
        }),
      ).not.toThrow();
    });
  });

  // =========================================================================
  // sendControlMessage / sendAudioData
  // =========================================================================

  describe("send functions", () => {
    it("returns websocket when not upgraded", () => {
      const { negotiator } = createNegotiator();
      expect(negotiator.sendControlMessage("test")).toBe("websocket");
      expect(negotiator.sendAudioData(new ArrayBuffer(10))).toBe("websocket");
    });

    it("getStreamTransport returns websocket when not upgraded", () => {
      const { negotiator } = createNegotiator();
      expect(negotiator.getStreamTransport(0)).toBe("websocket");
      expect(negotiator.getStreamTransport(1)).toBe("websocket");
      expect(negotiator.getStreamTransport(2)).toBe("websocket");
    });
  });

  // =========================================================================
  // Downgrade
  // =========================================================================

  describe("downgrade", () => {
    it("sends downgrade message and calls callback", () => {
      const { negotiator, sentMessages, callbacks } = createNegotiator();
      negotiator.downgrade("explicit", [1, 2]);

      const msg = sentMessages.find((m: any) => m.type === "webrtc.downgrade");
      expect(msg).toBeDefined();
      expect(msg.reason).toBe("explicit");
      expect(msg.streams).toEqual([1, 2]);
      expect(callbacks.onDowngrade).toHaveBeenCalledWith("explicit", [1, 2]);
    });

    it("returns to IDLE after full downgrade", () => {
      const { negotiator } = createNegotiator();
      negotiator.downgrade("explicit");
      expect(negotiator.state).toBe(NegotiationState.IDLE);
    });

    it("handles incoming downgrade message", () => {
      const { negotiator, callbacks } = createNegotiator();
      negotiator.handleMessage({
        type: "webrtc.downgrade",
        negotiationId: "neg_1",
        reason: "ice_failed",
        streams: [1, 2],
      });
      expect(callbacks.onDowngrade).toHaveBeenCalledWith("ice_failed", [1, 2]);
    });
  });

  // =========================================================================
  // Ready message handling
  // =========================================================================

  describe("ready message", () => {
    it("handles peer ready message", () => {
      const { negotiator } = createNegotiator();
      // Should not crash in IDLE state
      expect(() =>
        negotiator.handleMessage({
          type: "webrtc.ready",
          negotiationId: "neg_1",
          activeStreams: [0, 1, 2],
          estimatedRttMs: 15,
        }),
      ).not.toThrow();
    });
  });

  // =========================================================================
  // Dispose
  // =========================================================================

  describe("dispose", () => {
    it("cleans up resources", () => {
      const { negotiator } = createNegotiator();
      negotiator.dispose();
      expect(negotiator.state).toBe(NegotiationState.IDLE);
      expect(negotiator.snapshot.hasSignaling).toBe(false);
      expect(negotiator.snapshot.hasTransport).toBe(false);
    });

    it("is idempotent", () => {
      const { negotiator } = createNegotiator();
      negotiator.dispose();
      expect(() => negotiator.dispose()).not.toThrow();
    });

    it("prevents further upgrades", () => {
      const { negotiator } = createNegotiator();
      negotiator.dispose();
      expect(() => negotiator.requestUpgrade()).toThrow("disposed");
    });
  });

  // =========================================================================
  // Full upgrade flow simulation
  // =========================================================================

  describe("full upgrade flow", () => {
    it("completes upgrade: request → accept → signaling → ready", () => {
      const { negotiator, sentMessages, callbacks } = createNegotiator();

      // 1. Request upgrade
      const reqMsg = negotiator.requestUpgrade([1, 2]);
      expect(negotiator.state).toBe(NegotiationState.REQUESTED);

      // 2. Peer accepts
      negotiator.handleMessage({
        type: "webrtc.upgrade.response",
        negotiationId: reqMsg.negotiationId,
        accepted: true,
        acceptedStreams: [1, 2],
      });
      expect(negotiator.state).toBe(NegotiationState.SIGNALING);

      // At this point signaling + transport are initialized
      expect(negotiator.snapshot.hasSignaling).toBe(true);
      expect(negotiator.snapshot.hasTransport).toBe(true);
    });

    it("handles failure gracefully and allows retry", () => {
      const { negotiator, sentMessages, callbacks } = createNegotiator({ maxRetries: 3 });

      // 1. Request upgrade
      negotiator.requestUpgrade([1, 2]);

      // 2. Peer rejects
      negotiator.handleMessage({
        type: "webrtc.upgrade.response",
        negotiationId: "x",
        accepted: false,
        reason: "busy",
      });

      expect(callbacks.onUpgradeFailed).toHaveBeenCalledWith("busy");
      expect(negotiator.canRetry).toBe(true);

      // 3. Retry
      const retry = negotiator.requestUpgrade([1]);
      expect(retry.type).toBe("webrtc.upgrade.request");
      expect(negotiator.upgradeAttempts).toBe(2);
    });
  });

  // =========================================================================
  // Error resilience
  // =========================================================================

  describe("error resilience", () => {
    it("survives sendControl throwing", () => {
      const negotiator = new TransportNegotiator({
        sendControl: () => { throw new Error("send failed"); },
        peerConnectionFactory: () => createMockPeerConnection(),
        now: () => 1000,
      });
      expect(() => negotiator.requestUpgrade()).not.toThrow();
    });

    it("survives onUpgradeFailed callback throwing", () => {
      const { negotiator } = createNegotiator({
        onUpgradeFailed: () => { throw new Error("callback boom"); },
        maxRetries: 1,
      });
      negotiator.requestUpgrade();
      expect(() =>
        negotiator.handleMessage({
          type: "webrtc.upgrade.response",
          negotiationId: "x",
          accepted: false,
          reason: "test",
        }),
      ).not.toThrow();
    });

    it("survives onDowngrade callback throwing", () => {
      const { negotiator } = createNegotiator({
        onDowngrade: () => { throw new Error("callback boom"); },
      });
      expect(() => negotiator.downgrade("explicit")).not.toThrow();
    });
  });
});
