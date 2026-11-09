import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { AxiError } from "axi-sdk-js";
import type { TuiShow } from "../tui.js";
import { PROVIDER_IDS, type ProviderId } from "../types.js";
import { readJsonFile } from "./fs.js";

/**
 * The user-level quota-axi configuration file:
 * `$XDG_CONFIG_HOME/quota-axi/config.json`, or `~/.config/quota-axi/config.json`
 * when `XDG_CONFIG_HOME` is unset. It holds human display preferences and
 * declared custom quota sources.
 */
export function userConfigFilePath(
  environment: Record<string, string | undefined> = process.env,
): string {
  const base = environment.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "quota-axi", "config.json");
}

/**
 * The `--tui` direction preference, `tui.show` in the user config file. Only
 * the exact values `used` and `remaining` are recognized; an absent,
 * unreadable, or malformed file, and any other value, keep the default
 * remaining view.
 */
export function readTuiShowPreference(
  file: string = userConfigFilePath(),
): TuiShow {
  const config = readJsonFile(file);
  const tui = isRecord(config) ? config.tui : undefined;
  const show = isRecord(tui) ? tui.show : undefined;
  return show === "used" ? "used" : "remaining";
}

/** Resolves a lane to the label its card shows. */
export type TuiAccountLabels = (lane: {
  accountKey?: string;
  accountLocator?: { path: string };
}) => string | undefined;

/**
 * The `--tui` lane names, `tui.accountLabels` in the user config file: an
 * object from a lane's locator path (absolute, or `~/`-relative) or its
 * account key to the name its card shows. Paths are compared after `~`
 * expansion and symlink resolution, so a trailing slash or a linked directory
 * names the same lane; any other entry is matched exactly against the lane's
 * account key, so a relative path names nothing. An absent, unreadable, or
 * malformed file or setting names nothing; a non-string or blank label skips
 * only that entry.
 */
export function readTuiAccountLabels(
  file: string = userConfigFilePath(),
): TuiAccountLabels {
  const config = readJsonFile(file);
  const tui = isRecord(config) ? config.tui : undefined;
  const entries = isRecord(tui) ? tui.accountLabels : undefined;
  const paths = new Map<string, string>();
  const accountKeys = new Map<string, string>();
  if (isRecord(entries)) {
    for (const [entry, label] of Object.entries(entries)) {
      if (typeof label !== "string" || !label.trim()) continue;
      const expanded = expandHome(entry);
      if (isAbsolute(expanded))
        paths.set(canonicalPath(expanded), label.trim());
      else accountKeys.set(entry, label.trim());
    }
  }
  return ({ accountKey, accountLocator }) =>
    (accountKey && accountKeys.get(accountKey)) ||
    (accountLocator && paths.size > 0
      ? paths.get(canonicalPath(accountLocator.path))
      : undefined);
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type QuotaSourceSupplies = {
  provider: ProviderId;
  accountKey: string;
  subscription?: string;
  /**
   * The local lane (`accountKey` as discovered; `default` for the single
   * selected lane) this entry stands for. While the source's reading is fresh,
   * that lane is served from it instead of asking its vendor.
   */
  standsFor?: string;
};

export type QuotaSourceDeclaration = {
  name: string;
  url?: string;
  file?: string;
  allowInsecureTransport?: boolean;
  supplies: QuotaSourceSupplies[];
  maxAge: number;
  timeout: number;
  /** Present only as `false`: this source never stands in for a local read. */
  share?: false;
};

const ALLOWED_SOURCE_KEYS = new Set([
  "name",
  "url",
  "file",
  "allowInsecureTransport",
  "supplies",
  "maxAge",
  "timeout",
  "share",
]);

const ALLOWED_SUPPLIES_KEYS = new Set([
  "provider",
  "accountKey",
  "subscription",
  "standsFor",
]);

/**
 * Strict parser for declared custom quota sources in the user config file.
 * Throws VALIDATION_ERROR when any malformed declaration exists for a
 * provider that is in scope for this invocation.
 */
export function readQuotaSources(
  file: string = userConfigFilePath(),
  inScopeProviders?: readonly ProviderId[],
  explicitProviders = false,
): QuotaSourceDeclaration[] {
  const config = readJsonFile(file);
  if (!isRecord(config) || config.sources === undefined) return [];
  if (!Array.isArray(config.sources)) {
    throw new AxiError(
      "sources must be an array in config.json",
      "VALIDATION_ERROR",
      ["Declare sources as an array of source objects"],
    );
  }

  // Determine which raw sources are in scope
  const inScope = config.sources.filter((raw) => {
    if (!explicitProviders || inScopeProviders === undefined) return true;
    const supplies = rawSuppliesList(raw);
    return supplies.some(
      (entry) =>
        entry.provider !== undefined &&
        inScopeProviders.includes(entry.provider as ProviderId),
    );
  });

  const validated: QuotaSourceDeclaration[] = [];
  const seenNames = new Set<string>();
  const seenPairs = new Set<string>();
  const seenStandsFor = new Set<string>();

  for (const raw of inScope) {
    if (!isRecord(raw)) {
      throw new AxiError(
        "source declaration must be an object",
        "VALIDATION_ERROR",
        ["Declare each source as a JSON object"],
      );
    }

    for (const key of Object.keys(raw)) {
      if (!ALLOWED_SOURCE_KEYS.has(key)) {
        throw new AxiError(
          `unknown key in source declaration: ${key}`,
          "VALIDATION_ERROR",
          ["Remove unknown keys from source declaration"],
        );
      }
    }

    if (
      typeof raw.name !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,31}$/.test(raw.name)
    ) {
      throw new AxiError(
        `invalid source name: ${String(raw.name)}`,
        "VALIDATION_ERROR",
        ["Source name must match ^[a-z0-9][a-z0-9-]{0,31}$"],
      );
    }
    const name = raw.name;

    if (seenNames.has(name)) {
      throw new AxiError(`duplicate source name: ${name}`, "VALIDATION_ERROR", [
        "Source names must be unique across sources",
      ]);
    }
    seenNames.add(name);

    const hasUrl = raw.url !== undefined;
    const hasFile = raw.file !== undefined;
    if (hasUrl && hasFile) {
      throw new AxiError(
        `source ${name} declares both url and file`,
        "VALIDATION_ERROR",
        ["Declare exactly one of url or file"],
      );
    }
    if (!hasUrl && !hasFile) {
      throw new AxiError(
        `source ${name} declares neither url nor file`,
        "VALIDATION_ERROR",
        ["Declare exactly one of url or file"],
      );
    }

    let url: string | undefined;
    let filePath: string | undefined;
    let allowInsecureTransport: boolean | undefined;

    if (raw.allowInsecureTransport !== undefined) {
      if (typeof raw.allowInsecureTransport !== "boolean") {
        throw new AxiError(
          `source ${name} allowInsecureTransport must be a boolean`,
          "VALIDATION_ERROR",
        );
      }
      allowInsecureTransport = raw.allowInsecureTransport;
    }

    if (hasFile) {
      if (typeof raw.file !== "string" || !raw.file.trim()) {
        throw new AxiError(
          `source ${name} file must be a non-empty string`,
          "VALIDATION_ERROR",
        );
      }
      const trimmedFile = raw.file.trim();
      if (!trimmedFile.startsWith("/") && !trimmedFile.startsWith("~/")) {
        throw new AxiError(
          `source ${name} file path must be absolute or ~/-relative: ${trimmedFile}`,
          "VALIDATION_ERROR",
          ["Provide an absolute path or ~/-relative path"],
        );
      }
      filePath = expandHome(trimmedFile);
    }

    if (hasUrl) {
      if (typeof raw.url !== "string" || !raw.url.trim()) {
        throw new AxiError(
          `source ${name} url must be a non-empty string`,
          "VALIDATION_ERROR",
        );
      }
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(raw.url.trim());
      } catch {
        throw new AxiError(
          `source ${name} url is invalid: ${raw.url}`,
          "VALIDATION_ERROR",
        );
      }
      if (parsedUrl.protocol === "http:") {
        if (allowInsecureTransport !== true) {
          throw new AxiError(
            `source ${name} uses http without allowInsecureTransport: true`,
            "VALIDATION_ERROR",
            ["Set allowInsecureTransport: true to permit unencrypted http"],
          );
        }
      } else if (parsedUrl.protocol !== "https:") {
        throw new AxiError(
          `source ${name} url scheme must be https: or http: with allowInsecureTransport`,
          "VALIDATION_ERROR",
        );
      }
      url = parsedUrl.href;
    }

    if (!Array.isArray(raw.supplies) || raw.supplies.length === 0) {
      throw new AxiError(
        `source ${name} supplies must be a non-empty array`,
        "VALIDATION_ERROR",
      );
    }

    const supplies: QuotaSourceSupplies[] = [];
    for (const entry of raw.supplies) {
      if (!isRecord(entry)) {
        throw new AxiError(
          `source ${name} supplies entry must be an object`,
          "VALIDATION_ERROR",
        );
      }
      for (const key of Object.keys(entry)) {
        if (!ALLOWED_SUPPLIES_KEYS.has(key)) {
          throw new AxiError(
            `unknown key in source ${name} supplies: ${key}`,
            "VALIDATION_ERROR",
          );
        }
      }
      if (
        typeof entry.provider !== "string" ||
        !PROVIDER_IDS.includes(entry.provider as ProviderId)
      ) {
        throw new AxiError(
          `source ${name} supplies unknown provider: ${String(entry.provider)}`,
          "VALIDATION_ERROR",
          [`Supported providers: ${PROVIDER_IDS.join(", ")}`],
        );
      }
      const provider = entry.provider as ProviderId;

      if (
        typeof entry.accountKey !== "string" ||
        !/^[a-z0-9][a-z0-9:_-]{0,95}$/.test(entry.accountKey)
      ) {
        throw new AxiError(
          `source ${name} supplies invalid accountKey: ${String(entry.accountKey)}`,
          "VALIDATION_ERROR",
        );
      }
      const accountKey = entry.accountKey;

      let subscription: string | undefined;
      if (entry.subscription !== undefined) {
        if (
          typeof entry.subscription !== "string" ||
          !/^[a-f0-9]{64}$/.test(entry.subscription)
        ) {
          throw new AxiError(
            `source ${name} supplies invalid subscription digest: ${String(entry.subscription)}`,
            "VALIDATION_ERROR",
            ["Subscription pin must be a 64-character lowercase hex digest"],
          );
        }
        subscription = entry.subscription;
      }

      let standsFor: string | undefined;
      if (entry.standsFor !== undefined) {
        if (
          typeof entry.standsFor !== "string" ||
          !/^[a-z0-9][a-z0-9:_-]{0,95}$/.test(entry.standsFor)
        ) {
          throw new AxiError(
            `source ${name} supplies invalid standsFor: ${String(entry.standsFor)}`,
            "VALIDATION_ERROR",
            ["standsFor names one local lane's accountKey, such as default"],
          );
        }
        standsFor = entry.standsFor;
        const standsForKey = `${provider}:${standsFor}`;
        if (seenStandsFor.has(standsForKey)) {
          throw new AxiError(
            `duplicate standsFor across sources: ${standsForKey}`,
            "VALIDATION_ERROR",
            ["Each local lane may be stood in for by one supplies entry only"],
          );
        }
        seenStandsFor.add(standsForKey);
      }

      const pairKey = `${provider}:${accountKey}`;
      if (seenPairs.has(pairKey)) {
        throw new AxiError(
          `duplicate provider and accountKey across sources: ${pairKey}`,
          "VALIDATION_ERROR",
          ["Each provider and accountKey pair may only be declared once"],
        );
      }
      seenPairs.add(pairKey);

      supplies.push({
        provider,
        accountKey,
        ...(subscription ? { subscription } : {}),
        ...(standsFor ? { standsFor } : {}),
      });
    }

    const maxAgeSeconds = parseSourceDuration(raw.maxAge);
    if (
      maxAgeSeconds === undefined ||
      maxAgeSeconds <= 0 ||
      maxAgeSeconds > 86_400
    ) {
      throw new AxiError(
        `source ${name} maxAge must be a duration between 1s and 24h`,
        "VALIDATION_ERROR",
        ["Provide a duration such as 10m or 1h up to 24h"],
      );
    }

    let timeoutSeconds = 3;
    if (raw.timeout !== undefined) {
      const parsedTimeout = parseSourceDuration(raw.timeout);
      if (
        parsedTimeout === undefined ||
        parsedTimeout <= 0 ||
        parsedTimeout > 15
      ) {
        throw new AxiError(
          `source ${name} timeout must be a duration between 1s and 15s`,
          "VALIDATION_ERROR",
          ["Provide a duration such as 3s or 5s up to 15s"],
        );
      }
      timeoutSeconds = parsedTimeout;
    }

    if (raw.share !== undefined && typeof raw.share !== "boolean") {
      throw new AxiError(
        `source ${name} share must be a boolean`,
        "VALIDATION_ERROR",
      );
    }

    validated.push({
      name,
      ...(url ? { url } : {}),
      ...(filePath ? { file: filePath } : {}),
      ...(allowInsecureTransport ? { allowInsecureTransport } : {}),
      supplies,
      maxAge: maxAgeSeconds,
      timeout: timeoutSeconds,
      ...(raw.share === false ? { share: false as const } : {}),
    });
  }

  return validated;
}

/**
 * The `sharedFirst` switch in the user config file: whether a fresh reading
 * from a declared source stands in for a matching local lane's vendor read.
 * On unless the file says exactly `false`; any other non-boolean value throws
 * rather than silently skipping or forcing local reads.
 */
export function readSharedFirst(file: string = userConfigFilePath()): boolean {
  const config = readJsonFile(file);
  const value = isRecord(config) ? config.sharedFirst : undefined;
  if (value === undefined) return true;
  if (typeof value !== "boolean") {
    throw new AxiError(
      "sharedFirst must be a boolean in config.json",
      "VALIDATION_ERROR",
      ["Set sharedFirst to false to read every local lane yourself"],
    );
  }
  return value;
}

function rawSuppliesList(raw: unknown): { provider?: unknown }[] {
  if (!isRecord(raw) || !Array.isArray(raw.supplies)) return [];
  return raw.supplies.filter(isRecord);
}

function parseSourceDuration(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  }
  if (typeof value !== "string") return undefined;
  const match = /^(\d{1,7})(s|m|h)?$/.exec(value.trim());
  if (!match) return undefined;
  const multiplier = match[2] === "h" ? 3600 : match[2] === "m" ? 60 : 1;
  return Number(match[1]) * multiplier;
}
