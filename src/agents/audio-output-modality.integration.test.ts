import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  isAudioOutputModelId,
  modelOutputsAudio,
  type ModelCatalogEntry,
} from "./model-catalog.js";
import { buildOpenAICompletionsParams } from "./openai-transport-stream.js";

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
