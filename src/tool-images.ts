import type { ConversationMessage, ToolImage } from "./types.js";

/** Rough per-image prompt cost used for context budgeting; vendors bill roughly this much for a 1.5-megapixel frame. */
export const IMAGE_TOKEN_ESTIMATE = 1600;

const STRIPPED_NOTE = "\n[Screenshot no longer attached: only the latest frame's image stays in context. Observe again for a fresh image.]";

/** Parse a base64 data URL into a tool image; anything that is not a supported raster image yields undefined. */
export function imageFromDataUrl(dataUrl: string): ToolImage | undefined {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/s.exec(dataUrl);
  if (!match) return undefined;
  return { mediaType: match[1] as ToolImage["mediaType"], data: match[2]! };
}

export function dataUrlFromImage(image: ToolImage): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

/**
 * Keep images only on the newest `keep` tool messages that carry them. Older frames are
 * stale for Computer Use (each input consumes its frame) and would otherwise grow the
 * prompt by megabytes per turn. Mutates the messages in place and returns how many were stripped.
 */
export function retainLatestImages(messages: ConversationMessage[], keep = 1): number {
  let seen = 0, stripped = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (!message.images?.length) continue;
    if (seen < keep) { seen += 1; continue; }
    delete message.images;
    if (!message.content.endsWith(STRIPPED_NOTE)) message.content += STRIPPED_NOTE;
    stripped += 1;
  }
  return stripped;
}
