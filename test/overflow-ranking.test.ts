import assert from "node:assert/strict";
import { test } from "node:test";
import { collectImages } from "../src/images.ts";
import { findFailedRequest, isRequestTooLarge } from "../src/overflow.ts";
import { buildChatPrompt, parseChatScores } from "../src/ranking.ts";
import { assistantEntry, customMessageEntry, screenshotSession, stateEntry, userEntry } from "./fixtures.ts";

const ANTHROPIC_413 = '413 {"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum allowed size of 32 MB"}}';

test("size refusals are recognized and other errors are not", () => {
  assert.ok(isRequestTooLarge(ANTHROPIC_413));
  assert.ok(isRequestTooLarge("413 Payload Too Large"));
  assert.ok(isRequestTooLarge("Exceeded limit on max bytes to request body: 6291456"));
  assert.ok(!isRequestTooLarge("prompt is too long: 1000001 tokens > 1000000 maximum"));
  assert.ok(!isRequestTooLarge("520 Web server is returning an unknown error"));
  assert.ok(!isRequestTooLarge("tool call toolu_0413 failed"));
  assert.ok(!isRequestTooLarge(undefined));
});

test("the failed request is found behind state entries and extension messages", () => {
  const failed = assistantEntry("", { stopReason: "error", errorMessage: ANTHROPIC_413 });
  const entries = [userEntry("hi"), failed, stateEntry("goal-state"), customMessageEntry("subagent-notification", "done")];
  assert.deepEqual(findFailedRequest(entries), { entryId: failed.sourceEntry.id, errorMessage: ANTHROPIC_413 });
});

test("an old failure or another error is not a failed request", () => {
  const failed = assistantEntry("", { stopReason: "error", errorMessage: ANTHROPIC_413 });
  assert.equal(findFailedRequest([failed, userEntry("try again")]), undefined);
  assert.equal(findFailedRequest([assistantEntry("", { stopReason: "error", errorMessage: "520 unknown" })]), undefined);
  assert.equal(findFailedRequest([assistantEntry("all good")]), undefined);
});

test("chat scores are read from fenced JSON and scaled to 0 to 1", () => {
  const reply = 'Sure.\n```json\n{"scores": {"i1": 10, "i2": "3", "i3": 42, "i4": -1}}\n```';
  const scores = parseChatScores(reply, ["i1", "i2", "i3", "i4", "i5"]);
  assert.deepEqual([...scores], [
    ["i1", 1],
    ["i2", 0.3],
    ["i3", 1],
    ["i4", 0],
  ]);
});

test("a reply without scores is an error", () => {
  assert.throws(() => parseChatScores("I cannot help", ["i1"]), /no JSON object/);
  assert.throws(() => parseChatScores('{"scores": {}}', ["i1"]), /no usable scores/);
});

test("the ranking prompt holds text facts and no image data", () => {
  const { entries } = screenshotSession(2, 5000);
  const { images } = collectImages(entries);
  const prompt = buildChatPrompt("Fix the layout", images.map((record, index) => ({ key: `i${index + 1}`, record })), images.length);
  assert.match(prompt, /"id": "i1"/);
  assert.match(prompt, /path \\"\/tmp\/shot0\.png\\"/);
  assert.match(prompt, /1 of 2 \(1 is the oldest\)/);
  assert.doesNotMatch(prompt, /AAAAAAAAAA/);
});
