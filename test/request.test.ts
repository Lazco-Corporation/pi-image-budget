import assert from "node:assert/strict";
import { test } from "node:test";
import { collectImages, type AgentMessage } from "../src/images.ts";
import { buildContextEdits } from "../src/placeholder.ts";
import { applyEditsToMessages, messageKey } from "../src/request.ts";
import { customMessageEntry, screenshotSession, toolResultEntry, userEntry } from "./fixtures.ts";

function requestMessages(entries: { messages: AgentMessage[] }[]): AgentMessage[] {
  return structuredClone(entries.flatMap((entry) => entry.messages));
}

test("message keys use the tool call id, or the role and timestamp", () => {
  const tool = toolResultEntry("call7", "read", [1]).messages[0] as AgentMessage;
  const user = { ...(userEntry("hi").messages[0] as object), timestamp: 42 } as AgentMessage;
  const custom = { ...(customMessageEntry("note", "x").messages[0] as object), timestamp: 42 } as AgentMessage;
  assert.equal(messageKey(tool), "toolResult:call7");
  assert.equal(messageKey(user), "user:42");
  assert.equal(messageKey(custom), "custom:note:42");
});

test("edits reach the matching request messages and nothing else", () => {
  const { entries } = screenshotSession(3);
  const { images } = collectImages(entries);
  const drafts = buildContextEdits(entries, images.slice(0, 2));
  const messages = requestMessages(entries);

  const { messages: result, applied } = applyEditsToMessages(messages, entries, drafts);
  assert.equal(applied, 2);
  const imagesLeft = result.flatMap((message) =>
    "content" in message && Array.isArray(message.content) ? message.content.filter((block) => block.type === "image") : [],
  );
  assert.equal(imagesLeft.length, 1);
  // The input list is left alone, so pi's own copy is not changed behind its back.
  assert.equal(messages.filter((message) => message.role === "toolResult").length, 3);
  assert.ok(messages.every((message) => message.role !== "toolResult" || (message.content as { type: string }[]).some((block) => block.type === "image")));
});

test("a message with the same key but other images is not changed", () => {
  const entries = [userEntry("look", [100])];
  const { images } = collectImages(entries);
  const drafts = buildContextEdits(entries, images);
  const messages = requestMessages(entries);
  const message = messages[0] as { content: { type: string; data?: string }[] };
  const image = message.content[1];
  if (image) image.data = "B".repeat(7);

  assert.equal(applyEditsToMessages(messages, entries, drafts).applied, 0);
});

test("messages that pi added only to the request are passed through", () => {
  const { entries } = screenshotSession(2);
  const { images } = collectImages(entries);
  const drafts = buildContextEdits(entries, images.slice(0, 1));
  const extra = userEntry("queued steering message").messages[0] as AgentMessage;
  const { messages, applied } = applyEditsToMessages([...requestMessages(entries), extra], entries, drafts);
  assert.equal(applied, 1);
  assert.equal(messages.at(-1), extra);
});
