import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { defaultSettings, parseSettings } from "../src/config.ts";
import { overBudget, planOverflowRemoval, planRemoval, resolveLimits, type Limits, type PlanImage } from "../src/plan.ts";

const MEBIBYTE = 1024 * 1024;

function images(count: number, bytes = 100): PlanImage[] {
  return Array.from({ length: count }, (_, position) => ({ id: `img${position}`, position, bytes }));
}

function limits(overrides: Partial<Limits> = {}): Limits {
  return { maxImages: 10, maxBytes: 1_000_000, keepImages: 6, keepBytes: 600_000, ...overrides };
}

function model(inputLimits: Record<string, unknown>): Model<Api> {
  return { inputLimits } as unknown as Model<Api>;
}

test("limits default to 16 MiB when the model declares no request size", () => {
  const resolved = resolveLimits(defaultSettings(), undefined);
  assert.deepEqual(resolved, { maxImages: 30, maxBytes: 16 * MEBIBYTE, keepImages: 20, keepBytes: Math.floor(16 * MEBIBYTE * (20 / 30)) });
});

test("limits use half of the declared request size", () => {
  const resolved = resolveLimits(defaultSettings(), model({ maxRequestBytes: 10 * MEBIBYTE }));
  assert.equal(resolved.maxBytes, 5 * MEBIBYTE);
});

test("an explicit maxImageBytes wins over the model", () => {
  const resolved = resolveLimits(parseSettings({ maxImageBytes: 8 * MEBIBYTE }), model({ maxRequestBytes: 100 * MEBIBYTE }));
  assert.equal(resolved.maxBytes, 8 * MEBIBYTE);
});

test("a declared maxPerRequest lowers the count limits", () => {
  const resolved = resolveLimits(defaultSettings(), model({ images: { maxPerRequest: 12 } }));
  assert.equal(resolved.maxImages, 12);
  assert.equal(resolved.keepImages, 12);
});

test("nothing is removed under the limits", () => {
  assert.equal(overBudget(images(10), limits()), undefined);
  const plan = planRemoval({ images: images(10), limits: limits() });
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.reason, undefined);
});

test("above the count limit, removal goes down to the target and keeps the newest", () => {
  const plan = planRemoval({ images: images(11), limits: limits() });
  assert.equal(plan.reason, "count");
  assert.deepEqual(plan.keep, ["img5", "img6", "img7", "img8", "img9", "img10"]);
  assert.deepEqual(plan.remove, ["img0", "img1", "img2", "img3", "img4"]);
});

test("above the byte limit, removal goes down to the byte target", () => {
  const plan = planRemoval({ images: images(5, 300_000), limits: limits() });
  assert.equal(plan.reason, "bytes");
  assert.deepEqual(plan.keep, ["img3", "img4"]);
});

test("the newest image stays even when it alone is above the byte target", () => {
  const big: PlanImage[] = [
    { id: "old", position: 0, bytes: 100 },
    { id: "huge", position: 1, bytes: 2_000_000 },
  ];
  const plan = planRemoval({ images: big, limits: limits() });
  assert.deepEqual(plan.keep, ["huge"]);
  assert.deepEqual(plan.remove, ["old"]);
});

test("images of the latest turn stay while the hard cap allows", () => {
  const all = images(12);
  const protectedIds = new Set(["img4", "img5", "img6", "img7", "img8", "img9", "img10", "img11"]);
  const plan = planRemoval({ images: all, limits: limits(), protectedIds });
  // Eight protected images are above the target of six but below the hard cap of ten.
  assert.deepEqual(plan.keep, ["img4", "img5", "img6", "img7", "img8", "img9", "img10", "img11"]);
});

test("the hard cap applies to protected images too, and the newest still stays", () => {
  const all = images(14);
  const protectedIds = new Set(all.map((image) => image.id));
  const plan = planRemoval({ images: all, limits: limits() });
  assert.equal(plan.keep.length, 6);
  const capped = planRemoval({ images: all, limits: limits(), protectedIds });
  assert.equal(capped.keep.length, 10);
  assert.ok(capped.keep.includes("img13"));
});

test("scores keep needed old images before recency fills the rest", () => {
  const scores = new Map([
    ["img0", 0.9],
    ["img1", 0.2],
    ["img2", 0.8],
  ]);
  const plan = planRemoval({ images: images(11), limits: limits(), scores, keepTop: 2 });
  assert.deepEqual(plan.keep, ["img0", "img2", "img7", "img8", "img9", "img10"]);
});

test("a score below 0.5 earns no ranked place", () => {
  const scores = new Map([
    ["img0", 0.4],
    ["img1", 0.1],
  ]);
  const plan = planRemoval({ images: images(11), limits: limits(), scores, keepTop: 2 });
  assert.deepEqual(plan.keep, ["img5", "img6", "img7", "img8", "img9", "img10"]);
});

test("keepTop limits how many places the scores fill", () => {
  const scores = new Map(images(11).map((image) => [image.id, 1] as const));
  const plan = planRemoval({ images: images(11), limits: limits(), scores, keepTop: 1 });
  // The newest is kept first. Then one ranked place, ties broken by recency, then recency.
  assert.deepEqual(plan.keep, ["img5", "img6", "img7", "img8", "img9", "img10"]);
});

test("the overflow plan keeps only the newest image", () => {
  const plan = planOverflowRemoval(images(4));
  assert.deepEqual(plan.keep, ["img3"]);
  assert.deepEqual(plan.remove, ["img0", "img1", "img2"]);
  assert.deepEqual(planOverflowRemoval([]).remove, []);
});
