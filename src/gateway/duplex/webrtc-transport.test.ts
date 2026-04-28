import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  WebRTCTransport,
  type PeerConnectionLike,
  type DataChannelLike,
  type PeerConnectionFactory,
  type WebRTCTransportCallbacks,
} from "./webrtc-transport.js";
import { NegotiationState } from "./webrtc-types.js";

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
  _dataChannels: DataChannelLike[];
  _simulateConnectionState: (state: string) => void;
  _simulateIceConnectionState: (state: string) => void;
  _simulateIceCandidate: (candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } | null) => void;
  _simulateDataChannel: (channel: DataChannelLike) => void;
  _connectionState: string;
  _iceConnectionState: string;
  _iceGatheringState: string;
} {
  let connState = "new";
  let iceConnState = "new";
  let iceGatherState = "new";
  const channels: DataChannelLike[] = [];

  const pc: any = {
    _dataChannels: channels,
    _connectionState: connState,
    _iceConnectionState: iceConnState,
    _iceGatheringState: iceGatherState,

    createOffer: vi.fn().mockResolvedValue({ sdp: "mock-offer-sdp", type: "offer" }),
    createAnswer: vi.fn().mockResolvedValue({ sdp: "mock-answer-sdp", type: "answer" }),
    setLocalDescription: vi.fn().mockResolvedValue(undefined),
    setRemoteDescription: vi.fn().mockResolvedValue(undefined),
    addIceCandidate: vi.fn().mockResolvedValue(undefined),
    createDataChannel: vi.fn((label: string, opts?: any) => {
      const dc = createMockDataChannel(label);
      channels.push(dc);
      return dc;
    }),
    close: vi.fn(),

    localDescription: null,
    remoteDescription: null,

    get connectionState() { return connState; },
    get iceConnectionState() { return iceConnState; },
    get iceGatheringState() { return iceGatherState; },

    onicecandidate: null,
    oniceconnectionstatechange: null,
    onconnectionstatechange: null,
    ondatachannel: null,

    _simulateConnectionState(state: string) {
      connState = state;
      pc._connectionState = state;
      if (pc.onconnectionstatechange) pc.onconnectionstatechange();
    },
    _simulateIceConnectionState(state: string) {
      iceConnState = state;
      pc._iceConnectionState = state;
      if (pc.oniceconnectionstatechange) pc.oniceconnectionstatechange();
    },
    _simulateIceCandidate(candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } | null) {
      if (pc.onicecandidate) pc.onicecandidate({ candidate });
    },
    _simulateDataChannel(channel: DataChannelLike) {
      if (pc.ondatachannel) pc.ondatachannel({ channel });
    },
  };

  return pc;
}

function createMockFactory(): { factory: PeerConnectionFactory; lastPc: () => ReturnType<typeof createMockPeerConnection> } {
  let lastPc: ReturnType<typeof createMockPeerConnection> | null = null;
  const factory: PeerConnectionFactory = () => {
    lastPc = createMockPeerConnection();
    return lastPc;
  };
  return { factory, lastPc: () => lastPc! };
}

// ============================================================================
// Tests
// ============================================================================

describe("WebRTCTransport", () => {
  let transport: WebRTCTransport;
  let callbacks: Record<string, ReturnType<typeof vi.fn>>;
  let mockFactory: ReturnType<typeof createMockFactory>;
  let now: number;
  let clock: () => number;

  beforeEach(() => {
    now = 1000;
    clock = () => now;
    callbacks = {
      onControlMessage: vi.fn(),
      onAudioData: vi.fn(),
      onDataChannelOpen: vi.fn(),
      onDataChannelClose: vi.fn(),
      onIceCandidate: vi.fn(),
      onIceGatheringComplete: vi.fn(),
      onConnectionStateChange: vi.fn(),
      onReady: vi.fn(),
      onFailed: vi.fn(),
    };
    mockFactory = createMockFactory();
    transport = new WebRTCTransport({
      callbacks: callbacks as unknown as WebRTCTransportCallbacks,
      peerConnectionFactory: mockFactory.factory,
      now: clock,
    });
  });

  // =========================================================================
  // Initial state
  // =========================================================================

  describe("initial state", () => {
    it("starts in IDLE state", () => {
      expect(transport.state).toBe(NegotiationState.IDLE);
    });

    it("is not connected", () => {
      expect(transport.isConnected).toBe(false);
    });

    it("is not disposed", () => {
      expect(transport.isDisposed).toBe(false);
    });

    it("has empty stats", () => {
      const s = transport.stats;
      expect(s.negotiationState).toBe(NegotiationState.IDLE);
      expect(s.successfulNegotiations).toBe(0);
      expect(s.failedNegotiations).toBe(0);
      expect(s.webrtcStreams).toEqual([]);
      expect(s.dataChannelBytesSent).toBe(0);
    });
  });

  // =========================================================================
  // Initialize
  // =========================================================================

  describe("initialize", () => {
    it("creates a peer connection", () => {
      const pc = transport.initialize();
      expect(pc).toBeDefined();
      expect(pc.onicecandidate).not.toBeNull();
      expect(pc.onconnectionstatechange).not.toBeNull();
    });

    it("throws if called twice", () => {
      transport.initialize();
      expect(() => transport.initialize()).toThrow("already initialized");
    });

    it("throws if disposed", () => {
      transport.dispose();
      expect(() => transport.initialize()).toThrow("cannot initialize after disposal");
    });
  });

  // =========================================================================
  // Create offer
  // =========================================================================

  describe("createOffer", () => {
    it("creates data channel and SDP offer", async () => {
      transport.initialize();
      const sdp = await transport.createOffer();
      expect(sdp).toBe("mock-offer-sdp");
      expect(transport.state).toBe(NegotiationState.SIGNALING);
    });

    it("throws if not initialized", async () => {
      await expect(transport.createOffer()).rejects.toThrow("not initialized");
    });
  });

  // =========================================================================
  // Handle offer/answer
  // =========================================================================

  describe("handleOffer", () => {
    it("sets remote description and creates answer", async () => {
      transport.initialize();
      const answerSdp = await transport.handleOffer("remote-offer-sdp");
      expect(answerSdp).toBe("mock-answer-sdp");
      expect(transport.state).toBe(NegotiationState.ICE_GATHERING);
      const pc = mockFactory.lastPc();
      expect(pc.setRemoteDescription).toHaveBeenCalledWith({ type: "offer", sdp: "remote-offer-sdp" });
    });
  });

  describe("handleAnswer", () => {
    it("sets remote description", async () => {
      transport.initialize();
      await transport.createOffer();
      await transport.handleAnswer("remote-answer-sdp");
      expect(transport.state).toBe(NegotiationState.ICE_GATHERING);
      const pc = mockFactory.lastPc();
      expect(pc.setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "remote-answer-sdp" });
    });
  });

  // =========================================================================
  // ICE candidates
  // =========================================================================

  describe("ICE candidates", () => {
    it("adds remote ICE candidate", async () => {
      transport.initialize();
      await transport.addIceCandidate("candidate:1", "0", 0);
      const pc = mockFactory.lastPc();
      expect(pc.addIceCandidate).toHaveBeenCalledWith({
        candidate: "candidate:1",
        sdpMid: "0",
        sdpMLineIndex: 0,
      });
    });

    it("emits local ICE candidates via callback", () => {
      transport.initialize();
      const pc = mockFactory.lastPc();
      pc._simulateIceCandidate({
        candidate: "candidate:local",
        sdpMid: "0",
        sdpMLineIndex: 0,
      });
      expect(callbacks.onIceCandidate).toHaveBeenCalledWith("candidate:local", "0", 0);
    });

    it("emits ICE gathering complete on null candidate", () => {
      transport.initialize();
      const pc = mockFactory.lastPc();
      pc._simulateIceCandidate(null);
      expect(callbacks.onIceGatheringComplete).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Data channel
  // =========================================================================

  describe("data channel", () => {
    it("sets up data channel on offer creation", async () => {
      transport.initialize();
      await transport.createOffer();
      const pc = mockFactory.lastPc();
      expect(pc.createDataChannel).toHaveBeenCalledWith("control", { ordered: true });
    });

    it("handles incoming data channel from peer", () => {
      transport.initialize();
      const pc = mockFactory.lastPc();
      const dc = createMockDataChannel("control");
      pc._simulateDataChannel(dc);

      // Simulate open
      (dc as any).readyState = "open";
      dc.onopen?.();
      expect(callbacks.onDataChannelOpen).toHaveBeenCalled();
    });

    it("receives control messages via data channel", () => {
      transport.initialize();
      const pc = mockFactory.lastPc();
      const dc = createMockDataChannel("control");
      pc._simulateDataChannel(dc);
      (dc as any).readyState = "open";

      dc.onmessage?.({ data: '{"type":"test"}' });
      expect(callbacks.onControlMessage).toHaveBeenCalledWith('{"type":"test"}');
    });

    it("receives audio data via data channel", () => {
      transport.initialize();
      const pc = mockFactory.lastPc();
      const dc = createMockDataChannel("control");
      pc._simulateDataChannel(dc);

      const audioBuffer = new ArrayBuffer(1024);
      dc.onmessage?.({ data: audioBuffer });
      expect(callbacks.onAudioData).toHaveBeenCalledWith(audioBuffer);
      expect(transport.stats.audioFramesReceived).toBe(1);
    });

    it("emits onDataChannelClose when channel closes", () => {
      transport.initialize();
      const pc = mockFactory.lastPc();
      const dc = createMockDataChannel("control");
      pc._simulateDataChannel(dc);
      dc.onclose?.();
      expect(callbacks.onDataChannelClose).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Send operations
  // =========================================================================

  describe("send operations", () => {
    let dc: DataChannelLike;

    beforeEach(async () => {
      transport.initialize();
      const pc = mockFactory.lastPc();
      dc = createMockDataChannel("control");
      pc._simulateDataChannel(dc);
      (dc as any).readyState = "open";
    });

    it("sendControl sends string data", () => {
      const sent = transport.sendControl('{"msg":"hello"}');
      expect(sent).toBe(true);
      expect(dc.send).toHaveBeenCalledWith('{"msg":"hello"}');
      expect(transport.stats.dataChannelBytesSent).toBeGreaterThan(0);
    });

    it("sendControl returns false when channel not open", () => {
      (dc as any).readyState = "connecting";
      expect(transport.sendControl("test")).toBe(false);
    });

    it("sendAudio sends binary data", () => {
      const data = new ArrayBuffer(512);
      const sent = transport.sendAudio(data);
      expect(sent).toBe(true);
      expect(dc.send).toHaveBeenCalledWith(data);
      expect(transport.stats.audioFramesSent).toBe(1);
    });

    it("sendAudio returns false when channel not open", () => {
      (dc as any).readyState = "closing";
      expect(transport.sendAudio(new ArrayBuffer(10))).toBe(false);
    });

    it("sendControl returns false when send throws", () => {
      (dc.send as any).mockImplementation(() => { throw new Error("buffer full"); });
      expect(transport.sendControl("test")).toBe(false);
    });
  });

  // =========================================================================
  // Stream bindings
  // =========================================================================

  describe("stream bindings", () => {
    it("binds and checks streams", () => {
      transport.initialize();
      now = 2000;
      transport.bindStream(1, "neg_1");
      expect(transport.hasStream(1)).toBe(true);
      expect(transport.hasStream(2)).toBe(false);
      expect(transport.stats.webrtcStreams).toEqual([1]);
    });

    it("unbinds streams", () => {
      transport.initialize();
      transport.bindStream(1, "neg_1");
      transport.bindStream(2, "neg_1");
      expect(transport.unbindStream(1)).toBe(true);
      expect(transport.hasStream(1)).toBe(false);
      expect(transport.hasStream(2)).toBe(true);
    });

    it("unbindStream returns false for unbound stream", () => {
      transport.initialize();
      expect(transport.unbindStream(99)).toBe(false);
    });

    it("stores binding metadata", () => {
      transport.initialize();
      now = 3000;
      transport.bindStream(1, "neg_1");
      const binding = transport.streamBindings.get(1);
      expect(binding).toBeDefined();
      expect(binding!.transport).toBe("webrtc");
      expect(binding!.boundAt).toBe(3000);
      expect(binding!.negotiationId).toBe("neg_1");
    });
  });

  // =========================================================================
  // Connection state changes
  // =========================================================================

  describe("connection state changes", () => {
    it("calls onConnectionStateChange callback", () => {
      transport.initialize();
      const pc = mockFactory.lastPc();
      pc._simulateConnectionState("connecting");
      expect(callbacks.onConnectionStateChange).toHaveBeenCalledWith("connecting");
    });

    it("calls onFailed on ICE failure", () => {
      transport.initialize();
      const pc = mockFactory.lastPc();
      pc._simulateIceConnectionState("failed");
      expect(callbacks.onFailed).toHaveBeenCalledWith("ice_failed");
      expect(transport.state).toBe(NegotiationState.FAILED);
    });

    it("calls onFailed on DTLS failure", () => {
      transport.initialize();
      const pc = mockFactory.lastPc();
      pc._simulateConnectionState("failed");
      expect(callbacks.onFailed).toHaveBeenCalledWith("dtls_failed");
    });

    it("calls onFailed on disconnect", () => {
      transport.initialize();
      const pc = mockFactory.lastPc();
      pc._simulateConnectionState("disconnected");
      expect(callbacks.onFailed).toHaveBeenCalledWith("peer_disconnected");
    });

    it("activates when both data channel open and connection connected", async () => {
      transport.initialize();
      const pc = mockFactory.lastPc();
      const dc = createMockDataChannel("control");
      pc._simulateDataChannel(dc);

      (dc as any).readyState = "open";
      pc._simulateConnectionState("connected");
      dc.onopen?.();

      expect(transport.state).toBe(NegotiationState.ACTIVE);
      expect(transport.isConnected).toBe(true);
      expect(callbacks.onReady).toHaveBeenCalled();
    });

    it("does not double-fail", () => {
      transport.initialize();
      const pc = mockFactory.lastPc();
      pc._simulateIceConnectionState("failed");
      pc._simulateConnectionState("failed");
      expect(callbacks.onFailed).toHaveBeenCalledTimes(1);
      expect(transport.stats.failedNegotiations).toBe(1);
    });
  });

  // =========================================================================
  // Activate
  // =========================================================================

  describe("activate", () => {
    it("transitions to ACTIVE and increments success count", () => {
      transport.initialize();
      transport.activate(42);
      expect(transport.state).toBe(NegotiationState.ACTIVE);
      expect(transport.isConnected).toBe(true);
      expect(transport.stats.successfulNegotiations).toBe(1);
      expect(transport.stats.lastRttMs).toBe(42);
    });

    it("calls onReady callback", () => {
      transport.initialize();
      transport.activate();
      expect(callbacks.onReady).toHaveBeenCalled();
    });

    it("survives onReady throwing", () => {
      callbacks.onReady = vi.fn(() => { throw new Error("boom"); });
      transport = new WebRTCTransport({
        callbacks: callbacks as unknown as WebRTCTransportCallbacks,
        peerConnectionFactory: mockFactory.factory,
        now: clock,
      });
      transport.initialize();
      expect(() => transport.activate()).not.toThrow();
    });
  });

  // =========================================================================
  // Dispose
  // =========================================================================

  describe("dispose", () => {
    it("closes peer connection and data channel", () => {
      transport.initialize();
      const pc = mockFactory.lastPc();
      const dc = createMockDataChannel("control");
      pc._simulateDataChannel(dc);

      transport.dispose();
      expect(pc.close).toHaveBeenCalled();
      expect(dc.close).toHaveBeenCalled();
      expect(transport.isDisposed).toBe(true);
      expect(transport.state).toBe(NegotiationState.IDLE);
    });

    it("clears stream bindings", () => {
      transport.initialize();
      transport.bindStream(1, "neg_1");
      transport.bindStream(2, "neg_1");
      transport.dispose();
      expect(transport.stats.webrtcStreams).toEqual([]);
    });

    it("is idempotent", () => {
      transport.initialize();
      transport.dispose();
      expect(() => transport.dispose()).not.toThrow();
    });

    it("prevents operations after disposal", async () => {
      transport.initialize();
      transport.dispose();
      await expect(transport.createOffer()).rejects.toThrow("disposed");
    });
  });

  // =========================================================================
  // Data channel error handling
  // =========================================================================

  describe("data channel error handling", () => {
    it("handles data channel error event", () => {
      transport.initialize();
      const pc = mockFactory.lastPc();
      const dc = createMockDataChannel("control");
      pc._simulateDataChannel(dc);

      dc.onerror?.({ error: new Error("channel error") });
      expect(callbacks.onFailed).toHaveBeenCalledWith("error");
    });
  });

  // =========================================================================
  // Stats tracking
  // =========================================================================

  describe("stats tracking", () => {
    it("tracks bytes sent and received", () => {
      transport.initialize();
      const pc = mockFactory.lastPc();
      const dc = createMockDataChannel("control");
      pc._simulateDataChannel(dc);
      (dc as any).readyState = "open";

      transport.sendControl("hello");
      expect(transport.stats.dataChannelBytesSent).toBe(5);

      dc.onmessage?.({ data: "world!!" });
      expect(transport.stats.dataChannelBytesReceived).toBe(7);
    });

    it("tracks audio frames", () => {
      transport.initialize();
      const pc = mockFactory.lastPc();
      const dc = createMockDataChannel("control");
      pc._simulateDataChannel(dc);
      (dc as any).readyState = "open";

      transport.sendAudio(new ArrayBuffer(100));
      expect(transport.stats.audioFramesSent).toBe(1);

      dc.onmessage?.({ data: new ArrayBuffer(200) });
      expect(transport.stats.audioFramesReceived).toBe(1);
    });

    it("returns a copy of stats (not a reference)", () => {
      const s1 = transport.stats;
      const s2 = transport.stats;
      expect(s1).toEqual(s2);
      expect(s1).not.toBe(s2);
    });
  });
});
