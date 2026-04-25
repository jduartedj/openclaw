/**
 * OpenAI Realtime API compatibility adapter — Phase D.2.
 *
 * Bridges OpenAI Realtime WebSocket messages ↔ our internal duplex
 * protocol (DuplexSession + AudioInput/Output + BackpressureMonitor).
 *
 * Translation mapping:
 *   Client → Us:
 *     - session.update → DuplexSession config
 *     - input_audio_buffer.append → AudioInputStream.buffer.append()
 *     - input_audio_buffer.commit → AudioInputStream.commit()
 *     - input_audio_buffer.clear → AudioInputStream.clear()
 *     - response.create → signal downstream (LLM provider)
 *     - response.cancel → cancel in-flight response
 *     - conversation.item.truncate → DuplexSession interrupt + barge-in
 *
 *   Us → Client:
 *     - DuplexSession.state → session.updated
 *     - AudioInputStream events → input_audio_buffer.*
 *     - AudioOutputStream audio → response.audio.delta
 *     - Backpressure signals → rate_limits.updated (throttle indicator)
 *
 * Pure module: no timers, no I/O. Caller bridges WebSocket.
 */

import { AudioInputStream } from "../audio/audio-input-stream.js";
import { AudioOutputStream } from "../audio/audio-output-stream.js";
import type {
  OpenAIRealtimeClientEvent,
  OpenAIRealtimeServerEvent,
  SessionUpdateMessage,
  InputAudioBufferAppendMessage,
  InputAudioBufferCommitMessage,
  InputAudioBufferClearMessage,
  ResponseCreateMessage,
  ResponseCancelMessage,
  ConversationItemTruncateMessage,
} from "./openai-realtime-types.js";
import type { DuplexEvent } from "./types.js";

export interface OpenAIRealtimeAdapterOptions {
  /** Inbound client events are decoded/validated here (caller owns WebSocket). */
  onDecodeError?: (error: Error, raw: unknown) => void;
  /** Outbound server events go here (caller delivers to WebSocket). */
  sendServerEvent: (event: OpenAIRealtimeServerEvent) => void;
  /** Called when client updates session config. */
  onSessionUpdate?: (config: SessionUpdateMessage["session"]) => void;
  /** Called when client explicitly cancels a response. */
  onResponseCancel?: () => void;
  /** Called when audio truncation requested (barge-in). */
  onTruncate?: (itemId: string, audioEndMs: number) => void;
}

export class OpenAIRealtimeAdapter {
  private readonly opts: Required<
    Omit<
      OpenAIRealtimeAdapterOptions,
      "onDecodeError" | "onSessionUpdate" | "onResponseCancel" | "onTruncate"
    >
  > &
    Pick<
      OpenAIRealtimeAdapterOptions,
      "onDecodeError" | "onSessionUpdate" | "onResponseCancel" | "onTruncate"
    >;

  private sessionId: string;
  private audioIn: AudioInputStream | null = null;
  private audioOut: AudioOutputStream | null = null;
  private lastResponseId: string | null = null;
  private pendingAudioIndex = 0;

  constructor(options: OpenAIRealtimeAdapterOptions) {
    this.opts = {
      sendServerEvent: options.sendServerEvent,
      onDecodeError: options.onDecodeError,
      onSessionUpdate: options.onSessionUpdate,
      onResponseCancel: options.onResponseCancel,
      onTruncate: options.onTruncate,
    };
    this.sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  /**
   * Parse an incoming WebSocket message from the client and dispatch it.
   * Handles JSON parsing + type routing.
   */
  handleClientMessage(rawJson: unknown): void {
    let event: OpenAIRealtimeClientEvent;
    try {
      if (typeof rawJson !== "object" || rawJson === null) {
        throw new TypeError("Expected object");
      }
      const obj = rawJson as Record<string, unknown>;
      const type = obj.type;
      if (typeof type !== "string") {
        throw new TypeError("Missing or invalid type field");
      }
      event = this.validateClientEvent(obj as unknown);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.opts.onDecodeError?.(error, rawJson);
      this.sendError("invalid_request_error", error.message);
      return;
    }

    try {
      switch (event.type) {
        case "session.update":
          this.handleSessionUpdate(event);
          break;
        case "input_audio_buffer.append":
          this.handleInputAudioBufferAppend(event);
          break;
        case "input_audio_buffer.commit":
          this.handleInputAudioBufferCommit(event);
          break;
        case "input_audio_buffer.clear":
          this.handleInputAudioBufferClear(event);
          break;
        case "response.create":
          this.handleResponseCreate(event);
          break;
        case "response.cancel":
          this.handleResponseCancel(event);
          break;
        case "conversation.item.create":
          // D.2 scope: no-op; conversation mgmt deferred
          break;
        case "conversation.item.truncate":
          this.handleConversationItemTruncate(event);
          break;
        default:
          this.sendError(
            "invalid_request_error",
            `Unknown event type: ${String((event as Record<string, unknown>).type)}`,
          );
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.opts.onDecodeError?.(error, event);
      this.sendError("server_error", error.message);
    }
  }

  /**
   * Bind audio streams so we can translate their events to OpenAI format.
   */
  bindAudioStreams(audioIn: AudioInputStream, audioOut: AudioOutputStream): void {
    this.audioIn = audioIn;
    this.audioOut = audioOut;
  }

  /**
   * Translate an internal DuplexEvent to OpenAI Realtime server event(s).
   * Called by DuplexSession or coordinator to push state changes to client.
   */
  emitDuplexEvent(duplexEvent: DuplexEvent, meta?: Record<string, unknown>): void {
    switch (duplexEvent) {
      case "user.speech.started":
        this.opts.sendServerEvent({
          type: "input_audio_buffer.speech_started",
          audio_start_ms: (meta?.audioStartMs as number) ?? 0,
        });
        break;
      case "user.speech.stopped":
        this.opts.sendServerEvent({
          type: "input_audio_buffer.speech_stopped",
          audio_start_ms: (meta?.audioStartMs as number) ?? 0,
          audio_end_ms: (meta?.audioEndMs as number) ?? 0,
        });
        break;
      case "response.started":
        this.lastResponseId = `response_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        this.pendingAudioIndex = 0;
        this.opts.sendServerEvent({
          type: "response.created",
          response: {
            id: this.lastResponseId,
            object: "realtime.response",
            status: "in_progress",
            status_details: null,
            output: [],
          },
        });
        break;
      case "response.audio_done":
        if (this.lastResponseId) {
          this.opts.sendServerEvent({
            type: "response.audio.done",
            output_index: 0,
            content_index: this.pendingAudioIndex++,
          });
        }
        break;
      case "duplex.session.end":
        if (this.lastResponseId) {
          this.opts.sendServerEvent({
            type: "response.done",
            response: {
              id: this.lastResponseId,
              status: "completed",
              status_details: null,
              output: [],
              usage: {
                input_tokens: 0,
                output_tokens: 0,
              },
            },
          });
        }
        break;
      case "interrupt":
      case "rollback.complete":
      case "session.pause":
      case "session.resume":
      case "session.error":
      case "timeout":
      case "duplex.session.start":
        // These are control-plane or internal; not directly mapped to OpenAI events.
        break;
    }
  }

  /** Emit audio delta frames (called when AudioOutputStream pushes). */
  emitAudioDelta(base64Audio: string, contentIndex = 0): void {
    if (!this.lastResponseId) {
      return;
    }
    this.opts.sendServerEvent({
      type: "response.audio.delta",
      output_index: 0,
      content_index: contentIndex,
      delta: base64Audio,
      index: contentIndex,
    });
  }

  /** Snapshot of current session for diagnostics. */
  snapshot(): {
    sessionId: string;
    lastResponseId: string | null;
    hasAudioIn: boolean;
    hasAudioOut: boolean;
  } {
    return {
      sessionId: this.sessionId,
      lastResponseId: this.lastResponseId,
      hasAudioIn: this.audioIn !== null,
      hasAudioOut: this.audioOut !== null,
    };
  }

  // =========================================================================
  // Private: handler implementations
  // =========================================================================

  private handleSessionUpdate(event: SessionUpdateMessage): void {
    this.opts.onSessionUpdate?.(event.session);
    this.opts.sendServerEvent({
      type: "session.updated",
      session: event.session,
    });
  }

  private handleInputAudioBufferAppend(event: InputAudioBufferAppendMessage): void {
    if (!this.audioIn) {
      this.sendError("invalid_request_error", "Audio input not bound");
      return;
    }
    try {
      const buffer = Buffer.from(event.audio, "base64");
      this.audioIn.buffer.append(buffer);
      this.opts.sendServerEvent({
        type: "input_audio_buffer.committed",
        audio_start_ms: 0,
      });
    } catch (err) {
      this.sendError(
        "invalid_request_error",
        `Invalid audio format: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private handleInputAudioBufferCommit(_event: InputAudioBufferCommitMessage): void {
    if (!this.audioIn) {
      this.sendError("invalid_request_error", "Audio input not bound");
      return;
    }
    const result = this.audioIn.commit();
    if (result) {
      this.opts.sendServerEvent({
        type: "input_audio_buffer.committed",
        audio_start_ms: 0,
      });
    }
  }

  private handleInputAudioBufferClear(_event: InputAudioBufferClearMessage): void {
    if (!this.audioIn) {
      this.sendError("invalid_request_error", "Audio input not bound");
      return;
    }
    this.audioIn.clear();
  }

  private handleResponseCreate(_event: ResponseCreateMessage): void {
    this.opts.onResponseCancel?.(); // Ideally: cancel prior response
    // In a full implementation: signal LLM provider to begin synthesis
    // For D.2 scope, this is mostly a no-op (provider already streaming).
  }

  private handleResponseCancel(_event: ResponseCancelMessage): void {
    this.opts.onResponseCancel?.();
    if (this.lastResponseId) {
      this.opts.sendServerEvent({
        type: "response.done",
        response: {
          id: this.lastResponseId,
          status: "cancelled",
          status_details: null,
          output: [],
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        },
      });
      this.lastResponseId = null;
    }
  }

  private handleConversationItemTruncate(event: ConversationItemTruncateMessage): void {
    this.opts.onTruncate?.(event.item_id, event.audio_end_ms);
  }

  private validateClientEvent(obj: unknown): OpenAIRealtimeClientEvent {
    // Minimal validation; full validation deferred to handlers.
    if (typeof obj !== "object" || obj === null) {
      throw new TypeError("Event must be an object");
    }
    return obj as unknown as OpenAIRealtimeClientEvent;
  }

  private sendError(code: string, message: string): void {
    this.opts.sendServerEvent({
      type: "error",
      error: {
        type: "invalid_request_error",
        code,
        message,
      },
    });
  }
}
