import type { ImageContent } from "@earendil-works/pi-ai";
import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";

export type AgentMessage = ProjectedSessionEntry["messages"][number];
/** The message roles whose content can hold image blocks. */
type ImageBearingMessage = Extract<AgentMessage, { role: "user" | "toolResult" | "custom" }>;

/**
 * Find every image the next request would carry, and where each came from.
 *
 * The input is pi's projection of the branch, which already applies earlier
 * context edits. An image removed by an earlier edit is therefore not found
 * again, so the edits themselves are the only state this extension needs.
 */

export type ImageSource =
  | { kind: "tool"; toolName: string; path?: string; argumentsText?: string }
  | { kind: "user" }
  | { kind: "custom"; customType: string };

export interface ImageRecord {
  /** Stable for the life of the entry: `<entryId>:<blockIndex>`. */
  id: string;
  entryId: string;
  blockIndex: number;
  /** 0 is the oldest image in the request. */
  position: number;
  /** Base64 length, which is what the image adds to the request body. */
  bytes: number;
  image: ImageContent;
  source: ImageSource;
  /** Text blocks of the message that holds the image. */
  nearbyText: string;
  /** What the agent wrote in its next reply after the image. */
  followUpText: string;
}

export interface CollectedImages {
  images: ImageRecord[];
  totalBytes: number;
}

/** Argument names that tools use for a file path. */
const PATH_ARGUMENT_KEYS = ["path", "file_path", "filePath", "file", "imagePath", "image_path", "filename", "outputPath", "output_path"];

const NEARBY_TEXT_LIMIT = 400;
const FOLLOW_UP_TEXT_LIMIT = 500;
const ARGUMENTS_TEXT_LIMIT = 200;

export function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, Math.max(1, limit - 1))}…` : flat;
}

interface ToolCallInfo {
  name: string;
  arguments: Record<string, unknown>;
}

function pathFromArguments(argumentsObject: Record<string, unknown>): string | undefined {
  for (const key of PATH_ARGUMENT_KEYS) {
    const value = argumentsObject[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function argumentsText(argumentsObject: Record<string, unknown>): string | undefined {
  if (Object.keys(argumentsObject).length === 0) return undefined;
  try {
    return truncate(JSON.stringify(argumentsObject), ARGUMENTS_TEXT_LIMIT);
  } catch {
    return undefined;
  }
}

function textOfBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** Messages whose content may hold image blocks, with the entry types pi lets an edit target. */
function editableImageMessage(entry: ProjectedSessionEntry): ImageBearingMessage | undefined {
  const sourceType = entry.sourceEntry.type;
  if (sourceType !== "message" && sourceType !== "custom_message") return undefined;
  if (entry.messages.length !== 1) return undefined;
  const message = entry.messages[0];
  if (!message) return undefined;
  if (message.role !== "user" && message.role !== "toolResult" && message.role !== "custom") return undefined;
  return message;
}

function sourceOf(message: ImageBearingMessage, toolCalls: Map<string, ToolCallInfo>): ImageSource {
  if (message.role === "toolResult") {
    const call = toolCalls.get(message.toolCallId);
    const toolArguments = call?.arguments ?? {};
    const toolName = message.toolName || call?.name || "unknown";
    const path = pathFromArguments(toolArguments);
    if (path) return { kind: "tool", toolName, path };
    // Without a path, the arguments are what lets the agent repeat the call.
    const text = argumentsText(toolArguments);
    return text ? { kind: "tool", toolName, argumentsText: text } : { kind: "tool", toolName };
  }
  if (message.role === "custom") return { kind: "custom", customType: message.customType };
  return { kind: "user" };
}

export function collectImages(entries: readonly ProjectedSessionEntry[]): CollectedImages {
  const images: ImageRecord[] = [];
  const toolCalls = new Map<string, ToolCallInfo>();
  /** Images that still wait for the next assistant text. */
  let waitingForFollowUp: ImageRecord[] = [];
  let totalBytes = 0;

  for (const entry of entries) {
    for (const message of entry.messages) {
      if (message.role !== "assistant") continue;
      for (const block of message.content) {
        if (block.type === "toolCall") toolCalls.set(block.id, { name: block.name, arguments: block.arguments ?? {} });
      }
      const text = textOfBlocks(message.content);
      if (text.trim().length > 0 && waitingForFollowUp.length > 0) {
        const followUp = truncate(text, FOLLOW_UP_TEXT_LIMIT);
        for (const record of waitingForFollowUp) record.followUpText = followUp;
        waitingForFollowUp = [];
      }
    }

    const message = editableImageMessage(entry);
    if (!message || typeof message.content === "string" || !Array.isArray(message.content)) continue;

    const nearbyText = truncate(textOfBlocks(message.content), NEARBY_TEXT_LIMIT);
    message.content.forEach((block, blockIndex) => {
      if (block.type !== "image") return;
      const record: ImageRecord = {
        id: `${entry.sourceEntry.id}:${blockIndex}`,
        entryId: entry.sourceEntry.id,
        blockIndex,
        position: images.length,
        bytes: block.data.length,
        image: block,
        source: sourceOf(message, toolCalls),
        nearbyText,
        followUpText: "",
      };
      images.push(record);
      waitingForFollowUp.push(record);
      totalBytes += record.bytes;
    });
  }

  return { images, totalBytes };
}

/** The recent user requests and the latest agent text: what the agent works on now. */
export function describeTask(entries: readonly ProjectedSessionEntry[], userLimit = 2000, assistantLimit = 1000): string {
  const userTexts: string[] = [];
  let latestAssistantText = "";

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry) continue;
    for (const message of entry.messages) {
      if (message.role === "user" && userTexts.length < 2) {
        const text = textOfBlocks(message.content).trim();
        if (text.length > 0) userTexts.unshift(text);
      }
      if (message.role === "assistant" && latestAssistantText.length === 0) {
        latestAssistantText = textOfBlocks(message.content).trim();
      }
    }
    if (userTexts.length >= 2 && latestAssistantText.length > 0) break;
  }

  const parts: string[] = [];
  if (userTexts.length > 0) {
    const eachLimit = Math.floor(userLimit / userTexts.length);
    parts.push(`Recent user requests:\n${userTexts.map((text) => truncate(text, eachLimit)).join("\n---\n")}`);
  }
  if (latestAssistantText.length > 0) parts.push(`Latest agent message:\n${truncate(latestAssistantText, assistantLimit)}`);
  return parts.join("\n\n");
}

/** One line for prompts and placeholders. */
export function describeSource(source: ImageSource): string {
  switch (source.kind) {
    case "tool":
      if (source.path) return `the \`${source.toolName}\` tool, path "${source.path}"`;
      if (source.argumentsText) return `the \`${source.toolName}\` tool, arguments ${source.argumentsText}`;
      return `the \`${source.toolName}\` tool`;
    case "user":
      return "an image that the user attached";
    case "custom":
      return `an extension message ("${source.customType}")`;
  }
}
