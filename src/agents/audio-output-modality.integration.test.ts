import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  isAudioOutputModelId,
  modelOutputsAudio,
  type ModelCatalogEntry,
} from "./model-catalog.js";
import {
  buildOpenAICompletionsParams,
  processOpenAICompletionsStream,
  type MutableAssistantOutput,
} from "./openai-transport-stream.js";

describe("audio output modality — capability helpers", () => {
  it("modelOutputsAudio reports true when entry.output includes 'audio'", () => {
    const entry: ModelCatalogEntry = {
      id: "gpt-4o-audio-preview",
      name: "GPT-4o Audio Preview",
      provider: "openai",
      output: ["text", "audio"],
    };
    expect(modelOutputsAudio(entry)).toBe(true);
  });

  it("modelOutputsAudio reports false when output omits 'audio'", () => {
    const entry: ModelCatalogEntry = {
      id: "gpt-4o",
      name: "GPT-4o",
      provider: "openai",
      output: ["text"],
    };
    expect(modelOutputsAudio(entry)).toBe(false);
  });

  it("modelOutputsAudio reports false when output is undefined", () => {
    const entry: ModelCatalogEntry = {
      id: "gpt-4o",
      name: "GPT-4o",
      provider: "openai",
    };
    expect(modelOutputsAudio(entry)).toBe(false);
  });

  it("isAudioOutputModelId recognises canonical OpenAI audio-preview IDs", () => {
    expect(isAudioOutputModelId("gpt-4o-audio-preview")).toBe(true);
    expect(isAudioOutputModelId("gpt-4o-audio-preview-2024-12-17")).toBe(true);
    expect(isAudioOutputModelId("gpt-4o-mini-audio-preview")).toBe(true);
    expect(isAudioOutputModelId("gpt-4o-realtime-preview")).toBe(true);
  });

  it("isAudioOutputModelId rejects non-audio models and falsy ids", () => {
    expect(isAudioOutputModelId("gpt-4o")).toBe(false);
    expect(isAudioOutputModelId("gpt-4o-mini")).toBe(false);
    expect(isAudioOutputModelId(undefined)).toBe(false);
    expect(isAudioOutputModelId("")).toBe(false);
  });
});

describe("audio output modality — request params", () => {
  const audioOutputModel = {
    id: "gpt-4o-audio-preview",
    name: "GPT-4o Audio Preview",
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    input: ["text", "image", "audio"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  } satisfies Model<"openai-completions">;

  const baseContext = {
    systemPrompt: "You are a helpful assistant.",
    messages: [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Say hello." }],
      },
    ],
    tools: [],
  };

  it("injects modalities + audio config when model emits audio output", () => {
    const params = buildOpenAICompletionsParams(
      audioOutputModel as never,
      baseContext as never,
      undefined,
    );

    expect(params.modalities).toEqual(["text", "audio"]);
    expect(params.audio).toEqual({ voice: "alloy", format: "mp3" });
  });

  it("respects caller voice and format overrides", () => {
    const params = buildOpenAICompletionsParams(
      audioOutputModel as never,
      baseContext as never,
      { audioOutput: { voice: "shimmer", format: "wav" } } as never,
    );

    expect(params.audio).toEqual({ voice: "shimmer", format: "wav" });
  });

  it("omits modalities when caller passes audioOutput: false", () => {
    const params = buildOpenAICompletionsParams(
      audioOutputModel as never,
      baseContext as never,
      { audioOutput: false } as never,
    );

    expect(params.modalities).toBeUndefined();
    expect(params.audio).toBeUndefined();
  });

  it("does not inject audio params for non-audio-output models", () => {
    const textModel = {
      ...audioOutputModel,
      id: "gpt-4o",
      input: ["text", "image"],
    } as Model<"openai-completions">;

    const params = buildOpenAICompletionsParams(
      textModel as never,
      baseContext as never,
      undefined,
    );

    expect(params.modalities).toBeUndefined();
    expect(params.audio).toBeUndefined();
  });
});

describe("audio output modality — stream consumer", () => {
  function makeOutput(audioFormat?: string): MutableAssistantOutput {
    const output: MutableAssistantOutput = {
      content: [],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    if (audioFormat) {
      (output as unknown as { audioFormat?: string }).audioFormat = audioFormat;
    }
    return output;
  }

  function makeModel(): Model<"openai-completions"> {
    return {
      id: "gpt-4o-audio-preview",
      name: "GPT-4o Audio Preview",
      api: "openai-completions",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    } as unknown as Model<"openai-completions">;
  }

  async function* streamOf(chunks: Array<Record<string, unknown>>) {
    for (const chunk of chunks) {
      yield chunk as never;
    }
  }

  it("captures delta.audio chunks into a single audio block with concatenated data + transcript", async () => {
    const events: Array<Record<string, unknown>> = [];
    const stream = { push: (event: unknown) => events.push(event as Record<string, unknown>) };
    const output = makeOutput("mp3");
    const chunks = [
      { id: "r1", choices: [{ delta: { audio: { id: "a_1", data: "AAAA" } } }] },
      { id: "r1", choices: [{ delta: { audio: { data: "BBBB", transcript: "Hello" } } }] },
      {
        id: "r1",
        choices: [
          { delta: { audio: { data: "CCCC", transcript: " world", expires_at: 1234567890 } } },
        ],
      },
      { id: "r1", choices: [{ delta: {}, finish_reason: "stop" }] },
    ];

    await processOpenAICompletionsStream(streamOf(chunks), output, makeModel(), stream);

    expect(output.content).toHaveLength(1);
    const block = output.content[0] as unknown as {
      type: string;
      id?: string;
      data: string;
      transcript: string;
      mimeType: string;
      expiresAt?: number;
    };
    expect(block.type).toBe("audio");
    expect(block.id).toBe("a_1");
    expect(block.data).toBe("AAAABBBBCCCC");
    expect(block.transcript).toBe("Hello world");
    expect(block.mimeType).toBe("audio/mpeg");
    expect(block.expiresAt).toBe(1234567890);
  });

  it("emits audio_start, audio_delta and audio_transcript_delta events in order", async () => {
    const events: Array<Record<string, unknown>> = [];
    const stream = { push: (event: unknown) => events.push(event as Record<string, unknown>) };
    const output = makeOutput("wav");
    const chunks = [
      { id: "r2", choices: [{ delta: { audio: { id: "a_2", data: "D" } } }] },
      { id: "r2", choices: [{ delta: { audio: { transcript: "Hi" } } }] },
      { id: "r2", choices: [{ delta: { audio: { data: "E" } } }] },
      { id: "r2", choices: [{ delta: {}, finish_reason: "stop" }] },
    ];

    await processOpenAICompletionsStream(streamOf(chunks), output, makeModel(), stream);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("audio_start");
    expect(types).toContain("audio_delta");
    expect(types).toContain("audio_transcript_delta");
    // First delta event after start must be audio_delta (data came first).
    const firstNonStart = events.find(
      (e) => e.type === "audio_delta" || e.type === "audio_transcript_delta",
    );
    expect(firstNonStart?.type).toBe("audio_delta");
  });

  it("uses the requested audioFormat hint when resolving mimeType (wav → audio/wav)", async () => {
    const stream = { push: () => {} };
    const output = makeOutput("wav");
    const chunks = [
      { id: "r3", choices: [{ delta: { audio: { data: "X" } } }] },
      { id: "r3", choices: [{ delta: {}, finish_reason: "stop" }] },
    ];

    await processOpenAICompletionsStream(streamOf(chunks), output, makeModel(), stream);

    const block = output.content[0] as unknown as { mimeType: string };
    expect(block.mimeType).toBe("audio/wav");
  });

  it("defaults mimeType to audio/mpeg when no audioFormat hint is set", async () => {
    const stream = { push: () => {} };
    const output = makeOutput(); // no hint
    const chunks = [
      { id: "r4", choices: [{ delta: { audio: { data: "Y" } } }] },
      { id: "r4", choices: [{ delta: {}, finish_reason: "stop" }] },
    ];

    await processOpenAICompletionsStream(streamOf(chunks), output, makeModel(), stream);

    const block = output.content[0] as unknown as { mimeType: string };
    expect(block.mimeType).toBe("audio/mpeg");
  });

  it("interleaves text and audio blocks correctly when both modalities stream in", async () => {
    const stream = { push: () => {} };
    const output = makeOutput("mp3");
    const chunks = [
      { id: "r5", choices: [{ delta: { content: "Pre-text " } }] },
      {
        id: "r5",
        choices: [{ delta: { audio: { id: "a_5", data: "AUDIO", transcript: "speak" } } }],
      },
      { id: "r5", choices: [{ delta: { content: "Post-text" } }] },
      { id: "r5", choices: [{ delta: {}, finish_reason: "stop" }] },
    ];

    await processOpenAICompletionsStream(streamOf(chunks), output, makeModel(), stream);

    expect(output.content).toHaveLength(3);
    expect((output.content[0] as { type: string }).type).toBe("text");
    expect((output.content[1] as unknown as { type: string }).type).toBe("audio");
    expect((output.content[2] as { type: string }).type).toBe("text");
  });
});
