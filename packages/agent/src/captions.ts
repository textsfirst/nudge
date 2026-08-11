import { generateText } from "ai";
import type { Logger, ModelSource } from "./types.js";

/**
 * Eager image captioning: one short vision call per inbound photo, at ingest.
 * The caption lands inside the message's text projection before the row is
 * written, so search, compaction summaries, and vision-less fallbacks all
 * remember what the photo showed with no fold-time machinery.
 */
const CAPTION_PROMPT =
  "Describe this image in 1-2 sentences for a conversation log. Note any legible " +
  "text briefly. Output only the description.";

export interface ImageCaptionerOptions {
  /**
   * Only the first source is used — no auth fallback. A captioning failure
   * costs one caption (the projection keeps the bare name), never the turn.
   */
  sources: ModelSource[];
  /** Model override for caption calls; absent rides the source's own model. */
  model?: string;
  logger: Logger;
  timeoutMs?: number;
}

export function buildImageCaptioner(
  options: ImageCaptionerOptions,
): (image: Buffer, mimeType: string) => Promise<string> {
  const source = options.sources[0];
  if (!source) throw new Error("buildImageCaptioner needs at least one model source");
  return async (image, mimeType) => {
    const model = await source.languageModel(options.model);
    const result = await generateText({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: CAPTION_PROMPT },
            { type: "file", data: image, mediaType: mimeType },
          ],
        },
      ],
      abortSignal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
    const caption = result.text.trim().replace(/\s+/g, " ");
    if (!caption) throw new Error("The caption model returned an empty description");
    return caption;
  };
}
