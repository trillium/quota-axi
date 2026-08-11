import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { commandExists, execFileText } from "../lib/process.js";
import { clampPercent, nowIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { failedProvider, sourceNames, withRemaining } from "./common.js";

/**
 * Big Pickle (`opencode/big-pickle`) publishes no quota API and no rate-limit
 * headers, so this is quota-axi's first locally-derived provider: it counts
 * assistant requests in the local OpenCode SQLite store and compares them to
 * empirically-measured caps. Nothing here authenticates, routes, mutates, or
 * writes — the database is opened read-only.
 *
 * The caps below are behavioral inferences from one account's request history
 * (see the empirical model summarized in CHANGELOG / model-kb notes), not a
 * provider contract. `src/interpretation.ts` treats Big Pickle windows as
 * unknown/estimated semantics so downstream advice never overclaims precision,
 * while the raw used/limit numbers are still surfaced.
 */

const SOURCE = "opencode-db";
const SQLITE_TIMEOUT_MS = 5_000;
const FIVE_HOURS_SECONDS = 5 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;

/** Observed 5h max was 703 requests with NO lockout, so this is a soft floor. */
export const FIVE_HOUR_CAP = 703;
/** Lockout-shaped stops clustered at 969-1037 in 24h, so encode a daily wall. */
export const DAILY_CAP = 1000;

export type BigPickleWindowStats = {
  /** Requests counted inside the trailing window. */
  count: number;
  /** Epoch ms of the oldest in-window request, if any. */
  oldestMs?: number;
};

export type BigPickleUsage = {
  fiveHour: BigPickleWindowStats;
  daily: BigPickleWindowStats;
};

type BigPickleDependencies = {
  resolveDbPath: () => string;
  fileExists: (path: string) => boolean;
  sqlite3Available: () => Promise<boolean>;
  readUsage: (dbPath: string, nowMs: number) => Promise<BigPickleUsage>;
  now: () => number;
};

export function createBigPickleAdapter(
  overrides: Partial<BigPickleDependencies> = {},
): ProviderAdapter {
  const dependencies: BigPickleDependencies = {
    resolveDbPath: opencodeDbPath,
    fileExists: existsSync,
    sqlite3Available: () => commandExists("sqlite3"),
    readUsage: readUsageWithSqlite3,
    now: Date.now,
    ...overrides,
  };

  return {
    id: "bigpickle",
    label: "Big Pickle",
    fetchQuota: (_options: ProviderOptions) => fetchQuota(dependencies),
    inspectAuth: (_options: ProviderOptions) => inspectAuth(dependencies),
  };
}

export const bigpickleAdapter = createBigPickleAdapter();

async function fetchQuota(
  dependencies: BigPickleDependencies,
): Promise<ProviderQuota> {
  const dbPath = dependencies.resolveDbPath();
  const attempts: SourceAttempt[] = [{ source: SOURCE, status: "failed" }];

  if (!(await dependencies.sqlite3Available())) {
    attempts[0] = {
      source: SOURCE,
      status: "skipped",
      error: "sqlite3_unavailable",
    };
    return unavailable("sqlite3_unavailable", attempts);
  }
  if (!dependencies.fileExists(dbPath)) {
    attempts[0] = {
      source: SOURCE,
      status: "skipped",
      error: "database_missing",
    };
    return unavailable("database_missing", attempts);
  }

  let usage: BigPickleUsage;
  try {
    usage = await dependencies.readUsage(dbPath, dependencies.now());
  } catch {
    attempts[0] = {
      source: SOURCE,
      status: "failed",
      error: "database_read_error",
    };
    return unavailable("database_read_error", attempts);
  }

  attempts[0] = { source: SOURCE, status: "success" };
  return {
    provider: "bigpickle",
    label: "Big Pickle",
    source: "local",
    windows: buildBigPickleWindows(usage, dependencies.now()),
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: nowIso(),
      sourcesTried: sourceNames(attempts),
    },
    attempts,
  };
}

async function inspectAuth(
  dependencies: BigPickleDependencies,
): Promise<AuthProviderReport> {
  const path = dependencies.resolveDbPath();
  const source: AuthSourceReport = (await dependencies.sqlite3Available())
    ? {
        source: SOURCE,
        path,
        status: dependencies.fileExists(path) ? "available" : "missing",
      }
    : { source: SOURCE, path, status: "skipped", error: "sqlite3_unavailable" };
  return { provider: "bigpickle", sources: [source] };
}

/**
 * Convert trailing-window request counts into the two estimated quota windows.
 * `resetsAt` is the oldest in-window request timestamp plus the window length,
 * i.e. when that window has rolled off enough for its oldest request to expire.
 */
export function buildBigPickleWindows(
  usage: BigPickleUsage,
  _nowMs: number,
): QuotaWindow[] {
  return [
    estimatedWindow(
      "five_hour",
      "5-hour",
      "session",
      usage.fiveHour,
      FIVE_HOUR_CAP,
      FIVE_HOURS_SECONDS,
    ),
    estimatedWindow(
      "daily",
      "24-hour",
      "unknown",
      usage.daily,
      DAILY_CAP,
      DAY_SECONDS,
    ),
  ];
}

function estimatedWindow(
  id: string,
  label: string,
  kind: QuotaWindow["kind"],
  stats: BigPickleWindowStats,
  cap: number,
  windowSeconds: number,
): QuotaWindow {
  const resetsAt =
    stats.oldestMs !== undefined
      ? new Date(stats.oldestMs + windowSeconds * 1_000).toISOString()
      : undefined;
  return withRemaining({
    id,
    label,
    kind,
    percentUsed: clampPercent((stats.count / cap) * 100),
    windowSeconds,
    ...(resetsAt ? { resetsAt } : {}),
  });
}

function unavailable(error: string, attempts: SourceAttempt[]): ProviderQuota {
  return failedProvider({
    provider: "bigpickle",
    label: "Big Pickle",
    status: "unavailable",
    error,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

async function readUsageWithSqlite3(
  dbPath: string,
  nowMs: number,
): Promise<BigPickleUsage> {
  const fiveHourCutoff = nowMs - FIVE_HOURS_SECONDS * 1_000;
  const dailyCutoff = nowMs - DAY_SECONDS * 1_000;
  const sql =
    "SELECT " +
    `coalesce(sum(case when time_created >= ${fiveHourCutoff} then 1 else 0 end),0), ` +
    `min(case when time_created >= ${fiveHourCutoff} then time_created end), ` +
    `coalesce(sum(case when time_created >= ${dailyCutoff} then 1 else 0 end),0), ` +
    `min(case when time_created >= ${dailyCutoff} then time_created end) ` +
    "FROM message " +
    "WHERE json_extract(data,'$.modelID')='big-pickle' " +
    "AND json_extract(data,'$.providerID')='opencode';";
  const output = await execFileText(
    "sqlite3",
    ["-readonly", "-batch", "-noheader", "-separator", "|", dbPath, sql],
    SQLITE_TIMEOUT_MS,
  );
  return parseUsageRow(output);
}

export function parseUsageRow(output: string): BigPickleUsage {
  const line = output
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  const fields = line ? line.split("|") : [];
  return {
    fiveHour: {
      count: nonnegativeInteger(fields[0]) ?? 0,
      oldestMs: nonnegativeInteger(fields[1]),
    },
    daily: {
      count: nonnegativeInteger(fields[2]) ?? 0,
      oldestMs: nonnegativeInteger(fields[3]),
    },
  };
}

function nonnegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function opencodeDbPath(): string {
  if (process.env.OPENCODE_DB) return process.env.OPENCODE_DB;
  const dataHome =
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "opencode", "opencode.db");
}
