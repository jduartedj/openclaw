import type { ModelCompatConfig } from "../config/types.models.js";

export type ModelInputType = "text" | "image" | "audio" | "video" | "document";
export type ModelOutputType = "text" | "image" | "audio";

export type ModelCatalogEntry = {
  id: string;
  name: string;
  provider: string;
  alias?: string;
  contextWindow?: number;
  contextTokens?: number;
  reasoning?: boolean;
  input?: ModelInputType[];
  /**
   * Modality types the model can emit as output. Defaults to ["text"] when absent.
   * Models like `gpt-4o-audio-preview` declare ["text", "audio"].
   */
  output?: ModelOutputType[];
  compat?: ModelCompatConfig;
};
