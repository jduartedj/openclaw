/**
 * Duplex session types — Phase D.1.
 */

export enum DuplexState {
  INIT = "init",
  LISTENING = "listening",
  AGENT_SPEAKING = "agent_speaking",
  SIMULTANEOUS = "simultaneous",
  ROLLING_BACK = "rolling_back",
  PAUSED = "paused",
  ENDED = "ended",
  ERROR = "error",
}

export type DuplexEvent =
  | "duplex.session.start"
  | "duplex.session.end"
  | "user.speech.started"
  | "user.speech.stopped"
  | "response.started"
  | "response.audio_done"
  | "interrupt"
  | "rollback.complete"
  | "session.pause"
  | "session.resume"
  | "session.error"
  | "timeout";

export interface TransitionMeta {
  timestamp: number;
  reason?: string;
  interruptLatencyMs?: number;
  [key: string]: unknown;
}

export interface StateTransition {
  from: DuplexState;
  to: DuplexState;
  event: DuplexEvent;
  meta: TransitionMeta;
}

export interface DuplexSessionStartMessage {
  type: "duplex.session.start";
  sessionId: string;
  role: "user" | "agent";
  capabilities: DuplexCapabilities;
  initiatedAt: number;
}

export interface DuplexCapabilities {
  supportsBargein: boolean;
  supportsTextInterrupt: boolean;
  supportsVideoInterrupt?: boolean;
  maxConcurrentTts: number;
}

export interface DuplexSessionEndMessage {
  type: "duplex.session.end";
  sessionId: string;
  reason: "user_hang_up" | "agent_completed" | "error" | "timeout";
  finalStats?: DuplexSessionStats;
}

export interface DuplexSessionStats {
  totalSpeakTimeMs: number;
  totalListenTimeMs: number;
  interruptCount: number;
  avgInterruptLatencyMs: number;
}

export interface InterruptMessage {
  type: "interrupt";
  interruptId: string;
  streamId: number;
  reason: "user_spoke" | "explicit" | "timeout";
  interruptedAtMs: number;
  expectedRollbackBytes?: number;
}

export interface BargeInAckMessage {
  type: "barge_in.ack";
  interruptId: string;
  contextRolledBackBytes: number;
  newTtsInitiatedAt: number;
  expectedLatencyMs: number;
}

export interface SessionStateMessage {
  type: "session.state";
  sessionId: string;
  state: DuplexState;
  timestamp: number;
}

export type DuplexControlMessage =
  | DuplexSessionStartMessage
  | DuplexSessionEndMessage
  | InterruptMessage
  | BargeInAckMessage
  | SessionStateMessage;

export const DUPLEX_MESSAGE_TYPES = [
  "duplex.session.start",
  "duplex.session.end",
  "interrupt",
  "barge_in.ack",
  "session.state",
] as const;

export type DuplexMessageType = (typeof DUPLEX_MESSAGE_TYPES)[number];

export function isDuplexMessageType(type: string): type is DuplexMessageType {
  return (DUPLEX_MESSAGE_TYPES as readonly string[]).includes(type);
}
