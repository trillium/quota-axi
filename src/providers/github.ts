import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { readCachedProvider } from "../cache.js";
import { clampPercent, nowIso, retryAfterToIso } from "../lib/time.js";
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

const RATE_LIMIT_URL = "https://api.github.com/rate_limit";
const API_TIMEOUT_MS = 15_000;

type GitHubCredentials = {
  token: string;
};

type CredentialState =
  | {
      status: "available";
      credentials: GitHubCredentials;
      source: AuthSourceReport;
    }
  | { status: "missing" | "invalid"; source: AuthSourceReport };

type RateLimitResource = {
  limit: number;
  remaining: number;
  reset: number;
};

type RateLimitResponse = {
  rate_limit: RateLimitResource;
  resources?: {
    core?: RateLimitResource;
    search?: RateLimitResource;
    graphql?: RateLimitResource;
    [key: string]: RateLimitResource | undefined;
  };
};

export const githubAdapter: ProviderAdapter = {
  id: "github",
  label: "GitHub API",
  fetchQuota,
  inspectAuth,
};

function readCredentialState(): CredentialState {
  // Try env var first
  const token = process.env.GITHUB_TOKEN;
  if (token?.trim()) {
    return {
      status: "available",
      credentials: { token },
      source: {
        source: "env-var",
        path: "GITHUB_TOKEN",
        status: "available",
      },
    };
  }

  // Try gh CLI config
  const ghConfigPath = join(homedir(), ".config", "gh", "hosts.yml");
  try {
    const contents = readFileSync(ghConfigPath, "utf-8");
    const lines = contents.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (
        lines[i].includes("github.com") ||
        lines[i].includes("api.github.com")
      ) {
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const match = lines[j].match(/oauth_token:\s*(['"]?)(.+?)\1/);
          if (match) {
            return {
              status: "available",
              credentials: { token: match[2] },
              source: {
                source: "gh-config",
                path: ghConfigPath,
                status: "available",
              },
            };
          }
        }
      }
    }
  } catch {
    // Config file doesn't exist or can't be read
  }

  return {
    status: "missing",
    source: {
      source: "credentials",
      status: "missing",
    },
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

async function fetchGitHubRateLimit(
  credentials: GitHubCredentials,
): Promise<{ windows: QuotaWindow[]; refreshedAt: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(RATE_LIMIT_URL, {
      method: "GET",
      headers: {
        Authorization: `token ${credentials.token}`,
        "User-Agent": "quota-axi",
        Accept: "application/vnd.github+json",
      },
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error("GitHub API authentication failed");
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      throw new RateLimitError(
        "GitHub API rate limit exceeded",
        retryAfter ? retryAfterToIso(retryAfter) : undefined,
      );
    }

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.statusText}`);
    }

    const data = (await response.json()) as RateLimitResponse;
    const now = nowIso();

    const windows: QuotaWindow[] = [];

    // Primary rate limit (core API)
    if (data.resources?.core) {
      const core = data.resources.core;
      windows.push({
        id: "core",
        label: "Core API",
        kind: "session",
        percentUsed: clampPercent(
          ((core.limit - core.remaining) / core.limit) * 100,
        ),
        percentRemaining: clampPercent((core.remaining / core.limit) * 100),
        resetsAt: new Date(core.reset * 1000).toISOString(),
        resetText: `Resets in ${Math.ceil((core.reset * 1000 - Date.now()) / 60000)}m`,
      });
    }

    // Search API
    if (data.resources?.search) {
      const search = data.resources.search;
      windows.push({
        id: "search",
        label: "Search API",
        kind: "session",
        percentUsed: clampPercent(
          ((search.limit - search.remaining) / search.limit) * 100,
        ),
        percentRemaining: clampPercent((search.remaining / search.limit) * 100),
        resetsAt: new Date(search.reset * 1000).toISOString(),
        resetText: `Resets in ${Math.ceil((search.reset * 1000 - Date.now()) / 60000)}m`,
      });
    }

    // GraphQL API
    if (data.resources?.graphql) {
      const graphql = data.resources.graphql;
      windows.push({
        id: "graphql",
        label: "GraphQL API",
        kind: "session",
        percentUsed: clampPercent(
          ((graphql.limit - graphql.remaining) / graphql.limit) * 100,
        ),
        percentRemaining: clampPercent(
          (graphql.remaining / graphql.limit) * 100,
        ),
        resetsAt: new Date(graphql.reset * 1000).toISOString(),
        resetText: `Resets in ${Math.ceil((graphql.reset * 1000 - Date.now()) / 60000)}m`,
      });
    }

    return { windows, refreshedAt: now };
  } finally {
    clearTimeout(timeoutId);
  }
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
    attempts.push({ source: "api", status: "failed" });
    try {
      const quota = await fetchGitHubRateLimit(credentialState.credentials);
      attempts[attempts.length - 1] = { source: "api", status: "success" };
      return successProvider({
        provider: "github",
        label: "GitHub API",
        source: "api",
        windows: quota.windows,
        refreshedAt: quota.refreshedAt,
        sourcesTried: sourceNames(attempts),
        attempts,
      });
    } catch (error) {
      finalError = errorMessage(error);
      attempts[attempts.length - 1] = {
        source: "api",
        status: "failed",
        error: finalError,
      };
      if (error instanceof RateLimitError) retryAfter = error.retryAfter;
    }
  } else {
    attempts.push({
      source: "credentials",
      status: "skipped",
      error: "credentials_missing",
    });
    finalError =
      "GitHub token not found — set GITHUB_TOKEN or configure gh CLI";
  }

  const cached = readCachedProvider("github");
  if (cached) {
    return staleFromCache(cached, finalError, sourceNames(attempts), attempts);
  }

  return failedProvider({
    provider: "github",
    label: "GitHub API",
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
  return { provider: "github", sources: [credentialState.source] };
}
