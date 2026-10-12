import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SummarySettings } from "./config.ts";
import { describeSource, truncate, type ImageRecord } from "./images.ts";
import { completeText, errorText, findChatModel, mapWithLimit } from "./models.ts";

/**
 * Describe images before they leave the request.
 *
 * Unlike ranking, this call must send the image itself: a model cannot
 * describe what it cannot see. It runs only for images that are about to be
 * removed, so each image is described once.
 */

export interface SummaryResult {
  /** Summary text per image id. An image without an entry gets a plain placeholder. */
  summaries: Map<string, string>;
  warning?: string;
}

const CONCURRENCY = 4;

export function buildSummaryPrompt(record: ImageRecord, maxWords: number): string {
  const lines = [
    "Describe this image for a coding agent that will not be able to see it again.",
    `Write at most ${maxWords} words of plain text.`,
    "State the facts the agent can need later: visible text, error messages, numbers, the state of the UI, and visible problems.",
    "Do not guess about what is not visible.",
    "",
    `Source: ${describeSource(record.source)}.`,
  ];
  if (record.nearbyText) lines.push(`Text that came with the image: ${record.nearbyText}`);
  if (record.followUpText) lines.push(`What the agent wrote after it: ${record.followUpText}`);
  return lines.join("\n");
}

export async function summarizeImages(
  context: ExtensionContext,
  settings: SummarySettings,
  images: readonly ImageRecord[],
  /** Called after each image, failed or not, with the count of finished images. */
  onProgress: (finished: number, total: number) => void = () => undefined,
): Promise<SummaryResult> {
  const summaries = new Map<string, string>();
  if (images.length === 0) return { summaries };

  const lookup = findChatModel(context, settings.model, "summary");
  if (!lookup.ok) return { summaries, warning: lookup.warning };
  if (!lookup.model.input.includes("image")) {
    return { summaries, warning: `the summary model "${settings.model}" does not accept images` };
  }

  const failures: string[] = [];
  let finished = 0;
  await mapWithLimit(images, CONCURRENCY, async (record) => {
    try {
      const text = await completeText({
        context,
        model: lookup.model,
        content: [
          { type: "text", text: buildSummaryPrompt(record, settings.maxWords) },
          { type: "image", data: record.image.data, mimeType: record.image.mimeType },
        ],
        thinking: settings.thinking,
        // Room for reasoning tokens plus the summary itself.
        maxTokens: 2000 + settings.maxWords * 4,
        timeoutMs: settings.timeoutMs,
      });
      // A model that ignores the word limit must not undo the point of removing the image.
      if (text.length > 0) summaries.set(record.id, truncate(text, settings.maxWords * 10));
    } catch (error) {
      failures.push(errorText(error));
    }
    finished += 1;
    onProgress(finished, images.length);
  });

  if (failures.length > 0) {
    return {
      summaries,
      warning: `${failures.length} of ${images.length} summaries failed (${failures[0]}). Those images got a plain placeholder.`,
    };
  }
  return { summaries };
}
