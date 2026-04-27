/**
 * Mixed modality types — Phase D.3.
 */
export type Modality = "text" | "audio" | "text+audio";

export interface ModalityState {
  inputModality: Modality;
  outputModality: Modality;
  textInterruptActive: boolean;
  audioOutputActive: boolean;
  textOutputActive: boolean;
  switchCount: number;
  lastSwitchAt: number | null;
}

export interface TextInputMessage {
  type: "text.input";
  text: string;
  timestamp: number;
  interruptTts: boolean;
}

export interface TextOutputChunk {
  type: "text.output";
  text: string;
  timestamp: number;
  isFinal: boolean;
}

export type MixedModalityEvent = "text.input.received" | "text.output.started" | "text.output.done" | "modality.switch" | "audio.fallback" | "session.recover";

export interface SessionRecoveryState {
  sessionId: string;
  duplexState: string;
  modalityState: ModalityState;
  contextTokens: number;
  conversationHistory: ConversationItem[];
  checkpointAt: number;
  recoveryAttempts: number;
}

export interface ConversationItem {
  role: "user" | "assistant";
  modality: "text" | "audio";
  content: string;
  timestamp: number;
}

export interface MixedModalityConfig {
  textInterruptsTts: boolean;
  audioFallbackToText: boolean;
  maxRecoveryItems: number;
  modalitySwitchDebounceMs: number;
  maxRecoveryAttempts: number;
}

export const DEFAULT_MIXED_MODALITY_CONFIG: MixedModalityConfig = {
  textInterruptsTts: true,
  audioFallbackToText: true,
  maxRecoveryItems: 50,
  modalitySwitchDebounceMs: 100,
  maxRecoveryAttempts: 3,
};
