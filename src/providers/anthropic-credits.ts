import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFileResult } from "../lib/fs.js";
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
 * Anthropic API prepaid/promotional credits (the Console "Credit balance"
 * page). Anthropic documents no balance endpoint (the Admin API exposes usage
 * and cost reports only), so quota-axi reads grants the operator declared in
 * its local config file. The values are declared, not measured: output carries
 * the as-of date and a stale flag instead of pretending to be live. These
 * credits pay for API/Agent SDK usage, never Claude subscription sessions, so
 * this is a separate provider from `claude`.
 *
 * Config (`$QUOTA_AXI_CONFIG`, else `$XDG_CONFIG_HOME/quota-axi/config.json`,
 * else `~/.config/quota-axi/config.json`):
 *
 *   { "credits": { "asOf": "2026-11-02", "grants": [
 *     { "remainingUsd": 75.43, "totalUsd": 100, "expiresAt": "2026-11-11",
 *       "grantedAt": "2026-10-18", "appliesTo": ["API", "Agent SDK"] } ] } }
 */

const SOURCE = "config:credits";
export const DECLARED_STALE_AFTER_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1_000;

export type DeclaredGrant = {
  remainingUsd: number;
  totalUsd: number;
  expiresAt: string;
  grantedAt?: string;
  appliesTo: string[];
};

export type DeclaredCredits = {
  asOf: string;
  grants: DeclaredGrant[];
};

type CreditsDependencies = {
  configPath: () => string;
  now: () => number;
};

export function createAnthropicCreditsAdapter(
  overrides: Partial<CreditsDependencies> = {},
): ProviderAdapter {
  const dependencies: CreditsDependencies = {
    configPath: quotaAxiConfigPath,
    now: Date.now,
    ...overrides,
  };
  return {
    id: "anthropic_api",
    label: "Anthropic API credits",
    fetchQuota: async (_options: ProviderOptions) => fetchQuota(dependencies),
    inspectAuth: async (_options: ProviderOptions) => inspectAuth(dependencies),
  };
}

export const anthropicCreditsAdapter = createAnthropicCreditsAdapter();

function fetchQuota(dependencies: CreditsDependencies): ProviderQuota {
  const attempts: SourceAttempt[] = [{ source: SOURCE, status: "failed" }];
  const read = readJsonFileResult(dependencies.configPath());
  if (read.status === "missing") {
    attempts[0] = {
      source: SOURCE,
      status: "skipped",
      error: "config_missing",
    };
    return unavailable("credits_not_declared", attempts);
  }
  if (read.status === "invalid") {
    attempts[0] = { source: SOURCE, status: "failed", error: read.error };
    return unavailable("config_invalid", attempts);
  }
  const declared = parseDeclaredCredits(read.value);
  if (!declared) {
    const entry = (read.value as { credits?: unknown } | null)?.credits;
    attempts[0] = {
      source: SOURCE,
      status: entry === undefined ? "skipped" : "failed",
      error: entry === undefined ? "credits_missing" : "credits_invalid",
    };
    return unavailable(
      entry === undefined ? "credits_not_declared" : "credits_invalid",
      attempts,
    );
  }

  attempts[0] = { source: SOURCE, status: "success" };
  const nowMs = dependencies.now();
  const asOfMs = Date.parse(declared.asOf);
  const ageDays = Math.max(0, Math.floor((nowMs - asOfMs) / DAY_MS));
  const stale = nowMs - asOfMs > DECLARED_STALE_AFTER_DAYS * DAY_MS;
  const windows = buildCreditWindows(declared.grants, nowMs);
  const remaining = windows.reduce(
    (sum, window) => sum + (window.limitUsd ?? 0) - (window.spentUsd ?? 0),
    0,
  );
  return {
    provider: "anthropic_api",
    label: "Anthropic API credits",
    source: "local",
    windows,
    credits: { remaining: roundCents(remaining), unit: "usd" },
    declared: {
      basis: "declared",
      asOf: declared.asOf,
      ageDays,
      stale,
      staleAfterDays: DECLARED_STALE_AFTER_DAYS,
    },
    state: {
      status: stale ? "stale" : "fresh",
      stale,
      refreshedAt: nowIso(),
      ...(stale ? { error: "declared_value_stale" } : {}),
      sourcesTried: sourceNames(attempts),
    },
    attempts,
  };
}

function inspectAuth(dependencies: CreditsDependencies): AuthProviderReport {
  const path = dependencies.configPath();
  const read = readJsonFileResult(path);
  const source: AuthSourceReport =
    read.status === "missing"
      ? { source: SOURCE, path, status: "missing" }
      : read.status === "invalid"
        ? { source: SOURCE, path, status: "invalid", error: read.error }
        : {
            source: SOURCE,
            path,
            status: parseDeclaredCredits(read.value) ? "available" : "missing",
          };
  return { provider: "anthropic_api", sources: [source] };
}

/**
 * One window per unexpired grant, soonest expiry first. A grant at or past its
 * expiry drops out. `resetsAt` is the expiry: the unspent balance is lost
 * there rather than renewed.
 */
export function buildCreditWindows(
  grants: DeclaredGrant[],
  nowMs: number,
): QuotaWindow[] {
  return grants
    .filter((grant) => Date.parse(grant.expiresAt) > nowMs)
    .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))
    .map((grant) => {
      const spent = roundCents(grant.totalUsd - grant.remainingUsd);
      const expiresAt = new Date(Date.parse(grant.expiresAt)).toISOString();
      return {
        ...withRemaining({
          id: `grant:${expiresAt.slice(0, 10)}`,
          label: `$${grant.remainingUsd.toFixed(2)}`,
          kind: "credits",
          percentUsed: clampPercent((spent / grant.totalUsd) * 100),
          ...(grant.grantedAt
            ? { startsAt: new Date(Date.parse(grant.grantedAt)).toISOString() }
            : {}),
          resetsAt: expiresAt,
          spentUsd: spent,
          limitUsd: grant.totalUsd,
        }),
        appliesTo: grant.appliesTo,
      };
    });
}

export function parseDeclaredCredits(
  value: unknown,
): DeclaredCredits | undefined {
  const credits = objectValue(objectValue(value)?.credits);
  if (!credits) return undefined;
  const asOf = dateValue(credits.asOf);
  if (!asOf || !Array.isArray(credits.grants)) return undefined;
  const grants: DeclaredGrant[] = [];
  for (const raw of credits.grants) {
    const grant = objectValue(raw);
    const remainingUsd = moneyValue(grant?.remainingUsd);
    const totalUsd = moneyValue(grant?.totalUsd);
    const expiresAt = dateValue(grant?.expiresAt);
    if (
      !grant ||
      remainingUsd === undefined ||
      totalUsd === undefined ||
      totalUsd <= 0 ||
      remainingUsd > totalUsd ||
      !expiresAt
    )
      return undefined;
    const grantedAt = dateValue(grant.grantedAt);
    grants.push({
      remainingUsd,
      totalUsd,
      expiresAt,
      ...(grantedAt ? { grantedAt } : {}),
      appliesTo: stringArray(grant.appliesTo),
    });
  }
  return { asOf, grants };
}

function unavailable(error: string, attempts: SourceAttempt[]): ProviderQuota {
  return failedProvider({
    provider: "anthropic_api",
    label: "Anthropic API credits",
    status: "unavailable",
    error,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

export function quotaAxiConfigPath(): string {
  if (process.env.QUOTA_AXI_CONFIG) return process.env.QUOTA_AXI_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "quota-axi", "config.json");
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function moneyValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** Accepts `YYYY-MM-DD` (UTC midnight) or a full ISO timestamp. */
function dateValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
