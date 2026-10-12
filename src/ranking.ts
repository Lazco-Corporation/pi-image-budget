import type { ClassifierApi, ClassifierModel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { splitModelRef, type RankingSettings } from "./config.ts";
import { describeSource, type ImageRecord } from "./images.ts";
import { completeText, errorText, findChatModel, mapWithLimit, requestSignal } from "./models.ts";

/**
 * Score how much the agent still needs each old image.
 *
 * The ranker never sees an image. It reads only text: where the image came
 * from, the text next to it, what the agent wrote after it, and the current
 * task. That keeps the call cheap and lets any text model do the job.
 */

export interface RankingResult {
  /** 0 to 1 per image id. Higher means more needed. */
  scores: Map<string, number>;
  /** Set when ranking did not run or failed. The caller falls back to recency. */
  warning?: string;
}

interface Candidate {
  key: string;
  record: ImageRecord;
}

function candidateFacts(candidate: Candidate, total: number): Record<string, string> {
  const { record } = candidate;
  return {
    id: candidate.key,
    order: `${record.position + 1} of ${total} (1 is the oldest)`,
    source: describeSource(record.source),
    text_with_image: record.nearbyText || "(none)",
    agent_text_after: record.followUpText || "(none)",
  };
}

export function buildChatPrompt(task: string, candidates: readonly Candidate[], total: number): string {
  const facts = candidates.map((candidate) => candidateFacts(candidate, total));
  return [
    "A coding agent has old images in its conversation: screenshots, files it read, and captures.",
    "Some must be removed to keep its next request small enough.",
    "Score how much the agent still needs each image to finish its current task.",
    "",
    "You cannot see the images. Judge from the text only: where each image came from, the text next to it, and what the agent wrote after it.",
    "",
    "Scale: 0 means not needed, 10 means clearly needed.",
    "- Score high when the task still depends on what the image shows: a bug that is not fixed, a design to match, or a state to compare against.",
    "- Score low when the image was a step that is done, a check that passed, or an earlier version of something that a newer image shows again.",
    "",
    'Reply with JSON only, in this shape: {"scores": {"<id>": <0-10>}}. Include every id.',
    "",
    "<task>",
    task || "(unknown)",
    "</task>",
    "",
    "<images>",
    JSON.stringify(facts, null, 1),
    "</images>",
  ].join("\n");
}

/**
 * Read the scores out of a model reply.
 *
 * Models wrap JSON in code fences or add a sentence before it however firmly
 * the prompt says not to, so this looks for the outermost object.
 */
export function parseChatScores(reply: string, keys: readonly string[]): Map<string, number> {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the reply holds no JSON object");
  const parsed: unknown = JSON.parse(reply.slice(start, end + 1));
  const scoresObject =
    parsed && typeof parsed === "object" && "scores" in parsed && parsed.scores && typeof parsed.scores === "object"
      ? (parsed.scores as Record<string, unknown>)
      : (parsed as Record<string, unknown>);

  const scores = new Map<string, number>();
  for (const key of keys) {
    const value = scoresObject[key];
    const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (Number.isFinite(number)) scores.set(key, Math.min(1, Math.max(0, number / 10)));
  }
  if (scores.size === 0) throw new Error("the reply holds no usable scores");
  return scores;
}

async function rankWithChat(
  context: ExtensionContext,
  settings: RankingSettings,
  task: string,
  candidates: readonly Candidate[],
  total: number,
): Promise<RankingResult> {
  const lookup = findChatModel(context, settings.model, "ranking");
  if (!lookup.ok) return { scores: new Map(), warning: lookup.warning };

  try {
    const reply = await completeText({
      context,
      model: lookup.model,
      content: [{ type: "text", text: buildChatPrompt(task, candidates, total) }],
      thinking: settings.thinking,
      // Reasoning models count thinking tokens against this cap.
      maxTokens: 4000 + candidates.length * 20,
      timeoutMs: settings.timeoutMs,
    });
    const byKey = parseChatScores(reply, candidates.map((candidate) => candidate.key));
    const scores = new Map<string, number>();
    for (const candidate of candidates) {
      const score = byKey.get(candidate.key);
      if (score !== undefined) scores.set(candidate.record.id, score);
    }
    return { scores };
  } catch (error) {
    return { scores: new Map(), warning: `the ranking request failed: ${errorText(error)}` };
  }
}

async function findClassifier(
  context: ExtensionContext,
  reference: string | null,
): Promise<{ ok: true; model: ClassifierModel<ClassifierApi> } | { ok: false; warning: string }> {
  if (!reference) return { ok: false, warning: "no ranking model is set" };
  const parts = splitModelRef(reference);
  if (!parts) return { ok: false, warning: `the ranking model "${reference}" is not "provider/modelId"` };
  const available = await context.modelRegistry.getAvailableOfType("classifier", parts.provider);
  const model = available.find((candidate) => candidate.id === parts.modelId);
  if (model) return { ok: true, model };
  const known = context.modelRegistry.getModelOfType("classifier", parts.provider, parts.modelId);
  return {
    ok: false,
    warning: known
      ? `the classifier "${reference}" has no authentication`
      : `the classifier "${reference}" was not found`,
  };
}

async function rankWithClassifier(
  context: ExtensionContext,
  settings: RankingSettings,
  task: string,
  candidates: readonly Candidate[],
  total: number,
): Promise<RankingResult> {
  const lookup = await findClassifier(context, settings.model);
  if (!lookup.ok) return { scores: new Map(), warning: lookup.warning };

  const failures: string[] = [];
  const scores = new Map<string, number>();
  // A classifier answers one state per call, so each image is one call.
  await mapWithLimit(candidates, 4, async (candidate) => {
    const result = await context.modelRegistry.classify(
      lookup.model,
      {
        state: { task: task || "(unknown)", image: candidateFacts(candidate, total) },
        questions: {
          needed: {
            type: "bool",
            instructions:
              "A coding agent cannot see this image any more unless it is kept in its context. Judge from the text only. Does the agent still need to see this image to finish its current task?",
            criteria: {
              true: "The task still depends on what the image shows: an open bug, a design to match, or a state to compare against.",
              false: "The image was a finished step, a check that passed, or an older version of something a newer image shows.",
            },
          },
        },
      },
      { signal: requestSignal(context, settings.timeoutMs) },
    );
    const answer = result.answers.needed;
    if (result.stopReason === "stop" && answer?.type === "bool") {
      scores.set(candidate.record.id, answer.probability);
    } else {
      failures.push(result.errorMessage ?? result.stopReason);
    }
  });

  if (scores.size === 0) {
    return { scores, warning: `the classifier failed: ${failures[0] ?? "no answers"}` };
  }
  return { scores };
}

export async function rankImages(
  context: ExtensionContext,
  settings: RankingSettings,
  task: string,
  images: readonly ImageRecord[],
  total: number,
): Promise<RankingResult> {
  if (settings.mode === "off" || images.length === 0) return { scores: new Map() };
  // Short keys keep the prompt small and stop the model from echoing long entry ids wrongly.
  const candidates = images.map((record, index) => ({ key: `i${index + 1}`, record }));
  try {
    return settings.mode === "chat"
      ? await rankWithChat(context, settings, task, candidates, total)
      : await rankWithClassifier(context, settings, task, candidates, total);
  } catch (error) {
    return { scores: new Map(), warning: `ranking failed: ${errorText(error)}` };
  }
}
