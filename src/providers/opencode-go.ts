import { homedir } from "node:os";
import { join } from "node:path";
import { readCachedProvider } from "../cache.js";
import { readJsonFileResult } from "../lib/fs.js";
import {
  clampPercent,
  nowIso,
  percentRemaining,
  retryAfterToIso,
} from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import {
  failedProvider,
  sourceNames,
  staleFromCache,
  statusFromError,
  successProvider,
} from "./common.js";

// ── OpenCode Go ─────────────────────────────────────────────────────────────
//
// OpenCode Go ("opencode-go") is OpenCode's hosted model gateway, fronting
// DeepSeek, GLM, Luna, Grok, Kimi, Qwen and others behind one OpenAI-
// compatible API at https://opencode.ai/zen/go/v1. Its credential lives in
// OpenCode's own auth store (default ~/.local/share/opencode/auth.json) under
// the "opencode-go" key — type "api", a single `key` bearer. The first-party
// quota endpoint is GET /usage, which returns rolling/weekly/monthly percent
// windows. This adapter is read-only: it never launches opencode, never
// writes the auth file, and never retains the key.

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const API_TIMEOUT_MS = 15_000;

const AUTH_SOURCE = "opencode-auth-json";

type OpenCodeGoCredentials = {
  key: string;
};

type CredentialState =
  | {
      status: "available";
      credentials: OpenCodeGoCredentials;
      source: AuthSourceReport;
    }
  | { status: "missing" | "invalid"; source: AuthSourceReport };

type UsageWindow = {
  status: string;
  percent: number;
  resetsAt?: string;
};

type UsageResponse = {
  usage?: {
    rolling?: UsageWindow;
    weekly?: UsageWindow;
    monthly?: UsageWindow;
  };
};

export const opencodeGoAdapter: ProviderAdapter = {
  id: "opencode-go",
  label: "OpenCode Go",
  fetchQuota,
  inspectAuth,
};

function authFilePath(): string {
  const explicit =
    process.env.OPENCODE_AUTH_JSON ?? process.env.OPENCODE_AUTH_PATH;
  if (explicit) return explicit;
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "opencode", "auth.json");
}

function readCredentialState(): CredentialState {
  const path = authFilePath();
  const raw = readJsonFileResult(path);
  if (raw.status === "missing") {
    return {
      status: "missing",
      source: { source: AUTH_SOURCE, path, status: "missing" },
    };
  }
  if (raw.status === "invalid") {
    return {
      status: "invalid",
      source: {
        source: AUTH_SOURCE,
        path,
        status: "invalid",
        error: raw.error,
      },
    };
  }
  const data =
    raw.value !== null && typeof raw.value === "object"
      ? (raw.value as Record<string, unknown>)
      : undefined;
  const entry = data?.opencodeGo ?? data?.["opencode-go"];
  const entryObj =
    entry !== null && typeof entry === "object"
      ? (entry as Record<string, unknown>)
      : undefined;
  const key = typeof entryObj?.key === "string" ? entryObj.key.trim() : "";
  if (!key) {
    return {
      status: "invalid",
      source: {
        source: AUTH_SOURCE,
        path,
        status: "invalid",
        error: "missing_key",
      },
    };
  }
  return {
    status: "available",
    credentials: { key },
    source: { source: AUTH_SOURCE, path, status: "available" },
  };
}

class RateLimitError extends Error {
  retryAfter?: string;
  constructor(message: string, retryAfter?: string) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

async function fetchUsage(
  credentials: OpenCodeGoCredentials,
): Promise<{ windows: QuotaWindow[]; refreshedAt: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credentials.key}`,
        Accept: "application/json",
        "User-Agent": "quota-axi",
      },
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error("OpenCode Go authentication failed");
    }
    if (response.status === 429) {
      throw new RateLimitError(
        "OpenCode Go usage endpoint rate limited",
        retryAfterToIso(response.headers.get("retry-after")),
      );
    }
    if (!response.ok) {
      throw new Error(`OpenCode Go error: ${response.statusText}`);
    }

    const data = (await response.json()) as UsageResponse;
    const now = nowIso();
    const windows = normalizeUsageWindows(data);
    return { windows, refreshedAt: now };
  } finally {
    clearTimeout(timeoutId);
  }
}

export function normalizeUsageWindows(data: UsageResponse): QuotaWindow[] {
  const usage = data.usage;
  if (!usage) return [];
  const windows: QuotaWindow[] = [];

  const defs: Array<
    [
      keyof NonNullable<UsageResponse["usage"]>,
      string,
      QuotaWindow["kind"],
      string,
    ]
  > = [
    ["rolling", "rolling", "session", "rolling"],
    ["weekly", "week", "weekly", "weekly"],
    ["monthly", "month", "monthly", "monthly"],
  ];
  for (const [key, label, kind, id] of defs) {
    const window = usage[key];
    if (!window || typeof window.percent !== "number") continue;
    const percent = clampPercent(window.percent);
    windows.push({
      id,
      label,
      kind,
      percentUsed: percent,
      percentRemaining: percentRemaining(percent)!,
      ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
    });
  }
  return windows;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function fetchQuota(
  _options: ProviderOptions,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let finalError: string;
  let retryAfter: string | undefined;

  const credentialState = readCredentialState();
  if (credentialState.status === "available") {
    attempts.push({ source: AUTH_SOURCE, status: "failed" });
    try {
      const quota = await fetchUsage(credentialState.credentials);
      attempts[attempts.length - 1] = {
        source: AUTH_SOURCE,
        status: "success",
      };
      return successProvider({
        provider: "opencode-go",
        label: "OpenCode Go",
        source: "api",
        windows: quota.windows,
        refreshedAt: quota.refreshedAt,
        sourcesTried: sourceNames(attempts),
        attempts,
      });
    } catch (error) {
      finalError = errorMessage(error);
      attempts[attempts.length - 1] = {
        source: AUTH_SOURCE,
        status: "failed",
        error: finalError,
      };
      if (error instanceof RateLimitError) retryAfter = error.retryAfter;
    }
  } else {
    attempts.push({
      source: AUTH_SOURCE,
      status: "skipped",
      error:
        credentialState.status === "missing"
          ? "credentials_missing"
          : (credentialState.source.error ?? "credentials_invalid"),
    });
    finalError =
      credentialState.status === "missing"
        ? "OpenCode Go key not found — sign in to OpenCode (`opencode auth login`)"
        : "OpenCode Go credential invalid";
  }

  const cached = readCachedProvider("opencode-go");
  if (cached) {
    return staleFromCache(cached, finalError, sourceNames(attempts), attempts);
  }

  return failedProvider({
    provider: "opencode-go",
    label: "OpenCode Go",
    status: retryAfter ? "rate_limited" : statusFromError(finalError),
    error: finalError,
    retryAfter,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

export async function inspectAuth(
  _options: ProviderOptions,
): Promise<AuthProviderReport> {
  const credentialState = readCredentialState();
  return { provider: "opencode-go", sources: [credentialState.source] };
}
