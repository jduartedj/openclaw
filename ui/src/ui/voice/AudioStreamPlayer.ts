/**
 * AudioStreamPlayer - Streaming audio playback for WebUI Talk Mode
 *
 * Supports:
 * - Streaming MP3/Opus audio playback via Web Audio API
 * - PCM audio streaming with configurable sample rate
 * - Interrupt support for Talk Mode
 */

export type AudioStreamState =
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  | "stopped"
  | "error";

export type AudioStreamEvent =
  | { type: "state"; state: AudioStreamState }
  | { type: "progress"; currentTime: number; duration: number | null }
  | { type: "ended"; interrupted: boolean; interruptedAtSeconds?: number }
  | { type: "error"; error: string };

export type AudioStreamListener = (event: AudioStreamEvent) => void;

export type AudioStreamConfig = {
  /** Sample rate for PCM audio (default: 44100) */
  sampleRate?: number;
  /** Number of channels (default: 1 for mono) */
  channels?: number;
  /** Buffer size in seconds before starting playback (default: 0.1) */
  bufferSizeSeconds?: number;
};

export class AudioStreamPlayer {
  private audioContext: AudioContext | null = null;
  private currentSource: AudioBufferSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private listeners: Set<AudioStreamListener> = new Set();
  private state: AudioStreamState = "idle";
  private startTime = 0;
  private playbackStartOffset = 0;
  private interrupted = false;
  private config: Required<AudioStreamConfig>;

  // For streaming playback
  private audioQueue: AudioBuffer[] = [];
  private isPlaying = false;
  private scheduledEndTime = 0;

  // Playback session ID to prevent stale callbacks from affecting new playback
  private playbackSessionId = 0;

  constructor(config: AudioStreamConfig = {}) {
    this.config = {
      sampleRate: config.sampleRate ?? 44100,
      channels: config.channels ?? 1,
      bufferSizeSeconds: config.bufferSizeSeconds ?? 0.1,
    };
  }

  /** Add event listener */
  addListener(listener: AudioStreamListener): void {
    this.listeners.add(listener);
  }

  /** Remove event listener */
  removeListener(listener: AudioStreamListener): void {
    this.listeners.delete(listener);
  }

  /** Get current state */
  getState(): AudioStreamState {
    return this.state;
  }

  /** Initialize audio context (must be called after user interaction) */
  async initialize(): Promise<boolean> {
    if (this.audioContext && this.audioContext.state !== "closed") {
      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }
      return true;
    }

    try {
      this.audioContext = new AudioContext({
        sampleRate: this.config.sampleRate,
      });
      this.gainNode = this.audioContext.createGain();
      this.gainNode.connect(this.audioContext.destination);
      return true;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.emit({ type: "error", error });
      return false;
    }
  }

  /**
   * Play audio from a URL (for non-streaming playback)
   */
  async playUrl(url: string): Promise<boolean> {
    if (!await this.initialize()) return false;

    this.setState("loading");
    this.interrupted = false;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch audio: ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      return this.playBuffer(arrayBuffer);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.emit({ type: "error", error });
      this.setState("error");
      return false;
    }
  }

  /**
   * Play audio from an ArrayBuffer
   */
  async playBuffer(buffer: ArrayBuffer): Promise<boolean> {
    if (!await this.initialize()) return false;
    if (!this.audioContext || !this.gainNode) return false;

    this.setState("loading");
    this.interrupted = false;

    try {
      const audioBuffer = await this.audioContext.decodeAudioData(buffer.slice(0));
      return this.playAudioBuffer(audioBuffer);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.emit({ type: "error", error });
      this.setState("error");
      return false;
    }
  }

  /**
   * Play a decoded AudioBuffer
   */
  private playAudioBuffer(audioBuffer: AudioBuffer): boolean {
    if (!this.audioContext || !this.gainNode) return false;

    this.stopCurrentSource();

    // Increment session ID to invalidate any stale callbacks
    this.playbackSessionId++;
    const sessionId = this.playbackSessionId;

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.gainNode);

    source.onended = () => {
      // Ignore callback if a new playback session started
      if (sessionId !== this.playbackSessionId) return;

      if (!this.interrupted) {
        this.emit({ type: "ended", interrupted: false });
      }
      this.setState("idle");
      this.isPlaying = false;
    };

    this.currentSource = source;
    this.startTime = this.audioContext.currentTime;
    this.playbackStartOffset = 0;

    source.start(0);
    this.setState("playing");
    this.isPlaying = true;

    return true;
  }

  /**
   * Start streaming playback - call addStreamChunk to add audio data
   */
  async startStreaming(): Promise<boolean> {
    if (!await this.initialize()) return false;

    // Increment session ID to invalidate stale callbacks from previous playback
    this.playbackSessionId++;

    this.audioQueue = [];
    this.scheduledEndTime = 0;
    this.isPlaying = true;
    this.interrupted = false;
    this.setState("loading");

    return true;
  }

  /**
   * Add a chunk of audio data to the stream
   * @param chunk - Audio data (can be encoded MP3/Opus or raw PCM)
   * @param isPCM - If true, treat as raw PCM data
   */
  async addStreamChunk(chunk: ArrayBuffer, isPCM = false): Promise<boolean> {
    if (!this.audioContext || !this.isPlaying) return false;

    try {
      let audioBuffer: AudioBuffer;

      if (isPCM) {
        audioBuffer = this.decodePCM(chunk);
      } else {
        audioBuffer = await this.audioContext.decodeAudioData(chunk.slice(0));
      }

      this.audioQueue.push(audioBuffer);
      this.scheduleNextChunk();

      if (this.state === "loading") {
        this.setState("playing");
      }

      return true;
    } catch (err) {
      // Some chunks might fail to decode (partial frames, etc.)
      console.warn("[AudioStreamPlayer] Failed to decode chunk:", err);
      return false;
    }
  }

  /**
   * Signal end of stream
   */
  endStream(): void {
    // Let remaining audio play out
    if (this.audioQueue.length === 0 && !this.interrupted) {
      this.isPlaying = false;
      this.emit({ type: "ended", interrupted: false });
      this.setState("idle");
    }
  }

  /**
   * Stop playback with optional interrupt timestamp
   * @returns The time in seconds where playback was interrupted
   */
  stop(): number | undefined {
    if (this.state !== "playing" && this.state !== "loading") {
      return undefined;
    }

    const interruptedAt = this.getCurrentTime();
    this.interrupted = true;
    this.isPlaying = false;

    // Increment session ID to invalidate any pending callbacks
    this.playbackSessionId++;

    this.stopCurrentSource();
    this.audioQueue = [];

    this.emit({
      type: "ended",
      interrupted: true,
      interruptedAtSeconds: interruptedAt,
    });
    this.setState("stopped");

    return interruptedAt;
  }

  /**
   * Pause playback
   */
  pause(): void {
    if (this.audioContext && this.state === "playing") {
      this.audioContext.suspend();
      this.setState("paused");
    }
  }

  /**
   * Resume playback
   */
  async resume(): Promise<void> {
    if (this.audioContext && this.state === "paused") {
      await this.audioContext.resume();
      this.setState("playing");
    }
  }

  /**
   * Set volume (0.0 to 1.0)
   */
  setVolume(volume: number): void {
    if (this.gainNode) {
      this.gainNode.gain.value = Math.max(0, Math.min(1, volume));
    }
  }

  /**
   * Get current playback time in seconds
   */
  getCurrentTime(): number {
    if (!this.audioContext || this.state !== "playing") {
      return this.playbackStartOffset;
    }
    return this.playbackStartOffset + (this.audioContext.currentTime - this.startTime);
  }

  /**
   * Cleanup resources
   */
  dispose(): void {
    this.stop();
    if (this.audioContext && this.audioContext.state !== "closed") {
      this.audioContext.close();
    }
    this.audioContext = null;
    this.gainNode = null;
    this.listeners.clear();
  }

  private stopCurrentSource(): void {
    if (this.currentSource) {
      try {
        this.currentSource.stop();
        this.currentSource.disconnect();
      } catch {
        // May already be stopped
      }
      this.currentSource = null;
    }
  }

  private scheduleNextChunk(): void {
    if (!this.audioContext || !this.gainNode || !this.isPlaying) return;
    if (this.audioQueue.length === 0) return;

    const audioBuffer = this.audioQueue.shift();
    if (!audioBuffer) return;

    // Capture session ID to check in callback
    const sessionId = this.playbackSessionId;

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.gainNode);

    // Schedule after previous chunk ends
    const startTime = Math.max(
      this.audioContext.currentTime,
      this.scheduledEndTime
    );
    source.start(startTime);
    this.scheduledEndTime = startTime + audioBuffer.duration;

    source.onended = () => {
      // Ignore callback if a new playback session started
      if (sessionId !== this.playbackSessionId) return;

      // Schedule next chunk or end
      if (this.audioQueue.length > 0) {
        this.scheduleNextChunk();
      } else if (!this.isPlaying) {
        this.emit({ type: "ended", interrupted: this.interrupted });
        this.setState("idle");
      }
    };
  }

  /**
   * Decode raw PCM data into an AudioBuffer
   * Assumes 16-bit signed little-endian PCM
   */
  private decodePCM(data: ArrayBuffer): AudioBuffer {
    if (!this.audioContext) {
      throw new Error("AudioContext not initialized");
    }

    const pcm16 = new Int16Array(data);
    const samples = pcm16.length;
    const audioBuffer = this.audioContext.createBuffer(
      this.config.channels,
      samples,
      this.config.sampleRate
    );

    // Convert 16-bit PCM to float32
    const channelData = audioBuffer.getChannelData(0);
    for (let i = 0; i < samples; i++) {
      channelData[i] = pcm16[i] / 32768;
    }

    return audioBuffer;
  }

  private setState(state: AudioStreamState): void {
    this.state = state;
    this.emit({ type: "state", state });
  }

  private emit(event: AudioStreamEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[AudioStreamPlayer] Listener error:", err);
      }
    }
  }
}

/**
 * Fetch and play audio from a streaming endpoint
 * Uses ReadableStream to process chunks as they arrive
 */
export async function playStreamingAudio(
  url: string,
  player: AudioStreamPlayer,
  options: { isPCM?: boolean } = {}
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch audio stream: ${response.status}`);
  }

  if (!response.body) {
    throw new Error("Response body is null");
  }

  await player.startStreaming();

  const reader = response.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (value && value.byteLength > 0) {
        await player.addStreamChunk(value.buffer, options.isPCM);
      }
    }

    player.endStream();
  } catch (err) {
    player.stop();
    throw err;
  }
}

export default AudioStreamPlayer;
