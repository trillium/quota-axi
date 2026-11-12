import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { quotaCommand } from "../src/commands.js";
import { PROVIDERS } from "../src/providers/index.js";
import type {
  ProviderAdapter,
  ProviderId,
  QuotaAxiResponse,
} from "../src/types.js";

const MINUTE = 60_000;

let tempDir: string;
let originalXdg: string | undefined;
let originalCache: string | undefined;
const originals = new Map<ProviderId, ProviderAdapter>();

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-parent-test-"));
  originalXdg = process.env.XDG_CONFIG_HOME;
  originalCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CONFIG_HOME = join(tempDir, "config");
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
});

afterEach(() => {
  for (const [id, adapter] of originals) PROVIDERS[id] = adapter;
  originals.clear();
  rmSync(tempDir, { recursive: true, force: true });
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  if (originalCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalCache;
});

function writeConfig(json: unknown): void {
  const dir = join(tempDir, "config", "quota-axi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(json), "utf8");
}

function windowAt(percentUsed: number, now: number) {
  return {
    id: "five_hour",
    label: "5h",
    kind: "session" as const,
    percentUsed,
    percentRemaining: 100 - percentUsed,
    startsAt: new Date(now - 30 * MINUTE).toISOString(),
    resetsAt: new Date(now + 60 * MINUTE).toISOString(),
    windowSeconds: 18000,
  };
}

/** The local adapter: logged in (fresh 70%) or login-less (auth_required). */
function mockLocal(provider: ProviderId, loggedIn: boolean): void {
  originals.set(provider, PROVIDERS[provider]);
  const now = Date.now();
  PROVIDERS[provider] = {
    id: provider,
    label: PROVIDERS[provider].label,
    accountDiscovery: "none",
    fetchQuota: async () =>
      loggedIn
        ? {
            provider,
            label: PROVIDERS[provider].label,
            source: "oauth",
            windows: [windowAt(70, now)],
            state: {
              status: "fresh",
              stale: false,
              refreshedAt: new Date(now).toISOString(),
              sourcesTried: ["oauth"],
            },
          }
        : {
            provider,
            label: PROVIDERS[provider].label,
            source: "unavailable",
            windows: [],
            state: {
              status: "auth_required",
              stale: false,
              error: "no_credentials",
              sourcesTried: [],
            },
          },
    inspectAuth: async () => ({
      provider,
      label: PROVIDERS[provider].label,
      status: "usable",
      sourcesTried: [],
    }),
  } as unknown as ProviderAdapter;
}

function parentFile(
  rows: { provider: ProviderId; accountKey?: string; ageMinutes?: number }[],
): string {
  const now = Date.now();
  const file = join(tempDir, "parent.json");
  const report: QuotaAxiResponse = {
    generatedAt: new Date(now).toISOString(),
    schemaVersion: 6,
    providers: rows.map((row) => ({
      provider: row.provider,
      ...(row.accountKey
        ? { accountKey: row.accountKey, accountKeys: [row.accountKey] }
        : {}),
      label: PROVIDERS[row.provider].label,
      source: "oauth",
      windows: [windowAt(20, now)],
      state: {
        status: "fresh",
        stale: false,
        refreshedAt: new Date(
          now - (row.ageMinutes ?? 1) * MINUTE,
        ).toISOString(),
        sourcesTried: ["oauth"],
      },
    })),
  };
  writeFileSync(file, JSON.stringify(report), "utf8");
  return file;
}

const parent = (file: string, extra: Record<string, unknown> = {}) => ({
  name: "macbook",
  file,
  parent: true,
  maxAge: "10m",
  ...extra,
});

async function quota(args: string[] = []): Promise<QuotaAxiResponse> {
  return JSON.parse(await quotaCommand([...args, "--json"], undefined));
}

describe("parent source", () => {
  it("fills in a provider the host cannot read, with provenance", async () => {
    mockLocal("claude", false);
    writeConfig({
      sources: [parent(parentFile([{ provider: "claude" }]))],
    });
    const report = await quota(["--provider", "claude"]);
    const claude = report.providers.filter((p) => p.provider === "claude");
    expect(claude).toHaveLength(1);
    expect(claude[0].windows[0].percentRemaining).toBe(80);
    expect(claude[0].accountKey).toBeUndefined();
    expect(claude[0].state.status).toBe("fresh");
    expect(claude[0].state.sharedFrom).toBe("macbook");
    expect(claude[0].state.importedFrom).toBe("macbook");
    expect(claude[0].state.refreshedAt).toBeTruthy();
  });

  it("is subordinate: a working local reading wins and the parent is not listed", async () => {
    mockLocal("claude", true);
    writeConfig({
      sources: [parent(parentFile([{ provider: "claude" }]))],
    });
    const report = await quota(["--provider", "claude"]);
    const claude = report.providers.filter((p) => p.provider === "claude");
    expect(claude).toHaveLength(1);
    expect(claude[0].windows[0].percentRemaining).toBe(30);
    expect(claude[0].state.sharedFrom).toBeUndefined();
  });

  it("passes a too-old parent reading through as stale, never fresh", async () => {
    mockLocal("claude", false);
    writeConfig({
      sources: [parent(parentFile([{ provider: "claude", ageMinutes: 30 }]))],
    });
    const claude = (await quota(["--provider", "claude"])).providers.find(
      (p) => p.provider === "claude",
    )!;
    expect(claude.state.status).toBe("stale");
    expect(claude.state.stale).toBe(true);
    expect(claude.state.error).toBe("source_reading_too_old");
    expect(claude.state.sharedFrom).toBe("macbook");
  });

  it("keeps the parent's lane keys when it reports several lanes", async () => {
    mockLocal("claude", false);
    writeConfig({
      sources: [
        parent(
          parentFile([
            { provider: "claude", accountKey: "a" },
            { provider: "claude", accountKey: "b" },
          ]),
        ),
      ],
    });
    const claude = (await quota(["--provider", "claude"])).providers.filter(
      (p) => p.provider === "claude",
    );
    expect(claude.map((p) => p.accountKey).sort()).toEqual(["a", "b"]);
  });

  it("leaves the local failure in place when the parent is unreachable", async () => {
    mockLocal("claude", false);
    writeConfig({
      sources: [parent(join(tempDir, "missing.json"))],
    });
    const claude = (await quota(["--provider", "claude"])).providers.find(
      (p) => p.provider === "claude",
    )!;
    expect(claude.state.status).toBe("auth_required");
    expect(claude.state.sharedFrom).toBeUndefined();
  });

  it("is bypassed by --no-sources", async () => {
    mockLocal("claude", false);
    writeConfig({
      sources: [parent(parentFile([{ provider: "claude" }]))],
    });
    const claude = (
      await quota(["--provider", "claude", "--no-sources"])
    ).providers.find((p) => p.provider === "claude")!;
    expect(claude.state.status).toBe("auth_required");
  });

  it("rejects a parent that declares supplies", async () => {
    writeConfig({
      sources: [
        parent(parentFile([{ provider: "claude" }]), {
          supplies: [{ provider: "claude", accountKey: "default" }],
        }),
      ],
    });
    await expect(quota(["--provider", "claude"])).rejects.toThrow(
      /must not declare supplies/,
    );
  });
});
