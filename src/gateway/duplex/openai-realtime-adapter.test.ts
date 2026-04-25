/**
 * Tests for OpenAIRealtimeAdapter — Phase D.2.
 */
import { describe, expect, it, vi } from "vitest";
import { AudioInputStream } from "../audio/audio-input-stream.js";
import { AudioOutputStream } from "../audio/audio-output-stream.js";
import {
  OpenAIRealtimeAdapter,
  type OpenAIRealtimeAdapterOptions,
} from "./openai-realtime-adapter.js";
import type { OpenAIRealtimeServerEvent } from "./openai-realtime-types.js";

function makeAdapter(overrides: Partial<OpenAIRealtimeAdapterOptions> = {}) {
  const serverEvents: OpenAIRealtimeServerEvent[] = [];
  const adapter = new OpenAIRealtimeAdapter({
    sendServerEvent: (e) => serverEvents.push(e),
    ...overrides,
  });
  return { adapter, serverEvents };
}

describe("OpenAIRealtimeAdapter — construction", () => {
  it("creates with default options", () => {
    const { adapter } = makeAdapter();
    expect(adapter).toBeDefined();
    expect(adapter.snapshot().sessionId).toMatch(/^session_\d+_[a-z0-9]+$/);
  });
});

describe("OpenAIRealtimeAdapter — session.update", () => {
  it("handles session.update and echoes back session.updated", () => {
    const { adapter, serverEvents } = makeAdapter();
    const config = {
      modalities: ["audio"],
      instructions: "Be concise",
      voice: "alloy",
    };
    adapter.handleClientMessage({
      type: "session.update",
      session: config,
    });
    expect(serverEvents).toHaveLength(1);
    expect(serverEvents[0]?.type).toBe("session.updated");
    expect((serverEvents[0] as unknown as Record<string, unknown>).session).toEqual(config);
  });

  it("calls onSessionUpdate callback", () => {
    const onSessionUpdate = vi.fn();
    const { adapter } = makeAdapter({ onSessionUpdate });
    adapter.handleClientMessage({
      type: "session.update",
      session: { instructions: "test" },
    });
    expect(onSessionUpdate).toHaveBeenCalledWith({ instructions: "test" });
  });
});

describe("OpenAIRealtimeAdapter — input_audio_buffer events", () => {
  it("rejects input_audio_buffer.append without bound audio input", () => {
    const { adapter, serverEvents } = makeAdapter();
    adapter.handleClientMessage({
      type: "input_audio_buffer.append",
      audio: Buffer.alloc(32).toString("base64"),
    });
    expect(serverEvents.some((e) => e.type === "error")).toBe(true);
  });

  it("accepts input_audio_buffer.append when audio input is bound", () => {
    const { adapter, serverEvents } = makeAdapter();
    const audioIn = new AudioInputStream();
    adapter.bindAudioStreams(audioIn, new AudioOutputStream({ send: () => {} }));
    adapter.handleClientMessage({
      type: "input_audio_buffer.append",
      audio: Buffer.alloc(160).toString("base64"),
    });
    expect(serverEvents.some((e) => e.type === "input_audio_buffer.committed")).toBe(true);
  });

  it("handles input_audio_buffer.commit", () => {
    const { adapter, serverEvents } = makeAdapter();
    const audioIn = new AudioInputStream();
    adapter.bindAudioStreams(audioIn, new AudioOutputStream({ send: () => {} }));
    audioIn.buffer.append(Buffer.alloc(160));
    adapter.handleClientMessage({
      type: "input_audio_buffer.commit",
    });
    expect(serverEvents.some((e) => e.type === "input_audio_buffer.committed")).toBe(true);
  });

  it("handles input_audio_buffer.clear", () => {
    const { adapter } = makeAdapter();
    const audioIn = new AudioInputStream();
    adapter.bindAudioStreams(audioIn, new AudioOutputStream({ send: () => {} }));
    audioIn.buffer.append(Buffer.alloc(160));
    adapter.handleClientMessage({
      type: "input_audio_buffer.clear",
    });
    expect(audioIn.stats.bufferedBytes).toBe(0);
  });
});

describe("OpenAIRealtimeAdapter — response control", () => {
  it("handles response.create", () => {
    const onResponseCancel = vi.fn();
    const { adapter } = makeAdapter({ onResponseCancel });
    adapter.handleClientMessage({
      type: "response.create",
      response: {
        modalities: ["audio"],
        voice: "alloy",
      },
    });
    // No immediate outbound event; signal goes to provider.
  });

  it("handles response.cancel and sends response.done", () => {
    const { adapter, serverEvents } = makeAdapter();
    // Fake a response first
    adapter.emitDuplexEvent("response.started");
    serverEvents.length = 0;
    adapter.handleClientMessage({
      type: "response.cancel",
    });
    expect(serverEvents.some((e) => e.type === "response.done")).toBe(true);
    const done = serverEvents.find((e) => e.type === "response.done") as unknown as Record<
      string,
      unknown
    >;
    expect((done?.response as Record<string, unknown>)?.status).toBe("cancelled");
  });
});

describe("OpenAIRealtimeAdapter — duplex event mapping", () => {
  it("emits input_audio_buffer.speech_started on user.speech.started", () => {
    const { adapter, serverEvents } = makeAdapter();
    adapter.emitDuplexEvent("user.speech.started", { audioStartMs: 100 });
    expect(serverEvents).toHaveLength(1);
    expect(serverEvents[0]?.type).toBe("input_audio_buffer.speech_started");
    expect((serverEvents[0] as unknown as Record<string, unknown>).audio_start_ms).toBe(100);
  });

  it("emits input_audio_buffer.speech_stopped on user.speech.stopped", () => {
    const { adapter, serverEvents } = makeAdapter();
    adapter.emitDuplexEvent("user.speech.stopped", {
      audioStartMs: 100,
      audioEndMs: 500,
    });
    expect(serverEvents).toHaveLength(1);
    expect(serverEvents[0]?.type).toBe("input_audio_buffer.speech_stopped");
    expect((serverEvents[0] as unknown as Record<string, unknown>).audio_end_ms).toBe(500);
  });

  it("emits response.created on response.started", () => {
    const { adapter, serverEvents } = makeAdapter();
    adapter.emitDuplexEvent("response.started");
    expect(serverEvents).toHaveLength(1);
    expect(serverEvents[0]?.type).toBe("response.created");
    const created = serverEvents[0] as unknown as Record<string, unknown>;
    expect((created.response as Record<string, unknown>).id).toMatch(/^response_\d+_[a-z0-9]+$/);
    expect((created.response as Record<string, unknown>).status).toBe("in_progress");
  });

  it("emits response.audio.delta on emitAudioDelta", () => {
    const { adapter, serverEvents } = makeAdapter();
    adapter.emitDuplexEvent("response.started");
    serverEvents.length = 0;
    adapter.emitAudioDelta("SGVsbG8gV29ybGQ=", 0);
    expect(serverEvents).toHaveLength(1);
    expect(serverEvents[0]?.type).toBe("response.audio.delta");
    const delta = serverEvents[0] as unknown as Record<string, unknown>;
    expect(delta.delta).toBe("SGVsbG8gV29ybGQ=");
  });

  it("emits response.audio.done on response.audio_done", () => {
    const { adapter, serverEvents } = makeAdapter();
    adapter.emitDuplexEvent("response.started");
    adapter.emitDuplexEvent("response.audio_done");
    expect(serverEvents.some((e) => e.type === "response.audio.done")).toBe(true);
  });

  it("emits response.done on duplex.session.end", () => {
    const { adapter, serverEvents } = makeAdapter();
    adapter.emitDuplexEvent("response.started");
    adapter.emitDuplexEvent("duplex.session.end");
    expect(serverEvents.some((e) => e.type === "response.done")).toBe(true);
    const done = serverEvents.find((e) => e.type === "response.done") as unknown as Record<
      string,
      unknown
    >;
    expect((done?.response as Record<string, unknown>)?.status).toBe("completed");
  });
});

describe("OpenAIRealtimeAdapter — conversation.item.truncate", () => {
  it("calls onTruncate when conversation.item.truncate received", () => {
    const onTruncate = vi.fn();
    const { adapter } = makeAdapter({ onTruncate });
    adapter.handleClientMessage({
      type: "conversation.item.truncate",
      item_id: "item_abc",
      content_index: 0,
      audio_end_ms: 5000,
    });
    expect(onTruncate).toHaveBeenCalledWith("item_abc", 5000);
  });
});

describe("OpenAIRealtimeAdapter — error handling", () => {
  it("sends error on invalid JSON structure", () => {
    const { adapter, serverEvents } = makeAdapter();
    adapter.handleClientMessage({
      type: undefined,
    });
    expect(serverEvents.some((e) => e.type === "error")).toBe(true);
  });

  it("calls onDecodeError on parse failure", () => {
    const onDecodeError = vi.fn();
    const { adapter } = makeAdapter({ onDecodeError });
    adapter.handleClientMessage({ type: undefined });
    expect(onDecodeError).toHaveBeenCalled();
  });

  it("sends error on unknown event type", () => {
    const { adapter, serverEvents } = makeAdapter();
    adapter.handleClientMessage({
      type: "unknown.event",
    });
    expect(serverEvents.some((e) => e.type === "error")).toBe(true);
  });

  it("handles non-object input gracefully", () => {
    const onDecodeError = vi.fn();
    const { adapter, serverEvents } = makeAdapter({ onDecodeError });
    adapter.handleClientMessage(null);
    expect(onDecodeError).toHaveBeenCalled();
    expect(serverEvents.some((e) => e.type === "error")).toBe(true);
  });

  it("handler exceptions are caught and sent as errors", () => {
    const { adapter, serverEvents } = makeAdapter({
      onSessionUpdate: () => {
        throw new Error("handler boom");
      },
    });
    adapter.handleClientMessage({
      type: "session.update",
      session: {},
    });
    expect(serverEvents.some((e) => e.type === "error")).toBe(true);
  });
});

describe("OpenAIRealtimeAdapter — snapshot", () => {
  it("returns session metadata", () => {
    const { adapter } = makeAdapter();
    const snap = adapter.snapshot();
    expect(snap.sessionId).toMatch(/^session_/);
    expect(snap.lastResponseId).toBeNull();
    expect(snap.hasAudioIn).toBe(false);
    expect(snap.hasAudioOut).toBe(false);
  });

  it("tracks bound streams in snapshot", () => {
    const { adapter } = makeAdapter();
    adapter.bindAudioStreams(new AudioInputStream(), new AudioOutputStream({ send: () => {} }));
    const snap = adapter.snapshot();
    expect(snap.hasAudioIn).toBe(true);
    expect(snap.hasAudioOut).toBe(true);
  });
});

describe("OpenAIRealtimeAdapter — control events (no-op)", () => {
  it("ignores interrupt without throwing", () => {
    const { adapter } = makeAdapter();
    expect(() => adapter.emitDuplexEvent("interrupt", { interruptId: "int_1" })).not.toThrow();
  });

  it("ignores rollback.complete without throwing", () => {
    const { adapter } = makeAdapter();
    expect(() => adapter.emitDuplexEvent("rollback.complete")).not.toThrow();
  });
});
