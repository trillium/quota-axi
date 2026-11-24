import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { annotateQuotaAdvice } from "./advice.js";
import { readPublishableProviders } from "./cache.js";
import { withQuotaSemantics } from "./interpretation.js";
import { cacheFilePath, ensurePrivateParent, readJsonFile } from "./lib/fs.js";
import { providerFetch } from "./lib/http.js";
import { nowIso } from "./lib/time.js";
import { userConfigFilePath } from "./lib/user-config.js";
import { quotaExportReport } from "./render.js";
import type { QuotaAxiResponse } from "./types.js";

/**
 * The rule the publisher exists to keep, stated verbatim in the docs, in
 * `publish --help`, and in every `publish` and `publish --status` output.
 */
export const SINGLE_QUERIER_RULE =
  "single querier: only the machine that owns the vendor logins queries vendor quota and reset endpoints. `publish` posts that machine's cached readings to the hub and never queries a vendor; every other machine reads the hub's cached copy (a declared source) and never queries a vendor for it.";

/** Readings older than this are not published; consumers apply their own `maxAge` on top. */
export const PUBLISH_MAX_AGE_SECONDS = 86_400;
const DEFAULT_TIMEOUT_SECONDS = 5;
const MAX_TIMEOUT_SECONDS = 15;

export const PUBLISH_HELP = `usage: quota-axi publish [--to <url>] [--allow-insecure-transport] [--dry-run] [--status]
Posts this machine's cached quota readings to a hub (for example mini0's /fm_quota/<source>) so other machines read the cached copy instead of asking vendors.
${SINGLE_QUERIER_RULE}
notes:
  Publishing reads only the local quota cache (the export tier: no account identity, locators, or attempts). It never calls a provider adapter, a vendor endpoint, a credential store, or a delegated refresh, and sends no credential or authorization header. Readings whose own window reset has passed, or older than 24h, are left out. Keep the cache fresh with this machine's ordinary \`quota-axi\` reads.
  The target comes from --to, else {"publish":{"url":"https://hub.example/fm_quota/<source>"}} in ~/.config/quota-axi/config.json (or $XDG_CONFIG_HOME/quota-axi/config.json). Plain http: needs --allow-insecure-transport or "allowInsecureTransport": true. "timeout" (seconds, default 5, max 15) bounds the request.
  --dry-run builds the payload and posts nothing. --status makes no request: it prints the target, the cache the next publish would send, the last attempt, and the rule.
flags[4]:
  --to <url>, --allow-insecure-transport, --dry-run, --status
examples:
  quota-axi publish
  quota-axi publish --dry-run
  quota-axi publish --status
`;

type PublishFlags = {
  to?: string;
  allowInsecureTransport: boolean;
  dryRun: boolean;
  status: boolean;
};

type PublishConfig = {
  url?: string;
  allowInsecureTransport: boolean;
  timeout: number;
};

type PublishRecord = {
  attemptedAt: string;
  ok: boolean;
  target: string;
  providers: number;
  error?: string;
  lastSuccessAt?: string;
};

export function parsePublishFlags(args: string[]): PublishFlags {
  const flags: PublishFlags = {
    allowInsecureTransport: false,
    dryRun: false,
    status: false,
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--allow-insecure-transport") {
      flags.allowInsecureTransport = true;
    } else if (arg === "--dry-run") {
      flags.dryRun = true;
    } else if (arg === "--status") {
      flags.status = true;
    } else if (arg === "--to") {
      const value = args[++index];
      if (!value || value.startsWith("--")) {
        throw new AxiError("--to requires a URL", "VALIDATION_ERROR", [
          "Run `quota-axi publish --to https://hub.example/fm_quota/<source>`",
        ]);
      }
      flags.to = value;
    } else {
      throw new AxiError(`Unknown publish flag: ${arg}`, "VALIDATION_ERROR", [
        "Run `quota-axi publish --help`",
      ]);
    }
  }
  if (flags.status && flags.dryRun) {
    throw new AxiError(
      "--status and --dry-run are mutually exclusive",
      "VALIDATION_ERROR",
      ["--status prints state only; --dry-run builds the payload"],
    );
  }
  return flags;
}

function readPublishConfig(file: string = userConfigFilePath()): PublishConfig {
  const config = readJsonFile(file);
  const raw =
    config && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>).publish
      : undefined;
  const result: PublishConfig = {
    allowInsecureTransport: false,
    timeout: DEFAULT_TIMEOUT_SECONDS,
  };
  if (raw === undefined) return result;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AxiError(
      "publish must be an object in config.json",
      "VALIDATION_ERROR",
      ['Declare {"publish":{"url":"https://hub.example/fm_quota/<source>"}}'],
    );
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["url", "allowInsecureTransport", "timeout"].includes(key)) {
      throw new AxiError(
        `Unknown publish key in config.json: ${key}`,
        "VALIDATION_ERROR",
        ["Allowed keys: url, allowInsecureTransport, timeout"],
      );
    }
  }
  if (record.url !== undefined) {
    if (typeof record.url !== "string" || record.url === "") {
      throw new AxiError(
        "publish.url must be a non-empty string",
        "VALIDATION_ERROR",
        [],
      );
    }
    result.url = record.url;
  }
  if (record.allowInsecureTransport !== undefined) {
    if (typeof record.allowInsecureTransport !== "boolean") {
      throw new AxiError(
        "publish.allowInsecureTransport must be a boolean",
        "VALIDATION_ERROR",
        [],
      );
    }
    result.allowInsecureTransport = record.allowInsecureTransport;
  }
  if (record.timeout !== undefined) {
    if (
      typeof record.timeout !== "number" ||
      !Number.isFinite(record.timeout) ||
      record.timeout <= 0 ||
      record.timeout > MAX_TIMEOUT_SECONDS
    ) {
      throw new AxiError(
        `publish.timeout must be a number of seconds up to ${MAX_TIMEOUT_SECONDS}`,
        "VALIDATION_ERROR",
        [],
      );
    }
    result.timeout = record.timeout;
  }
  return result;
}

/**
 * The target with userinfo and query removed, so a token carried in either never
 * reaches output or the state record. Throws on an unusable URL.
 */
function checkedTarget(
  raw: string,
  allowInsecure: boolean,
): { url: URL; display: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AxiError(
      "publish target is not a valid URL",
      "VALIDATION_ERROR",
      ["Use https://hub.example/fm_quota/<source>"],
    );
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && allowInsecure)
  ) {
    throw new AxiError(
      "publish target must use https: (plain http: needs --allow-insecure-transport)",
      "VALIDATION_ERROR",
      ["Pass --allow-insecure-transport for a trusted private network hub"],
    );
  }
  const display = `${url.protocol}//${url.host}${url.pathname}`;
  // No credential or authorization header is ever sent, so userinfo is dropped
  // from the request as well as from every display.
  url.username = "";
  url.password = "";
  return { url, display };
}

function statePath(): string {
  return join(dirname(cacheFilePath()), "publish-state.json");
}

function readRecord(): PublishRecord | undefined {
  const raw = readJsonFile(statePath());
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.attemptedAt !== "string" ||
    typeof value.ok !== "boolean" ||
    typeof value.target !== "string" ||
    typeof value.providers !== "number"
  )
    return undefined;
  return {
    attemptedAt: value.attemptedAt,
    ok: value.ok,
    target: value.target,
    providers: value.providers,
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(typeof value.lastSuccessAt === "string"
      ? { lastSuccessAt: value.lastSuccessAt }
      : {}),
  };
}

function writeRecord(record: PublishRecord): void {
  try {
    const file = statePath();
    ensurePrivateParent(file);
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } catch {
    // The record is a convenience for --status; a failed write never fails a publish.
  }
}

/** The export-tier payload built from the local cache alone. */
export function buildPublishPayload(now: number = Date.now()): {
  payload: QuotaAxiResponse;
  newestRefreshedAt?: string;
} {
  const generatedAt = nowIso();
  const readings = readPublishableProviders(PUBLISH_MAX_AGE_SECONDS, now).map(
    (provider) => withQuotaSemantics(provider, generatedAt),
  );
  const payload = quotaExportReport(
    annotateQuotaAdvice({ generatedAt, providers: readings }),
  );
  const newestRefreshedAt = payload.providers
    .map((provider) => provider.state.refreshedAt ?? "")
    .filter((value) => value !== "")
    .sort()
    .at(-1);
  return { payload, ...(newestRefreshedAt ? { newestRefreshedAt } : {}) };
}

function lines(entries: Array<[string, string | number | undefined]>): string {
  return entries
    .filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined,
    )
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

export async function publishCommand(args: string[]): Promise<string> {
  const flags = parsePublishFlags(args);
  const config = readPublishConfig();
  const rawTarget = flags.to ?? config.url;
  const allowInsecure =
    flags.allowInsecureTransport || config.allowInsecureTransport;

  if (flags.status) {
    const { payload, newestRefreshedAt } = buildPublishPayload();
    const record = readRecord();
    const target = rawTarget
      ? checkedTarget(rawTarget, allowInsecure).display
      : "not configured";
    return lines([
      ["publisher", rawTarget ? "configured" : "not_configured"],
      ["target", target],
      ["cachedProviders", payload.providers.length],
      ["newestRefreshedAt", newestRefreshedAt ?? "none"],
      ["lastAttemptAt", record?.attemptedAt ?? "never"],
      [
        "lastAttempt",
        record
          ? record.ok
            ? "ok"
            : `failed ${record.error ?? ""}`.trim()
          : "none",
      ],
      ["lastSuccessAt", record?.lastSuccessAt ?? "never"],
      ["rule", SINGLE_QUERIER_RULE],
    ]);
  }

  if (!rawTarget) {
    throw new AxiError("No publish target configured", "VALIDATION_ERROR", [
      'Set {"publish":{"url":"https://hub.example/fm_quota/<source>"}} in config.json or pass --to <url>',
    ]);
  }
  const target = checkedTarget(rawTarget, allowInsecure);
  const { payload, newestRefreshedAt } = buildPublishPayload();
  const common: Array<[string, string | number | undefined]> = [
    ["target", target.display],
    ["providers", payload.providers.length],
    ["newestRefreshedAt", newestRefreshedAt],
  ];

  if (flags.dryRun) {
    return lines([
      ["publish", "dry_run"],
      ...common,
      ["posted", "no"],
      ["rule", SINGLE_QUERIER_RULE],
    ]);
  }

  const previous = readRecord();
  const attemptedAt = nowIso();
  let error: string | undefined;
  if (payload.providers.length === 0) {
    error = "cache_empty";
  } else {
    const timeoutSignal = AbortSignal.timeout(config.timeout * 1000);
    try {
      const response = await providerFetch(target.url, {
        method: "POST",
        redirect: "manual",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: timeoutSignal,
      });
      if (response.status < 200 || response.status >= 300) {
        error = `hub_http_${response.status}`;
      }
      await response.body?.cancel().catch(() => undefined);
    } catch {
      error = timeoutSignal.aborted ? "hub_timeout" : "hub_unreachable";
    }
  }
  const ok = error === undefined;
  writeRecord({
    attemptedAt,
    ok,
    target: target.display,
    providers: payload.providers.length,
    ...(error ? { error } : {}),
    ...(ok
      ? { lastSuccessAt: attemptedAt }
      : previous?.lastSuccessAt
        ? { lastSuccessAt: previous.lastSuccessAt }
        : {}),
  });
  if (!ok) process.exitCode = 1;
  return lines([
    ["publish", ok ? "posted" : "failed"],
    ...common,
    ["posted", ok ? "yes" : "no"],
    ["error", error],
    ["rule", SINGLE_QUERIER_RULE],
  ]);
}
