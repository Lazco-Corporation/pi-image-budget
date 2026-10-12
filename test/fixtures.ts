import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Build projected session entries the way pi hands them to boundary events.
 *
 * Only the fields this extension reads are filled. The casts are confined to
 * this file so the tests themselves stay readable.
 */

let counter = 0;

function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}`;
}

/** Base64 text of an exact length. The content does not matter, only the size. */
export function fakeImageData(bytes: number): string {
  return "A".repeat(bytes);
}

function entry(type: string, message: unknown, id = nextId("e")): ProjectedSessionEntry {
  return {
    sourceEntry: { type, id, parentId: null, timestamp: new Date(0).toISOString(), message },
    messages: message ? [message] : [],
  } as unknown as ProjectedSessionEntry;
}

export function userEntry(text: string, imageBytes: number[] = []): ProjectedSessionEntry {
  const content = [
    { type: "text", text },
    ...imageBytes.map((bytes) => ({ type: "image", data: fakeImageData(bytes), mimeType: "image/png" })),
  ];
  return entry("message", { role: "user", content, timestamp: 0 });
}

export function assistantEntry(
  text: string,
  options: { toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[]; stopReason?: string; errorMessage?: string } = {},
): ProjectedSessionEntry {
  const content = [
    ...(text ? [{ type: "text", text }] : []),
    ...(options.toolCalls ?? []).map((call) => ({ type: "toolCall", ...call })),
  ];
  return entry("message", {
    role: "assistant",
    content,
    stopReason: options.stopReason ?? (options.toolCalls?.length ? "toolUse" : "stop"),
    ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
    timestamp: 0,
  });
}

export function toolResultEntry(toolCallId: string, toolName: string, imageBytes: number[], text = "Read image file [image/png]"): ProjectedSessionEntry {
  const content = [
    { type: "text", text },
    ...imageBytes.map((bytes) => ({ type: "image", data: fakeImageData(bytes), mimeType: "image/png" })),
  ];
  return entry("message", { role: "toolResult", toolCallId, toolName, content, isError: false, timestamp: 0 });
}

export function customMessageEntry(customType: string, text: string): ProjectedSessionEntry {
  return entry("custom_message", { role: "custom", customType, content: text, display: false, timestamp: 0 });
}

/** A state-only entry, such as an extension's custom data. It adds nothing to the context. */
export function stateEntry(customType: string): ProjectedSessionEntry {
  return {
    sourceEntry: { type: "custom", id: nextId("s"), parentId: null, timestamp: new Date(0).toISOString(), customType, data: {} },
    messages: [],
  } as unknown as ProjectedSessionEntry;
}

/**
 * A conversation where the agent reads `count` screenshots, one per turn.
 * Returns the entries and the tool result entry ids in order.
 */
export function screenshotSession(count: number, bytesEach = 1000): { entries: ProjectedSessionEntry[]; resultIds: string[] } {
  const entries: ProjectedSessionEntry[] = [userEntry("Fix the layout bug on the admin page.")];
  const resultIds: string[] = [];
  for (let index = 0; index < count; index++) {
    const callId = `call${index}`;
    entries.push(
      assistantEntry(index === 0 ? "" : `Screenshot ${index - 1} shows the sidebar.`, {
        toolCalls: [{ id: callId, name: "read", arguments: { path: `/tmp/shot${index}.png` } }],
      }),
    );
    const result = toolResultEntry(callId, "read", [bytesEach]);
    entries.push(result);
    resultIds.push(result.sourceEntry.id);
  }
  return { entries, resultIds };
}
