import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { liftAudioAttachments, normalizeAudioOutput } from "./audio-output-normalize.js";

describe("normalizeAudioOutput", () => {
  it("returns content unchanged and empty attachments when no audio blocks present", () => {
    const content: AssistantMessage["content"] = [
      { type: "text", text: "hello" },
      { type: "thinking", thinking: "ponder", thinkingSignature: "reasoning" },
    ];
    const result = normalizeAudioOutput(content);

    expect(result.attachments).toEqual([]);
    expect(result.content).toEqual(content);
  });

  it("strips a single audio block and lifts it into attachments + transcript text", () => {
    const result = normalizeAudioOutput([
      {
        type: "audio",
        id: "a_1",
        data: "AAABBB",
        transcript: "spoken words",
        mimeType: "audio/mpeg",
        expiresAt: 999,
      },
    ]);

    expect(result.attachments).toEqual([
      {
        id: "a_1",
        data: "AAABBB",
        transcript: "spoken words",
        mimeType: "audio/mpeg",
        expiresAt: 999,
      },
    ]);
    expect(result.content).toEqual([{ type: "text", text: "spoken words" }]);
  });

  it("interleaves transcript text with neighboring text blocks in source order", () => {
    const result = normalizeAudioOutput([
      { type: "text", text: "Pre-text " },
      {
        type: "audio",
        id: "a_2",
        data: "DATA",
        transcript: "speak ",
        mimeType: "audio/mpeg",
      },
      { type: "text", text: "Post-text" },
    ]);

    expect(result.attachments).toHaveLength(1);
    expect(result.content).toEqual([
      { type: "text", text: "Pre-text " },
      { type: "text", text: "speak " },
      { type: "text", text: "Post-text" },
    ]);
  });

  it("merges consecutive audio block transcripts into a single text block but keeps each attachment separate", () => {
    const result = normalizeAudioOutput([
      {
        type: "audio",
        id: "a_3",
        data: "AAA",
        transcript: "Hello ",
        mimeType: "audio/wav",
      },
      {
        type: "audio",
        id: "a_4",
        data: "BBB",
        transcript: "world",
        mimeType: "audio/wav",
      },
    ]);

    expect(result.attachments).toHaveLength(2);
    expect(result.attachments[0].id).toBe("a_3");
    expect(result.attachments[1].id).toBe("a_4");
    expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
  });

  it("drops empty transcripts so audio without speech does not pollute content", () => {
    const result = normalizeAudioOutput([
      {
        type: "audio",
        id: "a_5",
        data: "CCC",
        transcript: "",
        mimeType: "audio/mpeg",
      },
    ]);

    expect(result.attachments).toHaveLength(1);
    expect(result.content).toEqual([]);
  });
});

describe("liftAudioAttachments", () => {
  it("mutates the message in place: removes audio blocks, sets audioAttachments side-channel", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "intro " },
        {
          type: "audio",
          id: "a_6",
          data: "ZZZ",
          transcript: "spoken",
          mimeType: "audio/mpeg",
        },
      ],
    } as { content: unknown[] } & Record<string, unknown>;

    const lifted = liftAudioAttachments(msg as never);

    expect(lifted).toHaveLength(1);
    expect((msg as { audioAttachments?: unknown[] }).audioAttachments).toHaveLength(1);
    expect(msg.content).toEqual([
      { type: "text", text: "intro " },
      { type: "text", text: "spoken" },
    ]);
  });

  it("does not add audioAttachments key when no audio blocks present", () => {
    const msg = {
      role: "assistant",
      content: [{ type: "text", text: "plain" }],
    } as { content: unknown[] } & Record<string, unknown>;

    const lifted = liftAudioAttachments(msg as never);

    expect(lifted).toEqual([]);
    expect("audioAttachments" in msg).toBe(false);
  });
});
