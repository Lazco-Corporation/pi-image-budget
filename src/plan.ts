import type { Api, Model } from "@earendil-works/pi-ai";
import type { Settings } from "./config.ts";

/**
 * Decide which images leave the request. Pure functions only, so every rule
 * here is covered by tests without a session.
 */

export interface Limits {
  /** Hard cap: a removal starts above this count. */
  maxImages: number;
  /** Hard cap: a removal starts above this many base64 bytes. */
  maxBytes: number;
  /** Target after a removal. */
  keepImages: number;
  keepBytes: number;
}

const MEBIBYTE = 1024 * 1024;
/** A score below this does not earn a ranked place. The image can still stay by recency. */
export const MIN_KEEP_SCORE = 0.5;
/** Half of the Anthropic limit of 32 MiB. The rest is for text, tools, and the system prompt. */
const DEFAULT_MAX_IMAGE_BYTES = 16 * MEBIBYTE;
/** The share of a declared request size that images may use. */
const IMAGE_SHARE_OF_REQUEST = 0.5;

/**
 * Combine the settings with what the model declares in `models.json`.
 *
 * pi reads `inputLimits.maxRequestBytes` and `images.maxPerRequest` but does
 * not act on them yet. Using them here makes those fields do their job.
 */
export function resolveLimits(settings: Settings, model: Model<Api> | undefined): Limits {
  const declaredRequestBytes = model?.inputLimits?.maxRequestBytes;
  const maxBytes =
    settings.maxImageBytes ??
    (declaredRequestBytes ? Math.floor(declaredRequestBytes * IMAGE_SHARE_OF_REQUEST) : DEFAULT_MAX_IMAGE_BYTES);

  const declaredPerRequest = model?.inputLimits?.images?.maxPerRequest;
  const maxImages = declaredPerRequest ? Math.max(1, Math.min(settings.maxImages, declaredPerRequest)) : settings.maxImages;
  const keepImages = Math.min(settings.keepImages, maxImages);
  // The byte target keeps the same proportion as the count target.
  const keepBytes = Math.floor(maxBytes * (keepImages / maxImages));

  return { maxImages, maxBytes, keepImages, keepBytes };
}

export interface PlanImage {
  id: string;
  /** 0 is the oldest. */
  position: number;
  bytes: number;
}

export type PlanReason = "count" | "bytes" | "count-and-bytes" | "overflow";

export interface Plan {
  remove: string[];
  keep: string[];
  reason?: PlanReason;
}

export function overBudget(images: readonly PlanImage[], limits: Limits): PlanReason | undefined {
  const bytes = images.reduce((sum, image) => sum + image.bytes, 0);
  const overCount = images.length > limits.maxImages;
  const overBytes = bytes > limits.maxBytes;
  if (overCount && overBytes) return "count-and-bytes";
  if (overCount) return "count";
  if (overBytes) return "bytes";
  return undefined;
}

export interface PlanInput {
  images: readonly PlanImage[];
  limits: Limits;
  /** Images of the latest turn. They stay while the hard cap allows it. */
  protectedIds?: ReadonlySet<string>;
  /** 0 to 1, higher means more needed. Missing ids rank last. */
  scores?: ReadonlyMap<string, number>;
  /** How many places the scores may fill before recency fills the rest. */
  keepTop?: number;
}

function newestFirst(images: readonly PlanImage[]): PlanImage[] {
  return [...images].sort((left, right) => right.position - left.position);
}

/**
 * Pick the images to keep, in priority order, until the targets are reached.
 *
 * 1. The newest image always stays.
 * 2. Images of the latest turn stay while they fit under the hard cap. The
 *    agent often makes several captures at once to compare them.
 * 3. The best scored old images fill up to `keepTop` places. Only images that
 *    the ranker calls needed (score of 0.5 or more) get such a place.
 * 4. The newest of the rest fill the places that remain.
 *
 * Removal goes down to the target, not just under the cap. Every removal
 * changes old messages and so breaks the prompt cache from that point. A gap
 * between the cap and the target means that happens once per many images, not
 * once per turn.
 */
export function planRemoval(input: PlanInput): Plan {
  const { images, limits } = input;
  const reason = overBudget(images, limits);
  if (!reason || images.length === 0) return { remove: [], keep: images.map((image) => image.id) };

  const ordered = newestFirst(images);
  const newest = ordered[0];
  if (!newest) return { remove: [], keep: [] };

  const kept = new Set<string>([newest.id]);
  let keptBytes = newest.bytes;

  const tryKeep = (image: PlanImage, countLimit: number, byteLimit: number): void => {
    if (kept.has(image.id)) return;
    if (kept.size >= countLimit || keptBytes + image.bytes > byteLimit) return;
    kept.add(image.id);
    keptBytes += image.bytes;
  };

  const protectedIds = input.protectedIds ?? new Set<string>();
  for (const image of ordered) {
    if (protectedIds.has(image.id)) tryKeep(image, limits.maxImages, limits.maxBytes);
  }

  const scores = input.scores;
  const keepTop = input.keepTop ?? 0;
  if (scores && scores.size > 0 && keepTop > 0) {
    const ranked = ordered
      .filter((image) => !kept.has(image.id) && (scores.get(image.id) ?? 0) >= MIN_KEEP_SCORE)
      .sort((left, right) => (scores.get(right.id) ?? 0) - (scores.get(left.id) ?? 0) || right.position - left.position);
    let added = 0;
    for (const image of ranked) {
      if (added >= keepTop) break;
      const before = kept.size;
      tryKeep(image, limits.keepImages, limits.keepBytes);
      if (kept.size > before) added++;
    }
  }

  for (const image of ordered) tryKeep(image, limits.keepImages, limits.keepBytes);

  return {
    remove: images.filter((image) => !kept.has(image.id)).map((image) => image.id),
    keep: images.filter((image) => kept.has(image.id)).map((image) => image.id),
    reason,
  };
}

/** The emergency plan after a "request too large" error: keep only the newest image. */
export function planOverflowRemoval(images: readonly PlanImage[]): Plan {
  const newest = newestFirst(images)[0];
  if (!newest) return { remove: [], keep: [] };
  return {
    remove: images.filter((image) => image.id !== newest.id).map((image) => image.id),
    keep: [newest.id],
    reason: "overflow",
  };
}
