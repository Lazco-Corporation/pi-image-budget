import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";
import { SettingsStore, type Settings } from "./config.ts";
import { collectImages, describeTask, type ImageRecord } from "./images.ts";
import { findFailedRequest } from "./overflow.ts";
import { buildContextEdits } from "./placeholder.ts";
import { overBudget, planOverflowRemoval, planRemoval, resolveLimits } from "./plan.ts";
import { rankImages } from "./ranking.ts";
import { applyEditsToMessages } from "./request.ts";
import { summarizeImages } from "./summary.ts";

/**
 * Keeps old images from filling the provider's request size limit.
 *
 * Every image the agent reads or captures stays in the conversation and is
 * sent again with every request. Each one is small, but a long session adds
 * them up until the provider refuses the request, for example with
 * Anthropic's 32 MB limit, while the token count is still far from the
 * context window.
 *
 * Right before each request, this extension counts the images. Above the
 * limit it decides which old images to swap for a text placeholder and
 * applies that to the request. pi lets only a boundary event save a context
 * edit, so the same decision is saved at the next `turn_end`, and the saved
 * text matches what was sent. The raw session keeps every image, and `/tree`
 * can go back to a point before an edit.
 */

const NOTIFY_PREFIX = "Image budget";

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `1 old image`, `3 old images`. */
function count(amount: number, singular: string, plural = `${singular}s`): string {
  return `${amount} ${amount === 1 ? singular : plural}`;
}

/** A removal that a request already used and the session has not saved yet. */
interface PendingDecision {
  removed: ImageRecord[];
  summaries: Map<string, string>;
}

/**
 * Entries after the last assistant reply: the tool results of the latest
 * turn, or a new user message. The agent often makes several captures at once
 * to compare them, so their images are protected together.
 */
function latestTurnEntryIds(entries: readonly ProjectedSessionEntry[]): Set<string> {
  const ids = new Set<string>();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.messages.some((message) => message.role === "assistant")) break;
    ids.add(entry.sourceEntry.id);
  }
  return ids;
}

export default function (pi: ExtensionAPI) {
  const store = new SettingsStore(getAgentDir());
  let settings: Settings = store.load().settings;
  /** Warnings already shown in this session, so a repeated failure does not flood the screen. */
  const shownWarnings = new Set<string>();
  /** Failed requests already handled, so recovery runs once per failure. */
  const recoveredFailures = new Set<string>();
  let pending: PendingDecision | undefined;

  const notify = (context: ExtensionContext, message: string, level: "info" | "warning"): void => {
    if (context.hasUI) {
      context.ui.notify(`${NOTIFY_PREFIX}: ${message}`, level);
      return;
    }
    // Print and JSON mode keep stdout for the answer. A silent fallback there
    // would hide a broken ranking or summary model for good.
    process.stderr.write(`${NOTIFY_PREFIX}: ${message}\n`);
  };

  /**
   * Show what the extension is doing while the agent waits for it.
   *
   * Ranking and summaries run before the request, so without this the
   * spinner looks like a slow model. In the TUI the text replaces pi's working
   * message. Without a UI, only the start of a step goes to stderr: a line
   * per image would flood a log.
   */
  const showProgress = (context: ExtensionContext, message: string, isStepStart: boolean): void => {
    if (context.hasUI) {
      context.ui.setWorkingMessage(`${NOTIFY_PREFIX}: ${message}`);
      return;
    }
    if (isStepStart) process.stderr.write(`${NOTIFY_PREFIX}: ${message}\n`);
  };

  const clearProgress = (context: ExtensionContext): void => {
    // No argument puts pi's own working message back.
    if (context.hasUI) context.ui.setWorkingMessage();
  };

  const warnOnce = (context: ExtensionContext, message: string): void => {
    if (shownWarnings.has(message)) return;
    shownWarnings.add(message);
    notify(context, message, "warning");
  };

  const reportSettingsError = (context: ExtensionContext): void => {
    const error = store.getError();
    if (error) warnOnce(context, `${error}. Defaults are in use, and ${store.getPath()} was left alone.`);
  };

  /** Decide which images leave the request, or nothing when the images fit. */
  const decide = async (context: ExtensionContext, entries: readonly ProjectedSessionEntry[]): Promise<PendingDecision | undefined> => {
    const { images } = collectImages(entries);
    const limits = resolveLimits(settings, context.model);
    if (!overBudget(images, limits)) return undefined;

    const latestEntries = latestTurnEntryIds(entries);
    const protectedIds = new Set(images.filter((image) => latestEntries.has(image.entryId)).map((image) => image.id));
    const newest = images[images.length - 1];

    let scores: Map<string, number> | undefined;
    if (settings.ranking.mode !== "off") {
      const candidates = images.filter((image) => !protectedIds.has(image.id) && image !== newest);
      showProgress(context, `ranking ${count(candidates.length, "old image")}…`, true);
      try {
        const ranking = await rankImages(context, settings.ranking, describeTask(entries), candidates, images.length);
        if (ranking.warning) warnOnce(context, `${ranking.warning}. The newest images were kept instead of the best scored ones.`);
        scores = ranking.scores;
      } finally {
        clearProgress(context);
      }
    }

    const plan = planRemoval({ images, limits, protectedIds, scores, keepTop: settings.ranking.keepTop });
    if (plan.remove.length === 0) return undefined;

    // Images that stay only because the ranker asked for them: kept, but
    // older than everything recency alone would have kept.
    const recencyKeepFrom = images.length - plan.keep.length;
    const rankedKeeps = images.filter((image, index) => index < recencyKeepFrom && plan.keep.includes(image.id)).length;

    const removeIds = new Set(plan.remove);
    const removed = images.filter((image) => removeIds.has(image.id));

    let summaries = new Map<string, string>();
    if (settings.replacement === "summary") {
      showProgress(context, `summarizing images 0/${removed.length}…`, true);
      try {
        const result = await summarizeImages(context, settings.summary, removed, (finished, total) =>
          showProgress(context, `summarizing images ${finished}/${total}…`, false),
        );
        if (result.warning) warnOnce(context, result.warning);
        summaries = result.summaries;
      } finally {
        clearProgress(context);
      }
    }

    const removedBytes = removed.reduce((sum, image) => sum + image.bytes, 0);
    const keptBytes = images.reduce((sum, image) => sum + image.bytes, 0) - removedBytes;
    const rankingNote =
      scores && scores.size > 0
        ? ` Ranking scored ${count(scores.size, "image")} and kept ${count(rankedKeeps, "older one")} that ${rankedKeeps === 1 ? "is" : "are"} still needed.`
        : "";
    notify(
      context,
      `removed ${count(removed.length, "old image")} (${megabytes(removedBytes)}). ${count(plan.keep.length, "image")} (${megabytes(keptBytes)}) ${plan.keep.length === 1 ? "stays" : "stay"}.${rankingNote}`,
      "info",
    );
    return { removed, summaries };
  };

  /** The context edits that save the pending decision, built against the entries as they are now. */
  const takePendingDrafts = (entries: readonly ProjectedSessionEntry[]) => {
    if (!pending) return [];
    const drafts = buildContextEdits(entries, pending.removed, pending.summaries);
    pending = undefined;
    return drafts;
  };

  pi.on("session_start", (_event, context) => {
    shownWarnings.clear();
    recoveredFailures.clear();
    pending = undefined;
    // A settings file edited between sessions takes effect without a restart.
    settings = store.load().settings;
    reportSettingsError(context);
  });

  pi.on("context", async (event, context) => {
    // A decision that a request already used must still be applied, so a
    // retry of that request sends the same text and is not decided again.
    if (!settings.enabled && !pending) return;

    const entries = context.sessionManager.buildSessionProjection().entries;
    if (!pending) {
      pending = await decide(context, entries);
      if (!pending) return;
    }

    const drafts = buildContextEdits(entries, pending.removed, pending.summaries);
    const { messages, applied } = applyEditsToMessages(event.messages, entries, drafts);
    return applied > 0 ? { messages } : undefined;
  });

  pi.on("turn_end", (event) => {
    // The request that used the decision is done, failed or not. The
    // decision still holds for the next request, so it is saved either way.
    const drafts = takePendingDrafts(event.context.contextEntries);
    if (drafts.length === 0) return;
    return { entries: [...event.entries, ...drafts] };
  });

  pi.on("agent_before_settle", (event, context) => {
    const entries = event.context.contextEntries;
    const failed = settings.enabled && settings.overflowRecovery && event.outcome === "error" ? findFailedRequest(entries) : undefined;

    if (!failed || recoveredFailures.has(failed.entryId)) {
      // A run can end without a turn, for example when it stops before the reply.
      const drafts = takePendingDrafts(entries);
      return drafts.length > 0 ? { entries: [...event.entries, ...drafts] } : undefined;
    }
    recoveredFailures.add(failed.entryId);
    // The recovery below removes more than any pending decision would.
    pending = undefined;

    const { images } = collectImages(entries);
    const plan = planOverflowRemoval(images);
    if (plan.remove.length === 0) {
      notify(context, "the provider refused the request as too large, and there are no old images to remove.", "warning");
      return;
    }

    const removeIds = new Set(plan.remove);
    const removed = images.filter((image) => removeIds.has(image.id));
    // Placeholders only. The session is stuck at this point, and a summary call
    // per image would make the user wait for work that is optional.
    const drafts = [
      ...buildContextEdits(entries, removed),
      // pi continues only when the context does not end with an assistant
      // message, and the failed reply is such a message. It holds no content.
      { type: "context_edit" as const, targetId: failed.entryId, replacement: null },
    ];
    notify(
      context,
      `the request was too large. Removed ${count(removed.length, "old image")} (${megabytes(removed.reduce((sum, image) => sum + image.bytes, 0))}) and sent it again.`,
      "warning",
    );
    return { entries: [...event.entries, ...drafts], continue: true };
  });

  pi.registerCommand("image-budget", {
    description: "Show the image budget of this session (/image-budget, /image-budget reload, /image-budget path)",
    handler: async (args, context) => {
      const argument = args.trim().toLowerCase();

      if (argument === "path") {
        context.ui.notify(store.getPath(), "info");
        return;
      }

      if (argument === "reload") {
        const result = store.load();
        settings = result.settings;
        shownWarnings.clear();
        context.ui.notify(
          result.error ? `${NOTIFY_PREFIX}: reloaded with defaults: ${result.error}` : `${NOTIFY_PREFIX}: settings reloaded.`,
          result.error ? "warning" : "info",
        );
        return;
      }

      if (argument.length > 0) {
        context.ui.notify(`Unknown argument "${argument}". Use /image-budget, /image-budget reload, or /image-budget path.`, "warning");
        return;
      }

      reportSettingsError(context);
      const { images, totalBytes } = collectImages(context.sessionManager.buildSessionProjection().entries);
      const limits = resolveLimits(settings, context.model);
      const lines = [
        `${NOTIFY_PREFIX}${settings.enabled ? "" : " (disabled)"}`,
        `Images in the request: ${images.length} (${megabytes(totalBytes)})`,
        `Removal starts above: ${limits.maxImages} images or ${megabytes(limits.maxBytes)}`,
        `Removal stops at: ${limits.keepImages} images and ${megabytes(limits.keepBytes)}`,
        `Ranking: ${settings.ranking.mode}${settings.ranking.mode === "off" ? "" : ` (${settings.ranking.model ?? "no model"}, top ${settings.ranking.keepTop})`}`,
        `Replacement: ${settings.replacement}${settings.replacement === "summary" ? ` (${settings.summary.model ?? "no model"})` : ""}`,
        `Recovery after "request too large": ${settings.overflowRecovery ? "on" : "off"}`,
      ];
      context.ui.notify(lines.join("\n"), "info");
    },
    getArgumentCompletions: (argumentPrefix) => {
      const options = [
        { value: "reload", label: "reload", description: "Read the settings file again" },
        { value: "path", label: "path", description: "Show where the settings file lives" },
      ];
      const prefix = argumentPrefix.trim().toLowerCase();
      return options.filter((option) => option.value.startsWith(prefix));
    },
  });
}
