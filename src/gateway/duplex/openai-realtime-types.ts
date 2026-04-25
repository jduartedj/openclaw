/**
 * OpenAI Realtime API types — Phase D.2.
 *
 * Mapping between OpenAI Realtime WebSocket message format and
 * our internal duplex protocol.
 *
 * Reference: https://platform.openai.com/docs/api-reference/realtime
 */

// ============================================================================
// OpenAI Realtime Client → Server (inbound to us)
// ============================================================================

export interface SessionUpdateMessage {
  type: "session.update";
  session: {
    modalities?: ("text" | "audio")[];
    instructions?: string;
    voice?: "alloy" | "echo" | "shimmer" | "breeze" | "cinnamon" | "juniper" | "ember";
    input_audio_format?: "pcm16" | "g711_ulaw" | "g711_alaw";
    output_audio_format?: "pcm16" | "g711_ulaw" | "g711_alaw";
    input_audio_transcription?: {
      model: string;
    };
    turn_detection?: {
      type: "server_vad" | "manual";
      threshold?: number;
      prefix_padding_ms?: number;
      silence_duration_ms?: number;
    };
    temperature?: number;
    max_response_output_tokens?: number | "inf";
    tool_choice?: "auto" | "required" | "none" | Record<string, unknown>;
    tools?: Array<{
      type: "function";
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    }>;
  };
}

export interface InputAudioBufferAppendMessage {
  type: "input_audio_buffer.append";
  audio: string; // base64-encoded audio
}

export interface InputAudioBufferCommitMessage {
  type: "input_audio_buffer.commit";
}

export interface InputAudioBufferClearMessage {
  type: "input_audio_buffer.clear";
}

export interface ResponseCreateMessage {
  type: "response.create";
  response: {
    modalities?: ("text" | "audio")[];
    instructions?: string;
    voice?: string;
    output_audio_format?: "pcm16" | "g711_ulaw" | "g711_alaw";
    tools?: Array<Record<string, unknown>>;
    tool_choice?: unknown;
    temperature?: number;
    max_output_tokens?: number | "inf";
  };
}

export interface ResponseCancelMessage {
  type: "response.cancel";
}

export interface ConversationItemCreateMessage {
  type: "conversation.item.create";
  previous_item_id?: string;
  item: {
    type: "message" | "function_call" | "function_call_output";
    id?: string;
    role?: "user" | "assistant";
    content?: Array<{
      type: "text" | "audio" | "input_text" | "input_audio";
      text?: string;
      audio?: string; // base64
      format?: string;
    }>;
    name?: string;
    arguments?: string;
    output?: string;
  };
}

export interface ConversationItemTruncateMessage {
  type: "conversation.item.truncate";
  item_id: string;
  content_index: number;
  audio_end_ms: number;
}

export type OpenAIRealtimeClientEvent =
  | SessionUpdateMessage
  | InputAudioBufferAppendMessage
  | InputAudioBufferCommitMessage
  | InputAudioBufferClearMessage
  | ResponseCreateMessage
  | ResponseCancelMessage
  | ConversationItemCreateMessage
  | ConversationItemTruncateMessage;

// ============================================================================
// OpenAI Realtime Server → Client (outbound from us)
// ============================================================================

export interface SessionCreatedMessage {
  type: "session.created";
  session: {
    id: string;
    object: "realtime.session";
    model: string;
    modalities: ("text" | "audio")[];
    instructions: string;
    voice: string;
    input_audio_format: "pcm16" | "g711_ulaw" | "g711_alaw";
    output_audio_format: "pcm16" | "g711_ulaw" | "g711_alaw";
    input_audio_transcription: {
      model: string;
    } | null;
    turn_detection: {
      type: string;
      threshold?: number;
    };
    max_response_output_tokens: number | "inf";
    tool_choice: unknown;
    temperature: number;
    tools: Array<Record<string, unknown>>;
  };
}

export interface SessionUpdatedMessage {
  type: "session.updated";
  session: Record<string, unknown>;
}

export interface InputAudioBufferCommittedMessage {
  type: "input_audio_buffer.committed";
  audio_start_ms: number;
}

export interface InputAudioBufferSpeechStartedMessage {
  type: "input_audio_buffer.speech_started";
  audio_start_ms: number;
}

export interface InputAudioBufferSpeechStoppedMessage {
  type: "input_audio_buffer.speech_stopped";
  audio_start_ms: number;
  audio_end_ms: number;
}

export interface ResponseCreatedMessage {
  type: "response.created";
  response: {
    id: string;
    object: "realtime.response";
    status: "in_progress" | "completed" | "failed" | "cancelled";
    status_details: unknown;
    output: unknown[];
  };
}

export interface ResponseDoneMessage {
  type: "response.done";
  response: {
    id: string;
    status: "completed" | "failed" | "cancelled";
    status_details: unknown;
    output: unknown[];
    usage: {
      input_tokens: number;
      output_tokens: number;
    };
  };
}

export interface ResponseOutputItemAddedMessage {
  type: "response.output_item.added";
  output_index: number;
  item: {
    id: string;
    object: "realtime.item";
    type: "message" | "function_call";
    status: "in_progress" | "completed" | "failed" | "incomplete";
  };
}

export interface ResponseOutputItemDoneMessage {
  type: "response.output_item.done";
  output_index: number;
  item: Record<string, unknown>;
}

export interface ResponseAudioDeltaMessage {
  type: "response.audio.delta";
  output_index: number;
  content_index: number;
  delta: string; // base64
  index: number;
}

export interface ResponseAudioDoneMessage {
  type: "response.audio.done";
  output_index: number;
  content_index: number;
}

export interface ErrorMessage {
  type: "error";
  error: {
    type: string;
    code: string;
    message: string;
    param?: string;
    event_id?: string;
  };
}

export interface RateLimitExceededMessage {
  type: "rate_limits.updated";
  rate_limits: Array<{
    name: string;
    limit: number;
    remaining: number;
    reset_ms: number;
  }>;
}

export type OpenAIRealtimeServerEvent =
  | SessionCreatedMessage
  | SessionUpdatedMessage
  | InputAudioBufferCommittedMessage
  | InputAudioBufferSpeechStartedMessage
  | InputAudioBufferSpeechStoppedMessage
  | ResponseCreatedMessage
  | ResponseDoneMessage
  | ResponseOutputItemAddedMessage
  | ResponseOutputItemDoneMessage
  | ResponseAudioDeltaMessage
  | ResponseAudioDoneMessage
  | ErrorMessage
  | RateLimitExceededMessage;
