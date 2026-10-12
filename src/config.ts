import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The settings file: its shape, its defaults, and how it is read and written.
 *
 * Validation is written by hand. The file holds about fifteen fields and the
 * extension loads on every process start, so a schema library costs more than
 * it saves.
 */

/** How hard a helper model may think. `off` sends no reasoning setting at all. */
export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** What takes the place of a removed image. */
export type Replacement = "placeholder" | "summary";

/**
 * Who scores old images before a removal.
 *
 * `chat` asks a chat model for JSON scores. `classifier` uses a pi classifier
 * model, such as TypeSafe Jev. `off` keeps the newest images.
 */
export type RankingMode = "off" | "chat" | "classifier";

export interface RankingSettings {
  mode: RankingMode;
  /** `"provider/modelId"`. Required when `mode` is not `off`. */
  model: string | null;
  /** How many old images the scores may keep. Recency fills the remaining places. */
  keepTop: number;
  thinking: Thinking;
  timeoutMs: number;
}

export interface SummarySettings {
  /** `"provider/modelId"` of a model that accepts images. Required for `replacement: "summary"`. */
  model: string | null;
  maxWords: number;
  thinking: Thinking;
  timeoutMs: number;
}

export interface Settings {
  enabled: boolean;
  /** A removal starts when the request holds more images than this. */
  maxImages: number;
  /** A removal stops when this many images remain. */
  keepImages: number;
  /**
   * A removal also starts when the images hold more base64 bytes than this.
   * Null derives the value from the model: half of `inputLimits.maxRequestBytes`,
   * or 16 MiB when the model does not declare a request size.
   */
  maxImageBytes: number | null;
  replacement: Replacement;
  ranking: RankingSettings;
  summary: SummarySettings;
  /** After a "request too large" error, remove all old images once and send the request again. */
  overflowRecovery: boolean;
}

export const SETTINGS_FILE = "image-budget.json";

const THINKING_LEVELS: readonly Thinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const REPLACEMENTS: readonly Replacement[] = ["placeholder", "summary"];
const RANKING_MODES: readonly RankingMode[] = ["off", "chat", "classifier"];

const MEBIBYTE = 1024 * 1024;

export function defaultSettings(): Settings {
  return {
    enabled: true,
    maxImages: 30,
    keepImages: 20,
    maxImageBytes: null,
    replacement: "placeholder",
    ranking: { mode: "off", model: null, keepTop: 10, thinking: "low", timeoutMs: 30_000 },
    summary: { model: null, maxWords: 80, thinking: "low", timeoutMs: 60_000 },
    overflowRecovery: true,
  };
}

export class ValidationError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boolField(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new ValidationError(`${field} must be true or false`);
  return value;
}

function clampedInteger(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${field} must be a number`);
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ValidationError(`${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

/** Checked at load, so a typo is reported against the file and not as a failed request later. */
function modelField(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ValidationError(`${field} must be text or null`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!splitModelRef(trimmed)) {
    throw new ValidationError(`${field} must look like "provider/modelId"`);
  }
  return trimmed;
}

function objectField(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) throw new ValidationError(`${field} must be an object`);
  return value;
}

export function parseSettings(input: unknown): Settings {
  if (!isPlainObject(input)) throw new ValidationError("the file must hold a JSON object");
  const fallback = defaultSettings();

  const maxImages = clampedInteger(input.maxImages, "maxImages", 1, 1000, fallback.maxImages);
  // A target above the trigger would make every turn a removal turn.
  const keepImages = clampedInteger(input.keepImages, "keepImages", 1, maxImages, Math.min(fallback.keepImages, maxImages));

  let maxImageBytes: number | null = null;
  if (input.maxImageBytes !== undefined && input.maxImageBytes !== null) {
    maxImageBytes = clampedInteger(input.maxImageBytes, "maxImageBytes", MEBIBYTE, 1024 * MEBIBYTE, 16 * MEBIBYTE);
  }

  const ranking = objectField(input.ranking, "ranking");
  const summary = objectField(input.summary, "summary");

  return {
    enabled: boolField(input.enabled, "enabled", fallback.enabled),
    maxImages,
    keepImages,
    maxImageBytes,
    replacement: oneOf(input.replacement, "replacement", REPLACEMENTS, fallback.replacement),
    ranking: {
      mode: oneOf(ranking.mode, "ranking.mode", RANKING_MODES, fallback.ranking.mode),
      model: modelField(ranking.model, "ranking.model"),
      keepTop: clampedInteger(ranking.keepTop, "ranking.keepTop", 0, keepImages, Math.min(fallback.ranking.keepTop, keepImages)),
      thinking: oneOf(ranking.thinking, "ranking.thinking", THINKING_LEVELS, fallback.ranking.thinking),
      timeoutMs: clampedInteger(ranking.timeoutMs, "ranking.timeoutMs", 1000, 600_000, fallback.ranking.timeoutMs),
    },
    summary: {
      model: modelField(summary.model, "summary.model"),
      maxWords: clampedInteger(summary.maxWords, "summary.maxWords", 10, 400, fallback.summary.maxWords),
      thinking: oneOf(summary.thinking, "summary.thinking", THINKING_LEVELS, fallback.summary.thinking),
      timeoutMs: clampedInteger(summary.timeoutMs, "summary.timeoutMs", 1000, 600_000, fallback.summary.timeoutMs),
    },
    overflowRecovery: boolField(input.overflowRecovery, "overflowRecovery", fallback.overflowRecovery),
  };
}

/** Split `"provider/modelId"`. The id may itself hold slashes. */
export function splitModelRef(reference: string): { provider: string; modelId: string } | undefined {
  const slash = reference.indexOf("/");
  if (slash <= 0 || slash === reference.length - 1) return undefined;
  return { provider: reference.slice(0, slash), modelId: reference.slice(slash + 1) };
}

export interface LoadResult {
  settings: Settings;
  /** Why the file on disk could not be used, when that happened. */
  error?: string;
}

/**
 * Reads the settings file.
 *
 * A file that fails to load is never overwritten. A hand-edited file with a
 * typo must survive the run that found the typo.
 */
export class SettingsStore {
  private readonly path: string;
  private loadError: string | undefined;

  constructor(agentDir: string) {
    this.path = join(agentDir, SETTINGS_FILE);
  }

  getPath(): string {
    return this.path;
  }

  getError(): string | undefined {
    return this.loadError;
  }

  load(): LoadResult {
    if (!existsSync(this.path)) {
      const settings = defaultSettings();
      this.loadError = undefined;
      // The first run leaves a file behind so the user has something to edit.
      try {
        this.writeFile(settings);
      } catch {
        // A read-only home directory must not stop the image budget.
      }
      return { settings };
    }

    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return this.failed("the settings file could not be read");
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw.replace(/^\uFEFF/, ""));
    } catch {
      return this.failed("the settings file is not valid JSON");
    }

    try {
      const settings = parseSettings(parsedJson);
      this.loadError = undefined;
      return { settings };
    } catch (error) {
      const detail = error instanceof ValidationError ? error.message : "the settings file has an unexpected shape";
      return this.failed(detail);
    }
  }

  private failed(message: string): LoadResult {
    this.loadError = message;
    return { settings: defaultSettings(), error: message };
  }

  /** Write through a temporary file and a rename, so a reader never sees half a file. */
  private writeFile(settings: Settings): void {
    const target = resolveWriteTarget(this.path);
    const directory = dirname(target);
    mkdirSync(directory, { recursive: true });
    const temporary = join(directory, `.${SETTINGS_FILE}.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    renameSync(temporary, target);
  }
}

/**
 * Find the real file a write must land in.
 *
 * A rename onto a symlink replaces the link with a plain file, which breaks a
 * dotfile setup. Following the link by hand keeps it.
 */
function resolveWriteTarget(path: string): string {
  let current = path;
  // A small bound stops a link loop.
  for (let hop = 0; hop < 8; hop++) {
    let isLink: boolean;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch {
      return current;
    }
    if (!isLink) {
      try {
        return realpathSync(current);
      } catch {
        return current;
      }
    }
    current = resolve(dirname(current), readlinkSync(current));
  }
  return current;
}
