import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { buildOpenAICompletionsParams } from "./openai-transport-stream.js";

describe("audio input modality integration", () => {
  it("converts audio attachments to input_audio content parts for audio-capable models", () => {
    const audioModel = {
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

    const params = buildOpenAICompletionsParams(
      audioModel as never,
      {
        systemPrompt: "You are a helpful assistant.",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What do you hear in this audio?" },
              {
                type: "image",
                data: "dGVzdC1hdWRpby1kYXRh", // base64 "test-audio-data"
                mimeType: "audio/wav",
              },
            ],
          },
        ],
        tools: [],
      } as never,
      {} as never,
    );

    expect(params.messages[0].content).toEqual([
      { type: "input_text", text: "What do you hear in this audio?" },
      {
        type: "input_audio",
        input_audio: {
          data: "dGVzdC1hdWRpby1kYXRh",
          format: "wav",
        },
      },
    ]);
  });

  it("correctly maps mp3 audio format", () => {
    const audioModel = {
      id: "gpt-4o-audio-preview",
      name: "GPT-4o Audio Preview",
      api: "openai-completions",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      input: ["text", "audio"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    } satisfies Model<"openai-completions">;

    const params = buildOpenAICompletionsParams(
      audioModel as never,
      {
        systemPrompt: "You are a helpful assistant.",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Analyze this audio." },
              {
                type: "image",
                data: "dGVzdC1hdWRpby1kYXRh",
                mimeType: "audio/mp3",
              },
            ],
          },
        ],
        tools: [],
      } as never,
      {} as never,
    );

    expect(params.messages[0].content).toEqual([
      { type: "input_text", text: "Analyze this audio." },
      {
        type: "input_audio",
        input_audio: {
          data: "dGVzdC1hdWRpby1kYXRh",
          format: "mp3",
        },
      },
    ]);
  });

  it("filters out audio content when model does not support audio", () => {
    const textOnlyModel = {
      id: "gpt-3.5-turbo",
      name: "GPT-3.5 Turbo",
      api: "openai-completions",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16385,
      maxTokens: 4096,
    } satisfies Model<"openai-completions">;

    const params = buildOpenAICompletionsParams(
      textOnlyModel as never,
      {
        systemPrompt: "You are a helpful assistant.",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What do you hear in this audio?" },
              {
                type: "image",
                data: "dGVzdC1hdWRpby1kYXRh",
                mimeType: "audio/wav",
              },
            ],
          },
        ],
        tools: [],
      } as never,
      {} as never,
    );

    // Audio content should be filtered out for non-audio models
    expect(params.messages[0].content).toEqual([
      { type: "input_text", text: "What do you hear in this audio?" },
    ]);
  });
});
