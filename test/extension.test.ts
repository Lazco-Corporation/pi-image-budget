import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CONFIG_DIR_NAME, type ContextEditEntryDraft, type ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { SETTINGS_FILE } from "../src/config.ts";
import type { AgentMessage } from "../src/images.ts";
import { PLACEHOLDER_MARK } from "../src/placeholder.ts";
import { assistantEntry, screenshotSession, stateEntry, userEntry } from "./fixtures.ts";

/**
 * The entry point, driven the way pi drives it: the `context` hook right
 * before each request, then boundary events whose drafts pi saves.
 */

let agentDir = "";
// pi builds this name from its app name and does not export it. A drifted
// hard-coded name would point these tests at the real settings file.
const ENV_AGENT_DIR = `${CONFIG_DIR_NAME.replace(/^\./, "").toUpperCase()}_CODING_AGENT_DIR`;

before(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pi-image-budget-ext-"));
  process.env[ENV_AGENT_DIR] = agentDir;
});

after(() => {
  rmSync(agentDir, { recursive: true, force: true });
  delete process.env[ENV_AGENT_DIR];
});

type Handler = (event: unknown, context: unknown) => unknown;

interface BoundaryOutput {
  entries?: ContextEditEntryDraft[];
  continue?: boolean;
}

interface ModelCall {
  model: string;
  text: string;
  imageCount: number;
}

interface Harness {
  /** Run the `context` hook for a request built from these entries. Returns the messages pi would send. */
  request(entries: ProjectedSessionEntry[]): Promise<AgentMessage[] | undefined>;
  turnEnd(entries: ProjectedSessionEntry[], earlierDrafts?: unknown[]): Promise<BoundaryOutput | undefined>;
  beforeSettle(entries: ProjectedSessionEntry[], outcome: string): Promise<BoundaryOutput | undefined>;
  notices: { message: string; level: string }[];
  calls: ModelCall[];
  /** Every working message set, in order. `undefined` means pi's own message came back. */
  workingMessages: (string | undefined)[];
}

async function startExtension(
  settings: Record<string, unknown>,
  replies: Record<string, (text: string) => string> = {},
  options: { hasUI?: boolean } = {},
): Promise<Harness> {
  writeFileSync(join(agentDir, SETTINGS_FILE), JSON.stringify(settings), "utf8");
  const handlers = new Map<string, Handler[]>();
  const notices: { message: string; level: string }[] = [];
  const calls: ModelCall[] = [];
  const workingMessages: (string | undefined)[] = [];
  let sessionEntries: ProjectedSessionEntry[] = [];

  const knownModels: Record<string, { input: string[] }> = {
    "test/ranker": { input: ["text"] },
    "test/vision": { input: ["text", "image"] },
  };

  const hasUI = options.hasUI ?? true;
  const context = {
    mode: hasUI ? "tui" : "print",
    hasUI,
    cwd: "/tmp/project",
    signal: undefined,
    model: { id: "session", provider: "test", api: "anthropic-messages", input: ["text", "image"] },
    sessionManager: { buildSessionProjection: () => ({ entries: sessionEntries }) },
    modelRegistry: {
      find: (provider: string, id: string) => {
        const known = knownModels[`${provider}/${id}`];
        return known ? { id, provider, api: "openai-completions", reasoning: false, ...known } : undefined;
      },
      hasConfiguredAuth: () => true,
      streamSimple: (model: { provider: string; id: string }, request: { messages: { content: { type: string; text?: string }[] }[] }) => {
        const content = request.messages[0]?.content ?? [];
        const text = content.find((block) => block.type === "text")?.text ?? "";
        const reference = `${model.provider}/${model.id}`;
        calls.push({ model: reference, text, imageCount: content.filter((block) => block.type === "image").length });
        const reply = replies[reference];
        return {
          result: async () =>
            reply
              ? { stopReason: "stop", content: [{ type: "text", text: reply(text) }] }
              : { stopReason: "error", errorMessage: "503 unavailable", content: [] },
        };
      },
    },
    ui: {
      notify: (message: string, level: string) => notices.push({ message, level }),
      setWorkingMessage: (message?: string) => workingMessages.push(message),
    },
  };

  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => undefined;
    },
    registerCommand: () => undefined,
  };

  const { default: extension } = await import(`../src/index.ts?run=${Math.random()}`);
  extension(pi);
  for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start" }, context);

  const fire = async (event: Record<string, unknown>): Promise<unknown> => {
    let output: unknown;
    for (const handler of handlers.get(event.type as string) ?? []) output = await handler(event, context);
    return output;
  };

  const preview = (entries: ProjectedSessionEntry[]) => ({
    contextEntries: entries,
    contextMessages: [],
    llmMessages: [],
    pendingMessages: [],
    canContinue: true,
  });

  return {
    notices,
    calls,
    workingMessages,
    request: async (entries) => {
      sessionEntries = entries;
      // pi hands the hook a deep copy of the request messages.
      const messages = structuredClone(entries.flatMap((entry) => entry.messages));
      const output = (await fire({ type: "context", messages })) as { messages?: AgentMessage[] } | undefined;
      return output?.messages;
    },
    turnEnd: async (entries, earlierDrafts = []) => {
      sessionEntries = entries;
      return (await fire({
        type: "turn_end",
        turnIndex: 1,
        message: { role: "assistant", content: [], stopReason: "toolUse" },
        toolResults: [],
        messageEntryId: "m",
        toolResultEntryIds: [],
        entries: earlierDrafts,
        continue: false,
        outcome: "completed",
        context: preview(entries),
      })) as BoundaryOutput | undefined;
    },
    beforeSettle: async (entries, outcome) => {
      sessionEntries = entries;
      return (await fire({ type: "agent_before_settle", entries: [], continue: false, outcome, context: preview(entries) })) as
        | BoundaryOutput
        | undefined;
    },
  };
}

type Block = { type: string; text?: string };

function placeholderPaths(blocks: Block[]): string[] {
  return blocks
    .filter((block) => block.type === "text" && block.text?.startsWith(PLACEHOLDER_MARK))
    .map((block) => /path "([^"]+)"/.exec(block.text ?? "")?.[1] ?? "?");
}

/** Paths whose image a request replaced, in request order. */
function removedInRequest(messages: AgentMessage[] | undefined): string[] {
  return (messages ?? []).flatMap((message) => ("content" in message && Array.isArray(message.content) ? placeholderPaths(message.content as Block[]) : []));
}

/** Paths whose image the saved drafts replace. */
function removedInDrafts(drafts: ContextEditEntryDraft[] | undefined): string[] {
  return (drafts ?? []).flatMap((draft) => placeholderPaths((draft.replacement?.content ?? []) as Block[]));
}

test("under the limit, a request is sent as it is and nothing is saved", async () => {
  const harness = await startExtension({ maxImages: 5, keepImages: 3 });
  const { entries } = screenshotSession(5);
  assert.equal(await harness.request(entries), undefined);
  assert.equal(await harness.turnEnd(entries), undefined);
});

test("above the limit, the request loses old images and the next turn saves the same text", async () => {
  const harness = await startExtension({ maxImages: 5, keepImages: 3 });
  const { entries, resultIds } = screenshotSession(6);
  const sent = await harness.request(entries);
  assert.deepEqual(removedInRequest(sent), ["/tmp/shot0.png", "/tmp/shot1.png", "/tmp/shot2.png"]);

  const output = await harness.turnEnd(entries);
  assert.deepEqual(output?.entries?.map((draft) => draft.targetId), resultIds.slice(0, 3));
  assert.equal(output?.continue, undefined);

  // The saved content must be exactly what was sent, or the prompt cache breaks twice.
  for (const draft of output?.entries ?? []) {
    const index = entries.findIndex((entry) => entry.sourceEntry.id === draft.targetId);
    const sentMessage = sent?.[index] as { content: unknown };
    assert.deepEqual(draft.replacement?.content, sentMessage.content);
  }
  assert.match(harness.notices[0]?.message ?? "", /removed 3 old images .* 3 images .* stay/);
});

test("the first request of a run is checked, before any turn ends", async () => {
  const harness = await startExtension({ maxImages: 5, keepImages: 3 });
  const { entries } = screenshotSession(8);
  // The last run ended with a reply. Now the user sends a new message.
  const resumed = [...entries, assistantEntry("All checks pass."), userEntry("continue")];
  const sent = await harness.request(resumed);
  assert.deepEqual(removedInRequest(sent), ["/tmp/shot0.png", "/tmp/shot1.png", "/tmp/shot2.png", "/tmp/shot3.png", "/tmp/shot4.png"]);
});

test("a retry of the same request reuses the decision and makes no new model calls", async () => {
  const harness = await startExtension(
    { maxImages: 5, keepImages: 3, ranking: { mode: "chat", model: "test/ranker" } },
    { "test/ranker": () => '{"scores": {"i1": 1}}' },
  );
  const { entries } = screenshotSession(6);
  const first = await harness.request(entries);
  const retry = await harness.request(entries);
  assert.deepEqual(retry, first);
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.notices.length, 1);
});

test("after the decision is saved, the next request needs no change", async () => {
  const harness = await startExtension({ maxImages: 5, keepImages: 3 });
  const { entries } = screenshotSession(6);
  await harness.request(entries);
  const drafts = (await harness.turnEnd(entries))?.entries ?? [];
  // Rebuild the entries the way pi projects them after the edits.
  const edited = entries.map((entry) => {
    const draft = drafts.find((candidate) => candidate.targetId === entry.sourceEntry.id);
    if (!draft?.replacement) return entry;
    const message = { ...(entry.messages[0] as object), content: draft.replacement.content };
    return { ...entry, messages: [message] } as ProjectedSessionEntry;
  });
  assert.equal(await harness.request(edited), undefined);
  assert.equal(await harness.turnEnd(edited), undefined);
});

test("drafts from earlier extensions in the same boundary are kept", async () => {
  const harness = await startExtension({ maxImages: 2, keepImages: 1 });
  const { entries } = screenshotSession(3);
  await harness.request(entries);
  const earlier = { type: "custom", customType: "other", data: {} };
  // pi replaces its draft list with the one a handler returns, so dropping it would lose them.
  const output = await harness.turnEnd(entries, [earlier]);
  assert.equal(output?.entries?.length, 3);
  assert.deepEqual(output?.entries?.[0], earlier);
});

test("chat ranking keeps a needed old image and sends no image data", async () => {
  const harness = await startExtension(
    { maxImages: 5, keepImages: 3, ranking: { mode: "chat", model: "test/ranker", keepTop: 1 } },
    { "test/ranker": () => '{"scores": {"i1": 9, "i2": 1, "i3": 1, "i4": 1}}' },
  );
  const { entries } = screenshotSession(6);
  const sent = await harness.request(entries);
  // shot0 scored 9 and stays. shot5 is protected, shot4 fills by recency.
  assert.deepEqual(removedInRequest(sent), ["/tmp/shot1.png", "/tmp/shot2.png", "/tmp/shot3.png"]);
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0]?.imageCount, 0);
  assert.doesNotMatch(harness.calls[0]?.text ?? "", /shot5/);
  assert.match(harness.notices[0]?.message ?? "", /Ranking scored 4 images and kept 1 older one that is still needed\./);
});

test("a failed ranking warns once and falls back to recency", async () => {
  const harness = await startExtension({ maxImages: 5, keepImages: 3, ranking: { mode: "chat", model: "test/ranker" } });
  const first = screenshotSession(6);
  assert.deepEqual(removedInRequest(await harness.request(first.entries)), ["/tmp/shot0.png", "/tmp/shot1.png", "/tmp/shot2.png"]);
  await harness.turnEnd(first.entries);
  const second = screenshotSession(6);
  await harness.request(second.entries);
  const warnings = harness.notices.filter((notice) => notice.level === "warning");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]?.message ?? "", /ranking request failed: 503 unavailable.*newest images were kept/);
});

test("a missing ranking model warns and falls back to recency", async () => {
  const harness = await startExtension({ maxImages: 5, keepImages: 3, ranking: { mode: "chat", model: "test/missing" } });
  const { entries } = screenshotSession(6);
  assert.equal(removedInRequest(await harness.request(entries)).length, 3);
  assert.match(harness.notices.find((notice) => notice.level === "warning")?.message ?? "", /"test\/missing" was not found/);
});

test("summary mode sends each removed image to the vision model and puts the summary in the placeholder", async () => {
  const harness = await startExtension(
    { maxImages: 2, keepImages: 1, replacement: "summary", summary: { model: "test/vision" } },
    { "test/vision": () => "A sidebar that overlaps the table." },
  );
  const { entries } = screenshotSession(3);
  const sent = await harness.request(entries);
  assert.equal(harness.calls.length, 2);
  assert.ok(harness.calls.every((call) => call.imageCount === 1));
  const texts = (sent ?? []).flatMap((message) => ("content" in message && Array.isArray(message.content) ? (message.content as Block[]).map((block) => block.text ?? "") : []));
  assert.equal(texts.filter((text) => text.includes("A sidebar that overlaps the table.")).length, 2);
});

test("a summary model without image input warns and uses plain placeholders", async () => {
  const harness = await startExtension({ maxImages: 2, keepImages: 1, replacement: "summary", summary: { model: "test/ranker" } });
  const { entries } = screenshotSession(3);
  assert.equal(removedInRequest(await harness.request(entries)).length, 2);
  assert.match(harness.notices.find((notice) => notice.level === "warning")?.message ?? "", /does not accept images/);
});

test("ranking shows progress and then gives the working message back", async () => {
  const harness = await startExtension(
    { maxImages: 5, keepImages: 3, ranking: { mode: "chat", model: "test/ranker" } },
    { "test/ranker": () => '{"scores": {"i1": 1}}' },
  );
  const { entries } = screenshotSession(6);
  await harness.request(entries);
  // Six images, and the newest is protected, so five are ranked.
  assert.deepEqual(harness.workingMessages, ["Image budget: ranking 5 old images…", undefined]);
});

test("summaries show a counter and then give the working message back", async () => {
  const harness = await startExtension(
    { maxImages: 2, keepImages: 1, replacement: "summary", summary: { model: "test/vision" } },
    { "test/vision": () => "A table." },
  );
  const { entries } = screenshotSession(3);
  await harness.request(entries);
  assert.deepEqual(harness.workingMessages, [
    "Image budget: summarizing images 0/2…",
    "Image budget: summarizing images 1/2…",
    "Image budget: summarizing images 2/2…",
    undefined,
  ]);
});

test("the working message comes back even when the ranking throws", async () => {
  const harness = await startExtension(
    { maxImages: 5, keepImages: 3, ranking: { mode: "chat", model: "test/ranker" } },
    {
      "test/ranker": () => {
        throw new Error("socket closed");
      },
    },
  );
  const { entries } = screenshotSession(6);
  await harness.request(entries);
  assert.equal(harness.workingMessages.at(-1), undefined);
  assert.match(harness.notices.find((notice) => notice.level === "warning")?.message ?? "", /socket closed/);
});

async function captureStderr(work: () => Promise<void>): Promise<string> {
  const written: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await work();
  } finally {
    process.stderr.write = originalWrite;
  }
  return written.join("");
}

test("without a UI, notices go to stderr", async () => {
  const harness = await startExtension({ maxImages: 2, keepImages: 1 }, {}, { hasUI: false });
  const { entries } = screenshotSession(3);
  const written = await captureStderr(async () => void (await harness.request(entries)));
  assert.equal(harness.notices.length, 0);
  assert.match(written, /^Image budget: removed 2 old images \(0\.0 MB\)\. 1 image \(0\.0 MB\) stays\./);
});

test("without a UI, only the start of each step goes to stderr", async () => {
  const harness = await startExtension(
    { maxImages: 2, keepImages: 1, replacement: "summary", summary: { model: "test/vision" } },
    { "test/vision": () => "A table." },
    { hasUI: false },
  );
  const { entries } = screenshotSession(3);
  const written = await captureStderr(async () => void (await harness.request(entries)));
  assert.equal(harness.workingMessages.length, 0);
  assert.equal(written.split("\n").filter((line) => line.includes("summarizing")).length, 1);
  assert.match(written, /summarizing images 0\/2…\n.*removed 2 old images/s);
});

const ANTHROPIC_413 = '413 {"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum allowed size of 32 MB"}}';

test("after a 413, all old images go, the failed reply is hidden, and the request runs again once", async () => {
  const harness = await startExtension({ maxImages: 100, keepImages: 50 });
  const { entries } = screenshotSession(4);
  const prompt = userEntry("one more", [100]);
  const failed = assistantEntry("", { stopReason: "error", errorMessage: ANTHROPIC_413 });
  const all = [...entries, prompt, failed, stateEntry("goal-state")];

  const output = await harness.beforeSettle(all, "error");
  assert.equal(output?.continue, true);
  assert.deepEqual(removedInDrafts(output?.entries), ["/tmp/shot0.png", "/tmp/shot1.png", "/tmp/shot2.png", "/tmp/shot3.png"]);
  assert.deepEqual(output?.entries?.at(-1), { type: "context_edit", targetId: failed.sourceEntry.id, replacement: null });

  // The same failure seen again must not loop.
  assert.equal(await harness.beforeSettle(all, "error"), undefined);
});

test("a 413 with no old images warns and does not retry", async () => {
  const harness = await startExtension({});
  const failed = assistantEntry("", { stopReason: "error", errorMessage: ANTHROPIC_413 });
  const output = await harness.beforeSettle([userEntry("big text", [10]), failed], "error");
  assert.equal(output, undefined);
  assert.match(harness.notices[0]?.message ?? "", /no old images to remove/);
});

test("recovery ignores other errors and can be turned off", async () => {
  const other = await startExtension({});
  const { entries } = screenshotSession(3);
  const otherFailure = assistantEntry("", { stopReason: "error", errorMessage: "520 unknown" });
  assert.equal(await other.beforeSettle([...entries, otherFailure], "error"), undefined);

  const off = await startExtension({ overflowRecovery: false });
  const failed = assistantEntry("", { stopReason: "error", errorMessage: ANTHROPIC_413 });
  assert.equal(await off.beforeSettle([...entries, failed], "error"), undefined);
});

test("a run that ends without a turn still saves the decision when it settles", async () => {
  const harness = await startExtension({ maxImages: 2, keepImages: 1 });
  const { entries } = screenshotSession(3);
  await harness.request(entries);
  const output = await harness.beforeSettle(entries, "aborted");
  assert.equal(removedInDrafts(output?.entries).length, 2);
  assert.equal(output?.continue, undefined);
});

test("a disabled extension does nothing", async () => {
  const harness = await startExtension({ enabled: false, maxImages: 1, keepImages: 1 });
  const { entries } = screenshotSession(5);
  assert.equal(await harness.request(entries), undefined);
  assert.equal(await harness.turnEnd(entries), undefined);
});
