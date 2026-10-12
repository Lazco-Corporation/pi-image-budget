import type { ContextEditableContent, ContextEditEntryDraft, ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import type { ImageRecord, ImageSource } from "./images.ts";
import { describeSource } from "./images.ts";

/**
 * The text that takes the place of a removed image, and the context edits
 * that put it there.
 *
 * The text speaks to the agent. It must say three things: an image was here,
 * where it came from, and how to get it back. Without the last part the agent
 * guesses about an image it can no longer see.
 */

export const PLACEHOLDER_MARK = "[Image removed by pi-image-budget";

function recoveryInstruction(source: ImageSource): string {
  switch (source.kind) {
    case "tool":
      if (source.path) {
        return "You cannot see this image now. If you need it, read the file again. If the file is gone, make the image again the same way as before.";
      }
      return `You cannot see this image now. If you need it, call the \`${source.toolName}\` tool again. The new result can differ from the old one.`;
    case "user":
      return "You cannot see this image now. If you need it, ask the user to attach it again.";
    case "custom":
      return "You cannot see this image now. If you need it, make the image again.";
  }
}

export function placeholderText(source: ImageSource, summary?: string): string {
  const lines = [
    `${PLACEHOLDER_MARK} to keep the request below the provider size limit.`,
    `Source: ${describeSource(source)}.`,
  ];
  if (summary && summary.trim().length > 0) {
    lines.push(`Summary from another model (it can be incomplete): ${summary.trim()}`);
  }
  lines.push(`${recoveryInstruction(source)}]`);
  return lines.join("\n");
}

/**
 * pi's note about a resized image, as written by `formatDimensionNote()`.
 * It tells the agent how to scale coordinates on an image that is gone.
 */
const RESIZE_NOTE = /\n?\[Image: original \d+x\d+, displayed at \d+x\d+\. Multiply coordinates by [\d.]+ to map to original image\.\]/g;

export function withoutResizeNotes(text: string): string {
  return text.replace(RESIZE_NOTE, "");
}

/**
 * Build one context edit per message that loses an image.
 *
 * When every image of a message goes, pi's resize notes in that message go
 * too. With several images and only some removed, a note cannot be tied to
 * one image, so the notes stay.
 *
 * The replacement starts from the projected content, not the raw entry, so an
 * earlier edit to the same message is kept. Text blocks and kept images stay
 * where they were.
 */
export function buildContextEdits(
  entries: readonly ProjectedSessionEntry[],
  removed: readonly ImageRecord[],
  summaries: ReadonlyMap<string, string> = new Map(),
): ContextEditEntryDraft[] {
  const removedByEntry = new Map<string, Map<number, ImageRecord>>();
  for (const record of removed) {
    const blocks = removedByEntry.get(record.entryId) ?? new Map<number, ImageRecord>();
    blocks.set(record.blockIndex, record);
    removedByEntry.set(record.entryId, blocks);
  }

  const drafts: ContextEditEntryDraft[] = [];
  for (const entry of entries) {
    const blocks = removedByEntry.get(entry.sourceEntry.id);
    if (!blocks) continue;
    const message = entry.messages[0];
    if (!message || !("content" in message) || !Array.isArray(message.content)) continue;

    const imageCount = message.content.filter((block) => block.type === "image").length;
    const removesEveryImage = blocks.size === imageCount;

    const content = message.content.flatMap((block, blockIndex) => {
      const record = blocks.get(blockIndex);
      if (record && block.type === "image") {
        return [{ type: "text" as const, text: placeholderText(record.source, summaries.get(record.id)) }];
      }
      if (removesEveryImage && block.type === "text") {
        const text = withoutResizeNotes(block.text);
        if (text === block.text) return [block];
        return text.trim().length > 0 ? [{ ...block, text }] : [];
      }
      return [block];
    });

    drafts.push({
      type: "context_edit",
      targetId: entry.sourceEntry.id,
      // Only user, tool-result, and custom messages reach this point, and their
      // content arrays accept text and image blocks alike.
      replacement: { content: content as ContextEditableContent },
    });
  }
  return drafts;
}
