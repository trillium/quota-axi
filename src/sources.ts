import { readFileSync, statSync } from "node:fs";
import { normalizeCachedWindow, stampSubscriptionIdentity } from "./cache.js";
import {
  PROVIDER_RESPONSE_LIMIT_BYTES,
  providerFetch,
  readBoundedResponseBody,
} from "./lib/http.js";
import {
  type QuotaSourceDeclaration,
  type QuotaSourceSupplies,
  readQuotaSources,
  readSharedFirst,
} from "./lib/user-config.js";
import {
  servableStaleWindows,
  servableUntrustedWindowIds,
} from "./providers/common.js";
import { PROVIDERS } from "./providers/index.js";
import {
  PROVIDER_STATUSES,
  type ProviderId,
  type ProviderQuota,
  type ProviderStatus,
  type QuotaAxiResponse,
  type QuotaWindow,
} from "./types.js";

export class SourceReadError extends Error {
  readonly code: string;
  readonly detail?: string;

  constructor(code: string, detail?: string) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

export type SourceReportResult =
  | {
      status: "success";
      report: QuotaAxiResponse;
    }
  | {
      status: "failure";
      error: string;
      detail?: string;
    };

/**
 * Read and validate a declared custom quota source body.
 */
export async function readSource(
  source: QuotaSourceDeclaration,
  signal?: AbortSignal,
): Promise<SourceReportResult> {
  if (source.file) {
    return readBoundedFile(source.file, signal);
  }
  return readUrlSource(source, signal);
}

function readBoundedFile(
  path: string,
  signal?: AbortSignal,
): SourceReportResult {
  if (signal?.aborted) {
    return { status: "failure", error: "source_timeout" };
  }
  try {
    const stat = statSync(path);
    if (stat.size > PROVIDER_RESPONSE_LIMIT_BYTES) {
      return { status: "failure", error: "source_response_too_large" };
    }
    const text = readFileSync(path, "utf8");
    if (Buffer.byteLength(text) > PROVIDER_RESPONSE_LIMIT_BYTES) {
      return { status: "failure", error: "source_response_too_large" };
    }
    return parseSourceReport(text);
  } catch {
    if (signal?.aborted) {
      return { status: "failure", error: "source_timeout" };
    }
    return { status: "failure", error: "source_unreachable" };
  }
}

async function readUrlSource(
  source: QuotaSourceDeclaration,
  signal?: AbortSignal,
): Promise<SourceReportResult> {
  const timeoutSignal = AbortSignal.timeout(source.timeout * 1000);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  try {
    const res = await providerFetch(source.url!, {
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: combinedSignal,
    });
    if (res.status >= 300 || res.type === "opaqueredirect") {
      return {
        status: "failure",
        error: "source_http_error",
        detail: String(res.status),
      };
    }
    const bytes = await readBoundedResponseBody(res, combinedSignal, (code) => {
      if (code === "response_too_large")
        return new SourceReadError("source_response_too_large");
      if (code === "provider_timeout")
        return new SourceReadError("source_timeout");
      return new SourceReadError("source_malformed");
    });
    return parseSourceReport(bytes);
  } catch (error) {
    if (error instanceof SourceReadError) {
      return { status: "failure", error: error.code, detail: error.detail };
    }
    if (
      (error instanceof Error && error.name === "TimeoutError") ||
      combinedSignal.aborted
    ) {
      return { status: "failure", error: "source_timeout" };
    }
    return { status: "failure", error: "source_unreachable" };
  }
}

/**
 * Validate the decoded source report JSON.
 */
export function parseSourceReport(
  bytes: Uint8Array | string,
): SourceReportResult {
  let text: string;
  if (typeof bytes === "string") {
    text = bytes;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { status: "failure", error: "source_malformed" };
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "failure", error: "source_malformed" };
  }
  if (!isRecord(parsed)) {
    return { status: "failure", error: "source_malformed" };
  }
  const schemaVersion = parsed.schemaVersion;
  if (schemaVersion !== 5 && schemaVersion !== 6) {
    return { status: "failure", error: "source_unsupported_schema" };
  }
  if (
    typeof parsed.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.generatedAt))
  ) {
    return { status: "failure", error: "source_malformed" };
  }
  if (!Array.isArray(parsed.providers)) {
    return { status: "failure", error: "source_malformed" };
  }
  return {
    status: "success",
    report: parsed as QuotaAxiResponse,
  };
}

/**
 * Maps each supplies entry of a declared source to a ProviderQuota lane.
 */
export function sourceLanes(
  source: QuotaSourceDeclaration,
  result: SourceReportResult,
  now: number,
): ProviderQuota[] {
  const lanes: ProviderQuota[] = [];

  for (const entry of source.supplies) {
    const laneKey = `source:${source.name}:${entry.accountKey}`;
    const label = PROVIDERS[entry.provider]?.label ?? entry.provider;

    if (result.status === "failure") {
      lanes.push(
        failedLane(
          entry.provider,
          laneKey,
          label,
          source.name,
          "unavailable",
          result.error,
          result.detail,
        ),
      );
      continue;
    }

    const { report } = result;
    const matches = report.providers.filter(
      (p) =>
        p.provider === entry.provider &&
        (p.accountKey === entry.accountKey ||
          (p.accountKey === undefined && entry.accountKey === "default") ||
          (Array.isArray(p.accountKeys) &&
            p.accountKeys.includes(entry.accountKey))),
    );

    if (matches.length === 0) {
      lanes.push(
        failedLane(
          entry.provider,
          laneKey,
          label,
          source.name,
          "unavailable",
          "source_missing_account",
        ),
      );
      continue;
    }

    if (matches.length > 1) {
      lanes.push(
        failedLane(
          entry.provider,
          laneKey,
          label,
          source.name,
          "unavailable",
          "source_malformed",
        ),
      );
      continue;
    }

    const row = matches[0];
    if (
      !isRecord(row) ||
      !isRecord(row.state) ||
      typeof row.state.status !== "string" ||
      !PROVIDER_STATUSES.includes(row.state.status as ProviderStatus) ||
      typeof row.state.stale !== "boolean"
    ) {
      lanes.push(
        failedLane(
          entry.provider,
          laneKey,
          label,
          source.name,
          "unavailable",
          "source_malformed",
        ),
      );
      continue;
    }

    const rawRefreshedAt =
      typeof row.state.refreshedAt === "string"
        ? row.state.refreshedAt
        : report.generatedAt;
    const refreshedAtMs = Date.parse(rawRefreshedAt);
    if (!Number.isFinite(refreshedAtMs)) {
      lanes.push(
        failedLane(
          entry.provider,
          laneKey,
          label,
          source.name,
          "unavailable",
          "source_malformed",
        ),
      );
      continue;
    }

    if (refreshedAtMs > now + 60_000) {
      lanes.push(
        failedLane(
          entry.provider,
          laneKey,
          label,
          source.name,
          "unavailable",
          "source_clock_ahead",
        ),
      );
      continue;
    }

    if (entry.subscription !== undefined) {
      if (typeof row.subscription !== "string" || !row.subscription) {
        lanes.push(
          failedLane(
            entry.provider,
            laneKey,
            label,
            source.name,
            "unavailable",
            "source_account_unverified",
          ),
        );
        continue;
      }
      if (row.subscription !== entry.subscription) {
        lanes.push(
          failedLane(
            entry.provider,
            laneKey,
            label,
            source.name,
            "unavailable",
            "source_account_mismatch",
          ),
        );
        continue;
      }
    }

    const status = row.state.status as ProviderStatus;
    if (
      status === "auth_required" ||
      status === "rate_limited" ||
      status === "error" ||
      status === "unavailable"
    ) {
      lanes.push(
        failedLane(
          entry.provider,
          laneKey,
          label,
          source.name,
          "unavailable",
          `source_provider_${status}`,
          row.state.error,
        ),
      );
      continue;
    }

    if (!Array.isArray(row.windows)) {
      lanes.push(
        failedLane(
          entry.provider,
          laneKey,
          label,
          source.name,
          "unavailable",
          "source_malformed",
        ),
      );
      continue;
    }

    const normalizedWindows: QuotaWindow[] = [];
    let windowsMalformed = false;
    for (const w of row.windows) {
      const normalized = normalizeCachedWindow(w);
      if (!normalized) {
        windowsMalformed = true;
        break;
      }
      normalizedWindows.push(normalized);
    }
    if (windowsMalformed) {
      lanes.push(
        failedLane(
          entry.provider,
          laneKey,
          label,
          source.name,
          "unavailable",
          "source_malformed",
        ),
      );
      continue;
    }

    const isProducerStale = row.state.stale === true || status === "stale";
    const ageMs = now - refreshedAtMs;
    const isTooOld = ageMs > source.maxAge * 1000;

    if (isProducerStale || isTooOld) {
      const candidate: ProviderQuota = {
        ...row,
        provider: entry.provider,
        accountKey: laneKey,
        accountKeys: [laneKey],
        label,
        source: "remote",
        windows: normalizedWindows,
        state: {
          ...row.state,
          status: "stale",
          stale: true,
          refreshedAt: rawRefreshedAt,
        },
      };
      const servable = servableStaleWindows(candidate, now);
      const untrusted = servableUntrustedWindowIds(candidate, servable);

      lanes.push({
        provider: entry.provider,
        accountKey: laneKey,
        accountKeys: [laneKey],
        label,
        source: "remote",
        windows: servable,
        ...(row.plan ? { plan: row.plan } : {}),
        ...(row.credits ? { credits: row.credits } : {}),
        ...(row.jobs ? { jobs: row.jobs } : {}),
        ...(row.subscription ? { subscription: row.subscription } : {}),
        state: {
          status: "stale",
          stale: true,
          error: isTooOld ? "source_reading_too_old" : "source_stale",
          refreshedAt: rawRefreshedAt,
          sourcesTried: [`source:${source.name}`],
          importedFrom: source.name,
          ...(untrusted ? { untrustedWindowIds: untrusted } : {}),
        },
      });
      continue;
    }

    const survivingWindows = normalizedWindows.filter(
      (w) => !w.resetsAt || Date.parse(w.resetsAt) > now,
    );
    if (survivingWindows.length === 0) {
      lanes.push(
        failedLane(
          entry.provider,
          laneKey,
          label,
          source.name,
          "unavailable",
          "source_expired",
        ),
      );
      continue;
    }

    lanes.push({
      provider: entry.provider,
      accountKey: laneKey,
      accountKeys: [laneKey],
      label,
      source: "remote",
      windows: survivingWindows,
      ...(row.plan ? { plan: row.plan } : {}),
      ...(row.credits ? { credits: row.credits } : {}),
      ...(row.jobs ? { jobs: row.jobs } : {}),
      ...(row.subscription ? { subscription: row.subscription } : {}),
      state: {
        status: "fresh",
        stale: false,
        refreshedAt: rawRefreshedAt,
        sourcesTried: [`source:${source.name}`],
        importedFrom: source.name,
      },
    });
  }

  return lanes;
}

function sourceLaneEntries(
  source: QuotaSourceDeclaration,
  result: SourceReportResult,
  now: number,
): SourceLane[] {
  // `sourceLanes` yields exactly one lane per `supplies` entry, in order.
  return sourceLanes(source, result, now).map((lane, index) => ({
    lane,
    source,
    entry: source.supplies[index],
  }));
}

function failedLane(
  provider: ProviderId,
  accountKey: string,
  label: string,
  sourceName: string,
  status: ProviderStatus,
  error: string,
  errorDetail?: string,
): ProviderQuota {
  return {
    provider,
    accountKey,
    accountKeys: [accountKey],
    label,
    source: "remote",
    windows: [],
    state: {
      status,
      stale: false,
      error,
      sourcesTried: [`source:${sourceName}`],
      importedFrom: sourceName,
      ...(errorDetail ? { errorDetail } : {}),
    },
  };
}

/** One declared `supplies` entry's lane, with the declaration that produced it. */
type SourceLane = {
  lane: ProviderQuota;
  source: QuotaSourceDeclaration;
  entry: QuotaSourceSupplies;
};

/**
 * What a local lane knows about itself when it asks whether a source can stand
 * in for it: its `accountKey` as discovered (`default` for the single selected
 * lane), and, lazily, the hashed subscription its own last local read verified.
 */
export type SharedLaneQuery = {
  provider: ProviderId;
  laneKey: string;
  identity(): string | undefined;
};

/**
 * Declared sources read in parallel with local discovery. Source lanes a local
 * lane claims are the local lane's reading from then on, so a claimed lane is
 * not also reported as its own `source:` row.
 */
export type DeclaredSources = {
  /**
   * The fresh reading of a declared source that stands in for this local lane,
   * or `undefined` when none does and the lane must be read locally. Matches
   * are explicit only: the entry's `standsFor` names this lane, or the entry
   * names none and the source's verified `subscription` equals the one the
   * lane's own last local read stamped. Email, label, and position never match.
   * A missing, failed, stale, or too-old reading never matches.
   */
  claim(query: SharedLaneQuery): Promise<ProviderQuota | undefined>;
  /** Every source lane no local lane claimed. */
  unclaimed(): Promise<ProviderQuota[]>;
};

/**
 * Start reading all declared sources that supply any of the in-scope providers.
 * Reads begin at once; a local lane waits for them only when a declared entry
 * could stand in for it. `share: false` disables claims, not the source rows.
 */
export function startDeclaredSources(
  providers: ProviderId[],
  explicitProviders = false,
  options?: {
    signal?: AbortSignal;
    file?: string;
    now?: number;
    share?: boolean;
  },
): DeclaredSources {
  const sources = readQuotaSources(options?.file, providers, explicitProviders);
  if (sources.length === 0) {
    return { claim: async () => undefined, unclaimed: async () => [] };
  }
  const sharing = options?.share !== false && readSharedFirst(options?.file);

  const now = options?.now ?? Date.now();
  const read: Promise<SourceLane[]> = Promise.all(
    sources.map(async (source) => {
      const result = await readSource(source, options?.signal);
      return sourceLaneEntries(source, result, now);
    }),
  ).then((groups) =>
    groups.flat().filter(({ lane }) => providers.includes(lane.provider)),
  );
  const claimed = new Set<SourceLane>();

  return {
    async claim(query) {
      if (!sharing) return undefined;
      const candidates = sources
        .filter((source) => source.share !== false)
        .flatMap((source) => source.supplies)
        .filter((entry) => entry.provider === query.provider);
      const explicit = candidates.some(
        (entry) => entry.standsFor === query.laneKey,
      );
      const bySubscription = candidates.some(
        (entry) => entry.standsFor === undefined,
      );
      if (!explicit && !bySubscription) return undefined;
      const identity = query.identity();
      if (!explicit && identity === undefined) return undefined;

      let lanes: SourceLane[];
      try {
        lanes = await read;
      } catch {
        return undefined;
      }
      const hit = lanes.find(
        (candidate) =>
          !claimed.has(candidate) &&
          candidate.source.share !== false &&
          candidate.entry.provider === query.provider &&
          isShareable(candidate.lane) &&
          (explicit
            ? candidate.entry.standsFor === query.laneKey &&
              // A declared stand-in is still refused when both sides verify
              // different subscriptions, so a mistyped `standsFor` cannot
              // swap one account's numbers for another's.
              (identity === undefined ||
                candidate.lane.subscription === undefined ||
                candidate.lane.subscription === identity)
            : candidate.entry.standsFor === undefined &&
              candidate.lane.subscription === identity),
      );
      if (!hit) return undefined;
      claimed.add(hit);
      return servedLane(hit, explicit ? undefined : identity);
    },
    async unclaimed() {
      try {
        return (await read)
          .filter((candidate) => !claimed.has(candidate))
          .map(({ lane }) => lane);
      } catch {
        return [];
      }
    },
  };
}

/** A reading a local lane may stand on: fresh, within `maxAge`, with windows. */
function isShareable(lane: ProviderQuota): boolean {
  return (
    lane.state.status === "fresh" &&
    !lane.state.stale &&
    lane.state.importedFrom !== undefined &&
    lane.windows.length > 0
  );
}

/**
 * The source's reading as the local lane's own: it names no key of its own (the
 * collector stamps the lane's), keeps `importedFrom` so it is never cached or
 * exported as local, and says which source served it.
 */
function servedLane(
  hit: SourceLane,
  identity: string | undefined,
): ProviderQuota {
  const served: ProviderQuota = {
    ...hit.lane,
    state: { ...hit.lane.state, sharedFrom: hit.source.name },
  };
  delete served.accountKey;
  delete served.accountKeys;
  if (identity !== undefined) stampSubscriptionIdentity(served, identity);
  return served;
}

/**
 * Read all declared sources that supply any of the in-scope providers in parallel.
 */
export async function readDeclaredSources(
  providers: ProviderId[],
  explicitProviders = false,
  options?: {
    signal?: AbortSignal;
    file?: string;
    now?: number;
  },
): Promise<ProviderQuota[]> {
  return startDeclaredSources(providers, explicitProviders, {
    ...options,
    share: false,
  }).unclaimed();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
