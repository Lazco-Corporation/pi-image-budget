import type { Api, AssistantMessage, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { splitModelRef, type Thinking } from "./config.ts";

/**
 * Small wrappers around the model registry for the helper calls: ranking and
 * summaries. Both are optional work, so every failure here becomes a warning
 * string and never an exception that could stop the agent.
 */

export type ModelLookup<T> = { ok: true; model: T } | { ok: false; warning: string };

export function findChatModel(context: ExtensionContext, reference: string | null, purpose: string): ModelLookup<Model<Api>> {
  if (!reference) return { ok: false, warning: `no ${purpose} model is set` };
  const parts = splitModelRef(reference);
  const model = parts ? context.modelRegistry.find(parts.provider, parts.modelId) : undefined;
  if (!model) return { ok: false, warning: `the ${purpose} model "${reference}" was not found` };
  if (!context.modelRegistry.hasConfiguredAuth(model)) {
    return { ok: false, warning: `the ${purpose} model "${reference}" has no authentication` };
  }
  return { ok: true, model };
}

/** A signal that fires on timeout, or when the agent run is stopped. */
export function requestSignal(context: ExtensionContext, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return context.signal ? AbortSignal.any([timeout, context.signal]) : timeout;
}

export interface CompleteInput {
  context: ExtensionContext;
  model: Model<Api>;
  content: (TextContent | ImageContent)[];
  thinking: Thinking;
  maxTokens: number;
  timeoutMs: number;
}

/** One user message in, the reply text out. Throws on any failure. */
export async function completeText(input: CompleteInput): Promise<string> {
  const { context, model, content, thinking, maxTokens, timeoutMs } = input;
  const stream = context.modelRegistry.streamSimple(
    model,
    { messages: [{ role: "user", content, timestamp: Date.now() }] },
    {
      maxTokens,
      // The prompt is new every time, so a cache write would only cost money.
      cacheRetention: "none",
      signal: requestSignal(context, timeoutMs),
      ...(thinking === "off" ? {} : { reasoning: thinking }),
    },
  );
  const reply: AssistantMessage = await stream.result();
  if (reply.stopReason === "error" || reply.stopReason === "aborted") {
    throw new Error(reply.errorMessage ?? `the request ended with "${reply.stopReason}"`);
  }
  return reply.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/** Run `work` over `items` with at most `limit` calls in flight. Results keep input order. */
export async function mapWithLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
