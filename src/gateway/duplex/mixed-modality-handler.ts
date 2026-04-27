/**
 * Mixed modality handler — Phase D.3.
 * Pure module: no I/O, clock-injectable for deterministic testing.
 */
import type { DuplexSession } from "./session.js";
import type { AudioOutputStream } from "../audio/audio-output-stream.js";
import type {
  Modality, ModalityState, TextInputMessage, TextOutputChunk,
  ConversationItem, MixedModalityConfig, SessionRecoveryState, MixedModalityEvent,
} from "./mixed-modality-types.js";
import { DEFAULT_MIXED_MODALITY_CONFIG } from "./mixed-modality-types.js";
import { DuplexState } from "./types.js";

export interface MixedModalityHandlerOptions {
  session: DuplexSession;
  audioOutput: AudioOutputStream;
  config?: Partial<MixedModalityConfig>;
  now?: () => number;
  onTextInput?: (text: string, interruptedAudio: boolean) => void;
  onTextOutput?: (chunk: TextOutputChunk) => void;
  onModalitySwitch?: (from: Modality, to: Modality, direction: "input" | "output") => void;
  onAudioFallback?: (reason: string) => void;
  onRecoveryAttempt?: (state: SessionRecoveryState, attempt: number) => void;
}

export class MixedModalityHandler {
  private readonly session: DuplexSession;
  private readonly audioOutput: AudioOutputStream;
  private readonly config: MixedModalityConfig;
  private readonly clock: () => number;
  private readonly onTextInput?: (text: string, interruptedAudio: boolean) => void;
  private readonly onTextOutput?: (chunk: TextOutputChunk) => void;
  private readonly onModalitySwitch?: (from: Modality, to: Modality, direction: "input" | "output") => void;
  private readonly onAudioFallback?: (reason: string) => void;
  private readonly onRecoveryAttempt?: (state: SessionRecoveryState, attempt: number) => void;

  private modalityData: ModalityState = {
    inputModality: "audio", outputModality: "audio",
    textInterruptActive: false, audioOutputActive: false, textOutputActive: false,
    switchCount: 0, lastSwitchAt: null,
  };

  private history: ConversationItem[] = [];
  private textBuf = "";
  private lastSwitchAt = 0;
  private recoveryCount = 0;
  private textInterrupts = 0;
  private audioFallbacks = 0;
  private eventLog: Array<{ event: MixedModalityEvent; timestamp: number; meta?: Record<string, unknown> }> = [];

  constructor(options: MixedModalityHandlerOptions) {
    this.session = options.session;
    this.audioOutput = options.audioOutput;
    this.config = { ...DEFAULT_MIXED_MODALITY_CONFIG, ...options.config };
    this.clock = options.now ?? (() => Date.now());
    this.onTextInput = options.onTextInput;
    this.onTextOutput = options.onTextOutput;
    this.onModalitySwitch = options.onModalitySwitch;
    this.onAudioFallback = options.onAudioFallback;
    this.onRecoveryAttempt = options.onRecoveryAttempt;
  }

  get modalityState(): Readonly<ModalityState> { return { ...this.modalityData }; }
  get conversationHistory(): readonly ConversationItem[] { return this.history; }

  get stats() {
    return {
      switchCount: this.modalityData.switchCount,
      textInterruptCount: this.textInterrupts,
      audioFallbackCount: this.audioFallbacks,
      recoveryAttempts: this.recoveryCount,
      conversationItems: this.history.length,
      events: this.eventLog.length,
    };
  }

  handleTextInput(message: TextInputMessage): { processed: boolean; interruptedAudio: boolean; previousModality: Modality } {
    const now = message.timestamp || this.clock();
    const state = this.session.state;
    const previousModality = this.modalityData.inputModality;
    let interruptedAudio = false;

    if (state === DuplexState.ENDED || state === DuplexState.ERROR) {
      return { processed: false, interruptedAudio: false, previousModality };
    }

    if (this.modalityData.inputModality !== "text" && this.modalityData.inputModality !== "text+audio") {
      this.switchMod("input", previousModality, "text");
    }

    this.logEvent("text.input.received", now, { text: message.text });

    if (message.interruptTts && this.config.textInterruptsTts && this.modalityData.audioOutputActive
        && (state === DuplexState.AGENT_SPEAKING || state === DuplexState.SIMULTANEOUS)) {
      this.modalityData.textInterruptActive = true;
      this.textInterrupts++;
      interruptedAudio = true;
      void this.session.triggerInterrupt("explicit");
      this.modalityData.audioOutputActive = false;
    }

    this.addItem({ role: "user", modality: "text", content: message.text, timestamp: now });
    try { this.onTextInput?.(message.text, interruptedAudio); } catch { /* never poison */ }
    return { processed: true, interruptedAudio, previousModality };
  }

  handleTextOutput(text: string, isFinal: boolean): void {
    const now = this.clock();
    if (!this.modalityData.textOutputActive) {
      this.modalityData.textOutputActive = true;
      if (this.modalityData.outputModality === "audio") this.switchMod("output", "audio", "text+audio");
      this.logEvent("text.output.started", now);
    }
    this.textBuf += text;
    const chunk: TextOutputChunk = { type: "text.output", text, timestamp: now, isFinal };
    try { this.onTextOutput?.(chunk); } catch { /* never poison */ }
    if (isFinal) {
      this.addItem({ role: "assistant", modality: "text", content: this.textBuf, timestamp: now });
      this.textBuf = "";
      this.modalityData.textOutputActive = false;
      this.logEvent("text.output.done", now);
    }
  }

  onAudioOutputStarted(): void {
    this.modalityData.audioOutputActive = true;
    if (this.modalityData.outputModality === "text") this.switchMod("output", "text", "text+audio");
    else if (this.modalityData.outputModality !== "text+audio") this.modalityData.outputModality = "audio";
  }

  onAudioOutputDone(): void {
    this.modalityData.audioOutputActive = false;
    this.modalityData.textInterruptActive = false;
    if (this.modalityData.outputModality === "text+audio" && !this.modalityData.textOutputActive) {
      this.switchMod("output", "text+audio", "audio");
    }
  }

  handleAudioFailure(reason: string): { fellBack: boolean } {
    if (!this.config.audioFallbackToText) return { fellBack: false };
    const now = this.clock();
    this.audioFallbacks++;
    const prevIn = this.modalityData.inputModality;
    const prevOut = this.modalityData.outputModality;
    if (prevIn !== "text") this.switchMod("input", prevIn, "text");
    if (prevOut !== "text") this.switchMod("output", prevOut, "text");
    this.modalityData.audioOutputActive = false;
    this.logEvent("audio.fallback", now, { reason });
    try { this.onAudioFallback?.(reason); } catch { /* never poison */ }
    return { fellBack: true };
  }

  handleSimultaneousInput(textMessage: TextInputMessage, hasAudioActive: boolean): { textQueued: boolean; audioTakesPrecedence: boolean } {
    if (hasAudioActive) {
      if (this.modalityData.inputModality !== "text+audio") this.switchMod("input", this.modalityData.inputModality, "text+audio");
      const result = this.handleTextInput({ ...textMessage, interruptTts: false });
      return { textQueued: result.processed, audioTakesPrecedence: true };
    }
    this.handleTextInput(textMessage);
    return { textQueued: false, audioTakesPrecedence: false };
  }

  createCheckpoint(): SessionRecoveryState {
    return {
      sessionId: this.session.sessionId, duplexState: this.session.state,
      modalityState: { ...this.modalityData }, contextTokens: 0,
      conversationHistory: this.history.slice(-this.config.maxRecoveryItems),
      checkpointAt: this.clock(), recoveryAttempts: this.recoveryCount,
    };
  }

  attemptRecovery(checkpoint: SessionRecoveryState): { recovered: boolean; reason?: string } {
    this.recoveryCount++;
    this.logEvent("session.recover", this.clock(), { attempt: this.recoveryCount, fromState: checkpoint.duplexState });
    if (this.recoveryCount > this.config.maxRecoveryAttempts) return { recovered: false, reason: "max_recovery_attempts_exceeded" };
    this.history = [...checkpoint.conversationHistory];
    this.modalityData = { ...checkpoint.modalityState, audioOutputActive: false, textOutputActive: false, textInterruptActive: false };
    try { this.onRecoveryAttempt?.(checkpoint, this.recoveryCount); } catch { /* never poison */ }
    return { recovered: true };
  }

  addAudioTranscript(role: "user" | "assistant", transcript: string): void {
    this.addItem({ role, modality: "audio", content: transcript, timestamp: this.clock() });
  }

  resetModality(): void {
    this.modalityData = {
      inputModality: "audio", outputModality: "audio",
      textInterruptActive: false, audioOutputActive: false, textOutputActive: false,
      switchCount: this.modalityData.switchCount, lastSwitchAt: this.modalityData.lastSwitchAt,
    };
    this.textBuf = "";
  }

  private switchMod(direction: "input" | "output", from: Modality, to: Modality): void {
    const now = this.clock();
    if (now - this.lastSwitchAt < this.config.modalitySwitchDebounceMs) {
      if (direction === "input") this.modalityData.inputModality = to;
      else this.modalityData.outputModality = to;
      return;
    }
    if (direction === "input") this.modalityData.inputModality = to;
    else this.modalityData.outputModality = to;
    this.modalityData.switchCount++;
    this.modalityData.lastSwitchAt = now;
    this.lastSwitchAt = now;
    this.logEvent("modality.switch", now, { direction, from, to });
    try { this.onModalitySwitch?.(from, to, direction); } catch { /* never poison */ }
  }

  private addItem(item: ConversationItem): void {
    this.history.push(item);
    if (this.history.length > this.config.maxRecoveryItems) {
      this.history = this.history.slice(-this.config.maxRecoveryItems);
    }
  }

  private logEvent(event: MixedModalityEvent, timestamp: number, meta?: Record<string, unknown>): void {
    this.eventLog.push({ event, timestamp, meta });
  }
}
