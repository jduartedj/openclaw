/**
 * Talk Mode UI Components for WebUI
 *
 * Provides visual feedback and controls for Talk Mode:
 * - Microphone button to toggle Talk Mode
 * - Phase indicator (Listening → Thinking → Speaking)
 * - Transcript display during listening
 */

import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { TalkModeController, type TalkPhase, type TalkModeEvent } from "./TalkModeController";
import type { GatewayBrowserClient } from "../gateway";

@customElement("talk-mode-button")
export class TalkModeButton extends LitElement {
  static styles = css`
    :host {
      display: inline-block;
    }

    .talk-button {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
      background: var(--talk-button-bg, #3b82f6);
      color: white;
      position: relative;
      overflow: hidden;
    }

    .talk-button:hover {
      background: var(--talk-button-hover-bg, #2563eb);
      transform: scale(1.05);
    }

    .talk-button:active {
      transform: scale(0.95);
    }

    .talk-button.listening {
      background: #22c55e;
      animation: pulse 1.5s infinite;
    }

    .talk-button.thinking {
      background: #f59e0b;
      animation: thinking 1s infinite;
    }

    .talk-button.speaking {
      background: #8b5cf6;
      animation: speak 0.5s infinite alternate;
    }

    .talk-button.disabled {
      background: #6b7280;
      cursor: not-allowed;
    }

    .talk-button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    @keyframes pulse {
      0%, 100% {
        box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.4);
      }
      50% {
        box-shadow: 0 0 0 12px rgba(34, 197, 94, 0);
      }
    }

    @keyframes thinking {
      0%, 100% {
        opacity: 1;
      }
      50% {
        opacity: 0.7;
      }
    }

    @keyframes speak {
      from {
        transform: scale(1);
      }
      to {
        transform: scale(1.05);
      }
    }

    .icon {
      width: 24px;
      height: 24px;
    }

    .unsupported-tooltip {
      position: absolute;
      bottom: 100%;
      left: 50%;
      transform: translateX(-50%);
      padding: 8px 12px;
      background: #1f2937;
      color: white;
      font-size: 12px;
      border-radius: 4px;
      white-space: nowrap;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s;
      margin-bottom: 8px;
    }

    .talk-button.disabled:hover .unsupported-tooltip {
      opacity: 1;
    }
  `;

  @property({ type: Boolean }) disabled = false;
  @property({ type: String }) phase: TalkPhase = "off";
  @property({ type: Boolean }) supported = true;

  render() {
    const buttonClass = this.supported
      ? this.phase !== "off" ? this.phase : ""
      : "disabled";

    return html`
      <button
        class="talk-button ${buttonClass}"
        @click=${this.handleClick}
        ?disabled=${this.disabled || !this.supported}
        title=${this.getTitle()}
      >
        ${this.renderIcon()}
        ${!this.supported ? html`
          <span class="unsupported-tooltip">
            Voice input not supported in this browser
          </span>
        ` : null}
      </button>
    `;
  }

  private renderIcon() {
    if (this.phase === "speaking") {
      // Speaker icon
      return html`
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
        </svg>
      `;
    }

    if (this.phase === "thinking") {
      // Brain/thinking icon
      return html`
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <circle cx="12" cy="12" r="3"></circle>
        </svg>
      `;
    }

    // Microphone icon (default and listening)
    return html`
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
        <line x1="12" y1="19" x2="12" y2="23"></line>
        <line x1="8" y1="23" x2="16" y2="23"></line>
      </svg>
    `;
  }

  private getTitle(): string {
    if (!this.supported) return "Voice input not supported";
    switch (this.phase) {
      case "listening": return "Listening... (click to stop)";
      case "thinking": return "Processing...";
      case "speaking": return "Speaking... (click to interrupt)";
      default: return "Start Talk Mode";
    }
  }

  private handleClick() {
    this.dispatchEvent(new CustomEvent("talk-toggle", {
      bubbles: true,
      composed: true,
    }));
  }
}

@customElement("talk-mode-overlay")
export class TalkModeOverlay extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .overlay {
      position: fixed;
      bottom: 120px;
      left: 50%;
      transform: translateX(-50%);
      padding: 16px 24px;
      background: rgba(0, 0, 0, 0.9);
      border-radius: 16px;
      color: white;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      min-width: 200px;
      max-width: 400px;
      backdrop-filter: blur(8px);
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
      animation: slideUp 0.2s ease;
    }

    @keyframes slideUp {
      from {
        opacity: 0;
        transform: translateX(-50%) translateY(20px);
      }
      to {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
    }

    .phase-indicator {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      font-weight: 500;
    }

    .phase-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
    }

    .phase-dot.listening {
      background: #22c55e;
      animation: dotPulse 1s infinite;
    }

    .phase-dot.thinking {
      background: #f59e0b;
      animation: dotThink 0.5s infinite;
    }

    .phase-dot.speaking {
      background: #8b5cf6;
      animation: dotSpeak 0.3s infinite alternate;
    }

    @keyframes dotPulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.2); opacity: 0.7; }
    }

    @keyframes dotThink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    @keyframes dotSpeak {
      from { transform: scale(1); }
      to { transform: scale(1.3); }
    }

    .transcript {
      font-size: 16px;
      text-align: center;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: rgba(255, 255, 255, 0.9);
    }

    .transcript.interim {
      color: rgba(255, 255, 255, 0.6);
      font-style: italic;
    }

    .close-button {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 24px;
      height: 24px;
      border: none;
      background: rgba(255, 255, 255, 0.1);
      color: white;
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      line-height: 1;
    }

    .close-button:hover {
      background: rgba(255, 255, 255, 0.2);
    }

    .error {
      color: #ef4444;
      font-size: 14px;
    }
  `;

  @property({ type: String }) phase: TalkPhase = "off";
  @property({ type: String }) transcript = "";
  @property({ type: Boolean }) interimTranscript = false;
  @property({ type: String }) error = "";

  render() {
    if (this.phase === "off" && !this.error) return null;

    return html`
      <div class="overlay">
        <button class="close-button" @click=${this.handleClose}>×</button>

        ${this.error ? html`
          <div class="error">${this.error}</div>
        ` : html`
          <div class="phase-indicator">
            <span class="phase-dot ${this.phase}"></span>
            <span>${this.getPhaseText()}</span>
          </div>

          ${this.transcript ? html`
            <div class="transcript ${this.interimTranscript ? "interim" : ""}">
              ${this.transcript}
            </div>
          ` : null}
        `}
      </div>
    `;
  }

  private getPhaseText(): string {
    switch (this.phase) {
      case "listening": return "Listening...";
      case "thinking": return "Thinking...";
      case "speaking": return "Speaking...";
      default: return "";
    }
  }

  private handleClose() {
    this.dispatchEvent(new CustomEvent("talk-close", {
      bubbles: true,
      composed: true,
    }));
  }
}

/**
 * Helper to create and manage Talk Mode for a chat interface
 */
export function createTalkModeManager(options: {
  gateway: GatewayBrowserClient;
  sessionKey: string;
  gatewayBaseUrl?: string;
  onPhaseChange?: (phase: TalkPhase) => void;
  onTranscript?: (transcript: string, isFinal: boolean) => void;
  onError?: (error: string) => void;
}) {
  const controller = new TalkModeController({
    sessionKey: options.sessionKey,
    gatewayBaseUrl: options.gatewayBaseUrl,
  });

  controller.attachGateway(options.gateway);

  controller.addListener((event: TalkModeEvent) => {
    switch (event.type) {
      case "phase":
        options.onPhaseChange?.(event.phase);
        break;
      case "transcript":
        options.onTranscript?.(event.transcript, event.isFinal);
        break;
      case "error":
        options.onError?.(event.error);
        break;
      case "permission-denied":
        options.onError?.("Microphone permission denied. Please allow microphone access.");
        break;
    }
  });

  return {
    controller,
    toggle: () => controller.toggle(),
    enable: () => controller.enable(),
    disable: () => controller.disable(),
    isSupported: () => TalkModeController.isSupported(),
    setSessionKey: (key: string) => controller.setSessionKey(key),
    dispose: () => controller.dispose(),
  };
}

declare global {
  interface HTMLElementTagNameMap {
    "talk-mode-button": TalkModeButton;
    "talk-mode-overlay": TalkModeOverlay;
  }
}
