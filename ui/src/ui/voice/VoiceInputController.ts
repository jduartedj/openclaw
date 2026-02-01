/**
 * VoiceInputController - Browser-based speech recognition for WebUI Talk Mode
 *
 * Uses the Web Speech API for real-time speech-to-text transcription.
 * Falls back to MediaRecorder + server-side transcription if Web Speech API is unavailable.
 */

export type VoiceInputState =
  | "idle"
  | "requesting-permission"
  | "listening"
  | "processing"
  | "error";

export type VoiceInputConfig = {
  /** Language for speech recognition (default: 'en-US') */
  lang?: string;
  /** Enable continuous listening mode */
  continuous?: boolean;
  /** Report interim (partial) results */
  interimResults?: boolean;
  /** Silence window in ms before finalizing (default: 700) */
  silenceWindowMs?: number;
  /** Max recording duration in ms (default: 60000) */
  maxDurationMs?: number;
};

export type VoiceInputEvent =
  | { type: "state"; state: VoiceInputState }
  | { type: "interim"; transcript: string }
  | { type: "final"; transcript: string }
  | { type: "error"; error: string }
  | { type: "permission-denied" };

export type VoiceInputListener = (event: VoiceInputEvent) => void;

// Type declarations for Web Speech API (not in standard lib.dom.d.ts)
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
  isFinal: boolean;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message: string;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onaudioend: ((this: SpeechRecognition, ev: Event) => unknown) | null;
  onaudiostart: ((this: SpeechRecognition, ev: Event) => unknown) | null;
  onend: ((this: SpeechRecognition, ev: Event) => unknown) | null;
  onerror:
    | ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => unknown)
    | null;
  onnomatch: ((this: SpeechRecognition, ev: Event) => unknown) | null;
  onresult:
    | ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => unknown)
    | null;
  onsoundend: ((this: SpeechRecognition, ev: Event) => unknown) | null;
  onsoundstart: ((this: SpeechRecognition, ev: Event) => unknown) | null;
  onspeechend: ((this: SpeechRecognition, ev: Event) => unknown) | null;
  onspeechstart: ((this: SpeechRecognition, ev: Event) => unknown) | null;
  onstart: ((this: SpeechRecognition, ev: Event) => unknown) | null;
  abort(): void;
  start(): void;
  stop(): void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognition;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

export class VoiceInputController {
  private recognition: SpeechRecognition | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private listeners: Set<VoiceInputListener> = new Set();
  private silenceTimer: number | null = null;
  private maxDurationTimer: number | null = null;
  private lastTranscript = "";
  private state: VoiceInputState = "idle";
  private config: Required<VoiceInputConfig>;

  constructor(config: VoiceInputConfig = {}) {
    this.config = {
      lang: config.lang ?? "en-US",
      continuous: config.continuous ?? true,
      interimResults: config.interimResults ?? true,
      silenceWindowMs: config.silenceWindowMs ?? 700,
      maxDurationMs: config.maxDurationMs ?? 60000,
    };
  }

  /** Check if Web Speech API is available */
  static isSupported(): boolean {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  /** Check if MediaRecorder fallback is available */
  static isMediaRecorderSupported(): boolean {
    return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  }

  /** Add event listener */
  addListener(listener: VoiceInputListener): void {
    this.listeners.add(listener);
  }

  /** Remove event listener */
  removeListener(listener: VoiceInputListener): void {
    this.listeners.delete(listener);
  }

  /** Get current state */
  getState(): VoiceInputState {
    return this.state;
  }

  /** Start listening for voice input */
  async start(): Promise<boolean> {
    if (this.state !== "idle") {
      return false;
    }

    this.setState("requesting-permission");

    if (VoiceInputController.isSupported()) {
      return this.startWebSpeechAPI();
    } else if (VoiceInputController.isMediaRecorderSupported()) {
      return this.startMediaRecorder();
    } else {
      this.emit({ type: "error", error: "Speech recognition not supported in this browser" });
      this.setState("error");
      return false;
    }
  }

  /** Stop listening */
  stop(): void {
    this.clearTimers();

    if (this.recognition) {
      this.recognition.stop();
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.stop();
    }

    // If we have a transcript, emit it as final
    if (this.lastTranscript.trim()) {
      this.emit({ type: "final", transcript: this.lastTranscript.trim() });
    }

    this.cleanup();
    this.setState("idle");
  }

  /** Abort without finalizing */
  abort(): void {
    this.clearTimers();

    if (this.recognition) {
      this.recognition.abort();
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.stop();
    }

    this.cleanup();
    this.setState("idle");
  }

  private startWebSpeechAPI(): boolean {
    try {
      const SpeechRecognitionClass =
        window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognitionClass) {
        throw new Error("SpeechRecognition not available");
      }

      this.recognition = new SpeechRecognitionClass();
      this.recognition.continuous = this.config.continuous;
      this.recognition.interimResults = this.config.interimResults;
      this.recognition.lang = this.config.lang;

      this.recognition.onstart = () => {
        this.setState("listening");
        this.startMaxDurationTimer();
      };

      this.recognition.onresult = (event: SpeechRecognitionEvent) => {
        this.handleSpeechResult(event);
      };

      this.recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
        this.handleSpeechError(event);
      };

      this.recognition.onend = () => {
        // Auto-restart if in continuous mode and still listening
        if (this.state === "listening" && this.config.continuous) {
          try {
            this.recognition?.start();
          } catch {
            // May fail if already started
          }
        }
      };

      this.recognition.start();
      return true;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.emit({ type: "error", error });
      this.setState("error");
      return false;
    }
  }

  private async startMediaRecorder(): Promise<boolean> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioChunks = [];

      this.mediaRecorder = new MediaRecorder(stream, {
        mimeType: this.getSupportedMimeType(),
      });

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        // Audio chunks are available for server-side processing
        // This would need to be sent to a transcription endpoint
        this.setState("processing");
        this.emit({
          type: "error",
          error: "MediaRecorder fallback requires server-side transcription (not implemented)",
        });
        this.cleanup();
      };

      this.mediaRecorder.start(1000); // Collect data every second
      this.setState("listening");
      this.startMaxDurationTimer();
      return true;
    } catch (err) {
      if ((err as Error).name === "NotAllowedError") {
        this.emit({ type: "permission-denied" });
      } else {
        const error = err instanceof Error ? err.message : String(err);
        this.emit({ type: "error", error });
      }
      this.setState("error");
      return false;
    }
  }

  private handleSpeechResult(event: SpeechRecognitionEvent): void {
    let interimTranscript = "";
    let finalTranscript = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        finalTranscript += result[0].transcript;
      } else {
        interimTranscript += result[0].transcript;
      }
    }

    // Update last transcript for silence detection
    const currentTranscript = (finalTranscript + interimTranscript).trim();
    if (currentTranscript) {
      this.lastTranscript = currentTranscript;
      this.resetSilenceTimer();
    }

    // Emit interim results
    if (interimTranscript) {
      this.emit({ type: "interim", transcript: this.lastTranscript });
    }

    // Emit final results immediately if we have a final result
    if (finalTranscript) {
      this.emit({ type: "interim", transcript: this.lastTranscript });
    }
  }

  private handleSpeechError(event: SpeechRecognitionErrorEvent): void {
    switch (event.error) {
      case "not-allowed":
      case "permission-denied":
        this.emit({ type: "permission-denied" });
        this.setState("error");
        break;
      case "no-speech":
        // This is not really an error, just no speech detected
        break;
      case "audio-capture":
        this.emit({ type: "error", error: "No microphone detected" });
        this.setState("error");
        break;
      case "network":
        this.emit({ type: "error", error: "Network error during speech recognition" });
        this.setState("error");
        break;
      case "aborted":
        // User aborted, not an error
        break;
      default:
        this.emit({ type: "error", error: event.error || "Unknown speech recognition error" });
        this.setState("error");
    }
  }

  private resetSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      window.clearTimeout(this.silenceTimer);
    }

    this.silenceTimer = window.setTimeout(() => {
      if (this.state === "listening" && this.lastTranscript.trim()) {
        // Finalize on silence
        this.emit({ type: "final", transcript: this.lastTranscript.trim() });
        this.lastTranscript = "";
      }
    }, this.config.silenceWindowMs);
  }

  private startMaxDurationTimer(): void {
    this.maxDurationTimer = window.setTimeout(() => {
      this.stop();
    }, this.config.maxDurationMs);
  }

  private clearTimers(): void {
    if (this.silenceTimer !== null) {
      window.clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (this.maxDurationTimer !== null) {
      window.clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }
  }

  private cleanup(): void {
    if (this.recognition) {
      this.recognition.onstart = null;
      this.recognition.onresult = null;
      this.recognition.onerror = null;
      this.recognition.onend = null;
      this.recognition = null;
    }

    if (this.mediaRecorder) {
      // Stop all tracks to release microphone
      this.mediaRecorder.stream.getTracks().forEach((track) => track.stop());
      this.mediaRecorder = null;
    }

    this.audioChunks = [];
    this.lastTranscript = "";
  }

  private setState(state: VoiceInputState): void {
    this.state = state;
    this.emit({ type: "state", state });
  }

  private emit(event: VoiceInputEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[VoiceInputController] Listener error:", err);
      }
    }
  }

  private getSupportedMimeType(): string {
    const mimeTypes = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg",
      "audio/mp4",
    ];

    for (const mimeType of mimeTypes) {
      if (MediaRecorder.isTypeSupported(mimeType)) {
        return mimeType;
      }
    }

    return "audio/webm";
  }

  /** Get the recorded audio blob (only for MediaRecorder fallback) */
  getAudioBlob(): Blob | null {
    if (this.audioChunks.length === 0) return null;
    return new Blob(this.audioChunks, { type: this.getSupportedMimeType() });
  }
}

export default VoiceInputController;
