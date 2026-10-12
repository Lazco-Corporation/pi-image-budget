import type { ProjectedSessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Recognize a provider that refused the request because of its byte size.
 *
 * pi's own `isContextOverflow()` also matches token overflow. Removing images
 * is the right answer only for the size refusal, so this list is narrower.
 */
const REQUEST_SIZE_PATTERNS = [
  /request_too_large/i, // Anthropic
  /^\s*413\b/, // Any HTTP 413 that pi reports with the status first
  /\bstatus(?: code)?:? 413\b/i,
  /payload too large/i,
  /request entity too large/i,
  /exceeds the maximum allowed size/i,
  /max bytes to request body/i,
];

export function isRequestTooLarge(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  return REQUEST_SIZE_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

export interface FailedRequest {
  entryId: string;
  errorMessage: string;
}

/**
 * The last assistant entry, when it is a request that was too large.
 *
 * State-only entries and extension messages can land after the error, for
 * example a goal tracker or a subagent notice. They are skipped. A user or
 * tool message after the error means the error is old news.
 */
export function findFailedRequest(entries: readonly ProjectedSessionEntry[]): FailedRequest | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    const message = entry?.messages[entry.messages.length - 1];
    if (!entry || !message || message.role === "custom") continue;
    if (message.role !== "assistant") return undefined;
    if (message.stopReason !== "error" || !isRequestTooLarge(message.errorMessage)) return undefined;
    return { entryId: entry.sourceEntry.id, errorMessage: message.errorMessage ?? "" };
  }
  return undefined;
}
