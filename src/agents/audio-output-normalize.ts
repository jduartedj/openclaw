/**
 * Audio output normalization (Phase 6 M4)
 *
 * The OpenAI completions stream consumer pushes synthetic audio blocks onto
 * `AssistantMessage.content` via an unsafe cast, because the pi-ai type for
 * content (TextContent | ThinkingContent | ToolCall) does not allow audio.
 *
 * This module provides a normalization step that:
 *   - Strips audio blocks out of content[] (so the array satisfies pi-ai types)
 *   - Lifts the audio's transcript into a TextContent block (preserving the
 *     spoken words for any text-only consumer / persistence layer)
 *   - Returns the audio bytes as side-channel attachments callers can route
 *     to playback / storage / TTS pipelines.
 *
 * No I/O. Pure transformation. Safe to call repeatedly (idempotent: a content
 * array with no audio blocks is returned unchanged with `attachments: []`).
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";

export type AudioOutputAttachment = {
  /** Provider-supplied id (e.g. OpenAI's audio.id) when present. */
  id?: string;
  /** Base64-encoded audio payload. */
  data: string;
  /** Plain-text transcript of the spoken audio. */
  transcript: string;
  /** Canonical MIME type, e.g. audio/mpeg or audio/wav. */
  mimeType: string;
  /** Unix timestamp (seconds) when the provider's reference id expires. */
  expiresAt?: number;
};

type RawAudioBlock = {
  type: "audio";
  id?: string;
  data: string;
  transcript: string;
  mimeType: string;
  expiresAt?: number;
};

type AnyContentBlock = AssistantMessage["content"][number] | RawAudioBlock;

function isAudioBlock(block: AnyContentBlock): block is RawAudioBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    "type" in block &&
    (block as { type: unknown }).type === "audio"
  );
}

/**
 * Split `content` into a pi-ai-safe content array (audio blocks removed,
 * transcripts re-introduced as text) and a parallel list of audio attachments.
 *
 * If multiple consecutive audio blocks share a transcript boundary, the
 * transcripts are concatenated into a single text block to keep ordering
 * intuitive for downstream readers.
 */
export function normalizeAudioOutput(content: ReadonlyArray<AnyContentBlock>): {
  content: AssistantMessage["content"];
  attachments: AudioOutputAttachment[];
} {
  const safeContent: AssistantMessage["content"] = [];
  const attachments: AudioOutputAttachment[] = [];
  let pendingTranscript = "";
  const flushTranscript = () => {
    if (pendingTranscript.length === 0) {
      return;
    }
    safeContent.push({ type: "text", text: pendingTranscript });
    pendingTranscript = "";
  };

  for (const block of content) {
    if (isAudioBlock(block)) {
      attachments.push({
        id: block.id,
        data: block.data,
        transcript: block.transcript,
        mimeType: block.mimeType,
        expiresAt: block.expiresAt,
      });
      pendingTranscript += block.transcript;
      continue;
    }
    flushTranscript();
    safeContent.push(block);
  }
  flushTranscript();

  return { content: safeContent, attachments };
}

/**
 * Apply normalizeAudioOutput in-place on a mutable assistant-message-like
 * object. Returns the lifted attachments. Useful at boundaries where the
 * output object is being persisted/forwarded and the caller wants pi-ai
 * type safety without losing the audio payload.
 */
export function liftAudioAttachments(
  message: { content: ReadonlyArray<AnyContentBlock> } & Record<string, unknown>,
): AudioOutputAttachment[] {
  const { content, attachments } = normalizeAudioOutput(message.content);
  (message as { content: AssistantMessage["content"] }).content = content;
  if (attachments.length > 0) {
    (message as { audioAttachments?: AudioOutputAttachment[] }).audioAttachments = attachments;
  }
  return attachments;
}
