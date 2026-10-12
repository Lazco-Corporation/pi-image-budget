import assert from "node:assert/strict";
import { test } from "node:test";
import { collectImages, describeSource, describeTask } from "../src/images.ts";
import { buildContextEdits, PLACEHOLDER_MARK, placeholderText, withoutResizeNotes } from "../src/placeholder.ts";
import { assistantEntry, customMessageEntry, screenshotSession, stateEntry, toolResultEntry, userEntry } from "./fixtures.ts";

test("images are found in order with their size and source", () => {
  const { entries, resultIds } = screenshotSession(3, 500);
  const { images, totalBytes } = collectImages(entries);
  assert.equal(images.length, 3);
  assert.equal(totalBytes, 1500);
  assert.deepEqual(images.map((image) => image.position), [0, 1, 2]);
  assert.equal(images[0]?.entryId, resultIds[0]);
  assert.deepEqual(images[1]?.source, { kind: "tool", toolName: "read", path: "/tmp/shot1.png" });
  assert.equal(images[1]?.nearbyText, "Read image file [image/png]");
});

test("each image gets the agent text that follows it", () => {
  const { entries } = screenshotSession(3);
  const { images } = collectImages(entries);
  assert.equal(images[0]?.followUpText, "Screenshot 0 shows the sidebar.");
  assert.equal(images[1]?.followUpText, "Screenshot 1 shows the sidebar.");
  assert.equal(images[2]?.followUpText, "");
});

test("a tool without a path keeps its arguments, and user images are found", () => {
  const entries = [
    userEntry("Look at this", [10]),
    assistantEntry("", { toolCalls: [{ id: "c1", name: "observe_ui", arguments: { mode: "visual", root: "@r2" } }] }),
    toolResultEntry("c1", "observe_ui", [20, 30], "Observed visual @r2"),
    customMessageEntry("note", "no image here"),
    stateEntry("goal-state"),
  ];
  const { images } = collectImages(entries);
  assert.equal(images.length, 3);
  assert.deepEqual(images[0]?.source, { kind: "user" });
  assert.deepEqual(images[1]?.source, { kind: "tool", toolName: "observe_ui", argumentsText: '{"mode":"visual","root":"@r2"}' });
  assert.equal(images[2]?.blockIndex, 2);
});

test("the task text holds the last two user requests and the latest agent text", () => {
  const entries = [userEntry("first"), userEntry("second"), assistantEntry("working"), userEntry("third")];
  const task = describeTask(entries);
  assert.match(task, /second\n---\nthird/);
  assert.doesNotMatch(task, /first/);
  assert.match(task, /Latest agent message:\nworking/);
});

test("placeholders say where the image came from and how to get it back", () => {
  const fromFile = placeholderText({ kind: "tool", toolName: "read", path: "/tmp/a.png" });
  assert.ok(fromFile.startsWith(PLACEHOLDER_MARK));
  assert.match(fromFile, /path "\/tmp\/a\.png"/);
  assert.match(fromFile, /read the file again/);

  assert.match(placeholderText({ kind: "tool", toolName: "observe_ui" }), /call the `observe_ui` tool again/);
  assert.match(placeholderText({ kind: "user" }), /ask the user to attach it again/);
  assert.match(placeholderText({ kind: "custom", customType: "x" }), /make the image again/);
  assert.match(placeholderText({ kind: "user" }, "A red error banner."), /Summary from another model .*: A red error banner\./);
  assert.equal(describeSource({ kind: "tool", toolName: "t", argumentsText: "{}" }), "the `t` tool, arguments {}");
});

const NOTE = "[Image: original 1025x1600, displayed at 1005x1568. Multiply coordinates by 1.02 to map to original image.]";

test("resize notes go with the last image of a message, in both forms", () => {
  assert.equal(withoutResizeNotes(`Read image file [image/jpeg]\n${NOTE}`), "Read image file [image/jpeg]");

  const inline = [
    assistantEntry("", { toolCalls: [{ id: "c1", name: "read", arguments: { path: "/tmp/a.png" } }] }),
    toolResultEntry("c1", "read", [10], `Read image file [image/jpeg]\n${NOTE}`),
  ];
  const inlineDraft = buildContextEdits(inline, collectImages(inline).images)[0];
  const inlineContent = inlineDraft?.replacement?.content as { type: string; text?: string }[];
  assert.equal(inlineContent[0]?.text, "Read image file [image/jpeg]");

  const separate = [
    assistantEntry("", { toolCalls: [{ id: "c2", name: "observe_ui", arguments: {} }] }),
    toolResultEntry("c2", "observe_ui", [10], "Observed visual"),
  ];
  const message = separate[1]?.messages[0] as { content: unknown[] };
  message.content.push({ type: "text", text: NOTE });
  const separateDraft = buildContextEdits(separate, collectImages(separate).images)[0];
  const separateContent = separateDraft?.replacement?.content as { type: string; text?: string }[];
  assert.equal(separateContent.length, 2);
  assert.ok(separateContent.every((block) => !block.text?.includes("[Image: original")));
});

test("resize notes stay when some images of the message stay", () => {
  const entries = [
    assistantEntry("", { toolCalls: [{ id: "c1", name: "read", arguments: {} }] }),
    toolResultEntry("c1", "read", [10, 20], `Two images\n${NOTE}`),
  ];
  const first = collectImages(entries).images[0];
  assert.ok(first);
  const content = buildContextEdits(entries, [first])[0]?.replacement?.content as { type: string; text?: string }[];
  assert.match(content[0]?.text ?? "", /Multiply coordinates/);
});

test("context edits swap only the removed images and keep everything else", () => {
  const entries = [
    assistantEntry("", { toolCalls: [{ id: "c1", name: "read", arguments: { path: "/tmp/a.png" } }] }),
    toolResultEntry("c1", "read", [10, 20]),
  ];
  const { images } = collectImages(entries);
  const first = images[0];
  assert.ok(first);
  const drafts = buildContextEdits(entries, [first], new Map([[first.id, "two buttons"]]));
  assert.equal(drafts.length, 1);
  const draft = drafts[0];
  assert.equal(draft?.targetId, entries[1]?.sourceEntry.id);
  const content = draft?.replacement?.content as { type: string; text?: string }[];
  assert.deepEqual(content.map((block) => block.type), ["text", "text", "image"]);
  assert.equal(content[0]?.text, "Read image file [image/png]");
  assert.match(content[1]?.text ?? "", /Summary from another model .*two buttons/);
});
