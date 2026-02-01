/**
 * Voice module - Browser-based voice input/output for WebUI Talk Mode
 */

export { VoiceInputController } from "./VoiceInputController";
export type {
  VoiceInputState,
  VoiceInputConfig,
  VoiceInputEvent,
  VoiceInputListener,
} from "./VoiceInputController";

export { AudioStreamPlayer, playStreamingAudio } from "./AudioStreamPlayer";
export type {
  AudioStreamState,
  AudioStreamConfig,
  AudioStreamEvent,
  AudioStreamListener,
} from "./AudioStreamPlayer";

export { TalkModeController } from "./TalkModeController";
export type {
  TalkPhase,
  TalkModeConfig,
  TalkModeEvent,
  TalkModeListener,
} from "./TalkModeController";

export {
  TalkModeButton,
  TalkModeOverlay,
  createTalkModeManager,
} from "./TalkModeUI";
