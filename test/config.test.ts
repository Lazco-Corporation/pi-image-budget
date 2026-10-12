import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultSettings, parseSettings, SETTINGS_FILE, SettingsStore, ValidationError } from "../src/config.ts";

test("an empty object gives the defaults", () => {
  assert.deepEqual(parseSettings({}), defaultSettings());
});

test("keepImages cannot be above maxImages", () => {
  const settings = parseSettings({ maxImages: 10, keepImages: 25 });
  assert.equal(settings.maxImages, 10);
  assert.equal(settings.keepImages, 10);
});

test("a small maxImages also lowers the default keepImages and keepTop", () => {
  const settings = parseSettings({ maxImages: 5 });
  assert.equal(settings.keepImages, 5);
  assert.equal(settings.ranking.keepTop, 5);
});

test("keepTop cannot be above keepImages", () => {
  assert.equal(parseSettings({ keepImages: 4, ranking: { keepTop: 9 } }).ranking.keepTop, 4);
});

test("maxImageBytes is clamped to at least 1 MiB", () => {
  assert.equal(parseSettings({ maxImageBytes: 10 }).maxImageBytes, 1024 * 1024);
  assert.equal(parseSettings({ maxImageBytes: null }).maxImageBytes, null);
});

test("nested settings keep their defaults for missing fields", () => {
  const settings = parseSettings({ ranking: { mode: "chat", model: "example-provider/example-model" } });
  assert.equal(settings.ranking.mode, "chat");
  assert.equal(settings.ranking.model, "example-provider/example-model");
  assert.equal(settings.ranking.keepTop, 10);
  assert.equal(settings.ranking.thinking, "low");
});

test("bad values are reported against the field", () => {
  assert.throws(() => parseSettings({ replacement: "blur" }), (error: unknown) => error instanceof ValidationError && /replacement/.test(error.message));
  assert.throws(() => parseSettings({ ranking: { mode: "vote" } }), /ranking\.mode/);
  assert.throws(() => parseSettings({ ranking: { model: "no-slash" } }), /ranking\.model/);
  assert.throws(() => parseSettings({ summary: "fast" }), /summary must be an object/);
  assert.throws(() => parseSettings({ maxImages: "many" }), /maxImages/);
  assert.throws(() => parseSettings([]), /JSON object/);
});

test("the store writes defaults on the first run and keeps a broken file", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-image-budget-config-"));
  try {
    const store = new SettingsStore(directory);
    assert.deepEqual(store.load().settings, defaultSettings());
    const written = JSON.parse(readFileSync(join(directory, SETTINGS_FILE), "utf8"));
    assert.deepEqual(written, defaultSettings());

    writeFileSync(join(directory, SETTINGS_FILE), "{ broken", "utf8");
    const result = store.load();
    assert.match(result.error ?? "", /not valid JSON/);
    assert.deepEqual(result.settings, defaultSettings());
    assert.equal(readFileSync(join(directory, SETTINGS_FILE), "utf8"), "{ broken");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
