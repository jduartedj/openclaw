/**
 * TalkModeController - Orchestrates Talk Mode for WebUI
 *
 * Manages the full Talk Mode flow:
 * 1. Listen for speech → transcribe
 * 2. Send transcript to assistant → wait for response
 * 3. Play response as speech
 *
 * Mirrors the behavior of TalkModeManager in iOS/macOS apps.
 */

import { VoiceInputController, type VoiceInputEvent } from "./VoiceInputController";
import { AudioStreamPlayer, playStreamingAudio } from "./AudioStreamPlayer";
import type { GatewayBrowserClient } from "../gateway";

export type TalkPhase = "off" | "listening" | "thinking" | "speaking";

export type TalkModeConfig = {
  /** Language for speech recognition */
  lang?: string;
  /** Session key for chat */
  sessionKey?: string;
  /** Enable interrupt on speech (stop TTS when user speaks) */
  interruptOnSpeech?: boolean;
  /** Silence window before finalizing speech (ms) */
  silenceWindowMs?: number;
  /** TTS provider to use */
  ttsProvider?: "openai" | "elevenlabs" | "edge";
  /** Gateway base URL for TTS streaming */
  gatewayBaseUrl?: string;
};

export type TalkModeEvent =
  | { type: "phase"; phase: TalkPhase }
  | { type: "transcript"; transcript: string; isFinal: boolean }
  | { type: "response"; text: string }
  | { type: "error"; error: string }
  | { type: "permission-denied" };

export type TalkModeListener = (event: TalkModeEvent) => void;

export class TalkModeController {
  private voiceInput: VoiceInputController;
  private audioPlayer: AudioStreamPlayer;
  private gateway: GatewayBrowserClient | null = null;
  private listeners: Set<TalkModeListener> = new Set();
  private phase: TalkPhase = "off";
  private config: Required<TalkModeConfig>;
  private currentRunId: string | null = null;
  private lastInterruptedAt: number | null = null;
  private isEnabled = false;

  constructor(config: TalkModeConfig = {}) {
    this.config = {
      lang: config.lang ?? "en-US",
      sessionKey: config.sessionKey ?? "main",
      interruptOnSpeech: config.interruptOnSpeech ?? true,
      silenceWindowMs: config.silenceWindowMs ?? 700,
      ttsProvider: config.ttsProvider ?? "edge",
      gatewayBaseUrl: config.gatewayBaseUrl ?? "",
    };

    this.voiceInput = new VoiceInputController({
      lang: this.config.lang,
      continuous: true,
      interimResults: true,
      silenceWindowMs: this.config.silenceWindowMs,
    });

    this.audioPlayer = new AudioStreamPlayer({
      sampleRate: 44100,
      channels: 1,
    });

    this.setupEventHandlers();
  }

  /** Check if Talk Mode is supported in this browser */
  static isSupported(): boolean {
    return VoiceInputController.isSupported();
  }

  /** Attach gateway client */
  attachGateway(gateway: GatewayBrowserClient): void {
    this.gateway = gateway;
  }

  /** Update session key */
  setSessionKey(sessionKey: string): void {
    this.config.sessionKey = sessionKey;
  }

  /** Update gateway base URL */
  setGatewayBaseUrl(url: string): void {
    this.config.gatewayBaseUrl = url.replace(/\/+$/, "");
  }

  /** Add event listener */
  addListener(listener: TalkModeListener): void {
    this.listeners.add(listener);
  }

  /** Remove event listener */
  removeListener(listener: TalkModeListener): void {
    this.listeners.delete(listener);
  }

  /** Get current phase */
  getPhase(): TalkPhase {
    return this.phase;
  }

  /** Check if enabled */
  isActive(): boolean {
    return this.isEnabled;
  }

  /** Enable Talk Mode */
  async enable(): Promise<boolean> {
    if (this.isEnabled) return true;

    // Initialize audio player (requires user gesture)
    const audioOk = await this.audioPlayer.initialize();
    if (!audioOk) {
      this.emit({ type: "error", error: "Failed to initialize audio playback" });
      return false;
    }

    // Start voice input
    const voiceOk = await this.voiceInput.start();
    if (!voiceOk) {
      return false;
    }

    this.isEnabled = true;
    this.setPhase("listening");

    // Notify gateway of talk mode state
    this.notifyTalkMode(true);

    return true;
  }

  /** Disable Talk Mode */
  disable(): void {
    if (!this.isEnabled) return;

    this.isEnabled = false;
    this.voiceInput.stop();
    this.audioPlayer.stop();
    this.setPhase("off");

    // Notify gateway of talk mode state
    this.notifyTalkMode(false);
  }

  /** Toggle Talk Mode */
  async toggle(): Promise<boolean> {
    if (this.isEnabled) {
      this.disable();
      return false;
    }
    return this.enable();
  }

  /** Stop current speech output (interrupt) */
  stopSpeaking(): void {
    if (this.phase === "speaking") {
      this.lastInterruptedAt = this.audioPlayer.stop() ?? null;
      this.setPhase("listening");
      this.restartListening();
    }
  }

  /** Clean up resources */
  dispose(): void {
    this.disable();
    this.audioPlayer.dispose();
    this.listeners.clear();
  }

  private setupEventHandlers(): void {
    this.voiceInput.addListener((event) => this.handleVoiceEvent(event));

    this.audioPlayer.addListener((event) => {
      if (event.type === "ended") {
        if (this.phase === "speaking") {
          this.setPhase("listening");
          this.restartListening();
        }
      } else if (event.type === "error") {
        this.emit({ type: "error", error: event.error });
      }
    });
  }

  private handleVoiceEvent(event: VoiceInputEvent): void {
    switch (event.type) {
      case "state":
        // Voice input state changed
        break;

      case "interim":
        this.emit({ type: "transcript", transcript: event.transcript, isFinal: false });
        // Check for interrupt during speaking
        if (this.phase === "speaking" && this.config.interruptOnSpeech) {
          if (this.shouldInterrupt(event.transcript)) {
            this.stopSpeaking();
          }
        }
        break;

      case "final":
        this.emit({ type: "transcript", transcript: event.transcript, isFinal: true });
        if (event.transcript.trim() && this.phase === "listening") {
          this.processTranscript(event.transcript);
        }
        break;

      case "error":
        this.emit({ type: "error", error: event.error });
        break;

      case "permission-denied":
        this.emit({ type: "permission-denied" });
        this.disable();
        break;
    }
  }

  private async processTranscript(transcript: string): Promise<void> {
    if (!this.gateway) {
      this.emit({ type: "error", error: "Gateway not connected" });
      return;
    }

    // Stop listening while processing
    this.voiceInput.stop();
    this.setPhase("thinking");

    try {
      // Build prompt with interruption context
      const prompt = this.buildPrompt(transcript);

      // Send chat message
      const runId = await this.sendChat(prompt);
      this.currentRunId = runId;

      // Wait for response
      const responseText = await this.waitForResponse(runId);
      if (!responseText) {
        this.emit({ type: "error", error: "No response from assistant" });
        this.setPhase("listening");
        this.restartListening();
        return;
      }

      this.emit({ type: "response", text: responseText });

      // Play response
      await this.playResponse(responseText);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.emit({ type: "error", error });
      this.setPhase("listening");
      this.restartListening();
    }
  }

  private buildPrompt(transcript: string): string {
    // Add interruption context if available
    if (this.lastInterruptedAt !== null) {
      const interruptedAt = this.lastInterruptedAt;
      this.lastInterruptedAt = null;
      return `${transcript}\n\n[Note: I interrupted you at ${interruptedAt.toFixed(1)}s into your previous response]`;
    }
    return transcript;
  }

  private async sendChat(message: string): Promise<string> {
    if (!this.gateway) throw new Error("Gateway not connected");

    const idempotencyKey = crypto.randomUUID();

    const response = await this.gateway.request<{ runId: string }>("chat.send", {
      sessionKey: this.config.sessionKey,
      message,
      thinking: "low",
      timeoutMs: 30000,
      idempotencyKey,
    });

    return response.runId;
  }

  private async waitForResponse(runId: string, timeoutMs = 60000): Promise<string | null> {
    if (!this.gateway) return null;

    const startTime = Date.now();
    // Convert to seconds for timestamp comparison, with a small buffer for clock drift
    const startTimeSec = (startTime / 1000) - 1;

    // Poll for completion
    while (Date.now() - startTime < timeoutMs) {
      if (!this.isEnabled) return null;

      try {
        const history = await this.gateway.request<{
          messages: Array<{
            role: string;
            content: Array<{ type: string; text?: string }>;
            timestamp?: number;
          }>;
        }>("chat.history", {
          sessionKey: this.config.sessionKey,
          limit: 5, // Reduced - we only need recent messages
        });

        // Find latest assistant message after our start time
        // Messages are usually in chronological order, so check from the end
        for (let i = history.messages.length - 1; i >= 0; i--) {
          const m = history.messages[i];
          if (m.role !== "assistant") continue;

          // Check timestamp (if available) - must be after we started
          const msgTimestamp = m.timestamp ?? 0;
          if (msgTimestamp > 0 && msgTimestamp < startTimeSec) continue;

          const text = m.content
            .filter((c) => c.type === "text" && c.text)
            .map((c) => c.text)
            .join("\n")
            .trim();

          if (text) return text;
        }
      } catch {
        // Retry on error
      }

      await this.sleep(500);
    }

    return null;
  }

  private async playResponse(text: string): Promise<void> {
    this.setPhase("speaking");

    // Start listening for interrupts if enabled
    if (this.config.interruptOnSpeech) {
      await this.voiceInput.start();
    }

    try {
      // Try streaming TTS first (lower latency)
      const streamUrl = this.buildTtsStreamUrl(text);
      await playStreamingAudio(streamUrl, this.audioPlayer);
      return;
    } catch (err) {
      console.warn("[TalkModeController] Streaming TTS failed, trying fallback:", err);
    }

    try {
      // Fallback to non-streaming TTS
      const audioPath = await this.requestTTS(text);
      if (audioPath) {
        const audioUrl = this.buildAudioUrl(audioPath);
        await this.audioPlayer.playUrl(audioUrl);
        return;
      }
    } catch (err) {
      console.warn("[TalkModeController] Gateway TTS failed:", err);
    }

    // Final fallback to browser's built-in TTS
    await this.speakWithBrowserTTS(text);
  }

  private buildTtsStreamUrl(text: string): string {
    const base = this.config.gatewayBaseUrl || window.location.origin;
    const params = new URLSearchParams({
      text: text.slice(0, 5000), // Limit text length
    });
    return `${base}/tts/stream?${params.toString()}`;
  }

  private async requestTTS(text: string): Promise<string | null> {
    if (!this.gateway) return null;

    try {
      const result = await this.gateway.request<{
        audioPath?: string;
        error?: string;
      }>("tts.convert", {
        text,
        channel: "webchat",
      });

      return result.audioPath ?? null;
    } catch {
      return null;
    }
  }

  private buildAudioUrl(audioPath: string): string {
    // If it's already a URL, return as-is
    if (audioPath.startsWith("http://") || audioPath.startsWith("https://")) {
      return audioPath;
    }

    // Build URL from gateway base
    const base = this.config.gatewayBaseUrl || window.location.origin;
    return `${base}/media/${encodeURIComponent(audioPath)}`;
  }

  private speakWithBrowserTTS(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!("speechSynthesis" in window)) {
        reject(new Error("Browser TTS not supported"));
        return;
      }

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = this.config.lang;
      utterance.rate = 1.0;
      utterance.pitch = 1.0;

      utterance.onend = () => resolve();
      utterance.onerror = (event) => reject(new Error(event.error));

      speechSynthesis.speak(utterance);
    });
  }

  private shouldInterrupt(transcript: string): boolean {
    // Only interrupt if user said something substantial
    const trimmed = transcript.trim();
    return trimmed.length >= 3;
  }

  private async restartListening(): Promise<void> {
    if (this.isEnabled && this.phase === "listening") {
      await this.voiceInput.start();
    }
  }

  private notifyTalkMode(enabled: boolean): void {
    if (!this.gateway) return;

    this.gateway.request("talk.mode", {
      enabled,
      phase: enabled ? this.phase : "off",
    }).catch(() => {
      // talk.mode may fail if no mobile node connected - that's OK for WebUI
    });
  }

  private setPhase(phase: TalkPhase): void {
    this.phase = phase;
    this.emit({ type: "phase", phase });
  }

  private emit(event: TalkModeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[TalkModeController] Listener error:", err);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default TalkModeController;
