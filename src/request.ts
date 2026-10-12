import type { ContextEditEntryDraft, ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "./images.ts";

/**
 * Apply context edits to the messages of one request.
 *
 * pi's `context` hook runs right before every request, but it hands over
 * messages without entry ids, and only a boundary event can save a context
 * edit. So a decision is first applied here, to the request alone, and saved
 * at the next boundary. This file is the bridge: it finds the request message
 * that belongs to each edited entry.
 */

/**
 * What identifies an image-bearing message without its entry id.
 *
 * A tool call id is unique. User and extension messages carry a millisecond
 * timestamp, which is unique in practice; the image check below guards the
 * rare tie.
 */
export function messageKey(message: AgentMessage): string | undefined {
  switch (message.role) {
    case "toolResult":
      return `toolResult:${message.toolCallId}`;
    case "user":
      return `user:${message.timestamp}`;
    case "custom":
      return `custom:${message.customType}:${message.timestamp}`;
    default:
      return undefined;
  }
}

/** The sizes of the image blocks, in order. Two messages that share a key must also share this. */
function imageSignature(message: AgentMessage): string {
  if (!("content" in message) || !Array.isArray(message.content)) return "";
  return message.content
    .filter((block) => block.type === "image")
    .map((block) => (block.type === "image" ? block.data.length : 0))
    .join(",");
}

export interface AppliedEdits {
  messages: AgentMessage[];
  /** How many request messages were changed. */
  applied: number;
}

export function applyEditsToMessages(
  messages: readonly AgentMessage[],
  entries: readonly ProjectedSessionEntry[],
  drafts: readonly ContextEditEntryDraft[],
): AppliedEdits {
  const entryById = new Map(entries.map((entry) => [entry.sourceEntry.id, entry]));
  const replacements = new Map<string, { signature: string; content: unknown }>();

  for (const draft of drafts) {
    const projected = entryById.get(draft.targetId)?.messages[0];
    if (!projected || !draft.replacement) continue;
    const key = messageKey(projected);
    if (key) replacements.set(key, { signature: imageSignature(projected), content: draft.replacement.content });
  }

  let applied = 0;
  const result = messages.map((message) => {
    const key = messageKey(message);
    const replacement = key ? replacements.get(key) : undefined;
    // A message whose images differ is not the one the decision was made for.
    if (!replacement || imageSignature(message) !== replacement.signature) return message;
    applied += 1;
    return { ...message, content: replacement.content } as AgentMessage;
  });
  return { messages: result, applied };
}
