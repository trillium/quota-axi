import { createServer, type Server } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { subscriptionIdentity, writeCachedProviders } from "../src/cache.js";
import { authCommand, quotaCommand } from "../src/commands.js";
import { cacheFilePath } from "../src/lib/fs.js";
import { PROVIDERS } from "../src/providers/index.js";
import { quotaExportReport } from "../src/render.js";
import type {
  ProviderAdapter,
  ProviderId,
  ProviderQuota,
  QuotaAxiResponse,
} from "../src/types.js";

const MINUTE = 60_000;

let tempDir: string;
let originalXdg: string | undefined;
let originalCache: string | undefined;
const originals = new Map<ProviderId, ProviderAdapter>();
let reads: Record<string, number>;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-shared-test-"));
  originalXdg = process.env.XDG_CONFIG_HOME;
  originalCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CONFIG_HOME = join(tempDir, "config");
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
  reads = {};
});

afterEach(() => {
  for (const [id, adapter] of originals) PROVIDERS[id] = adapter;
  originals.clear();
  rmSync(tempDir, { recursive: true, force: true });
  process.env.XDG_CONFIG_HOME = originalXdg;
  if (originalCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalCache;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
});

function writeConfig(json: unknown): void {
  const dir = join(tempDir, "config", "quota-axi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(json), "utf8");
}

function window(percentUsed: number, now: number) {
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

function localReading(
  provider: ProviderId,
  percentUsed: number,
  extra: Partial<ProviderQuota> = {},
): ProviderQuota {
  const now = Date.now();
  return {
    provider,
    label: PROVIDERS[provider].label,
    source: "oauth",
    windows: [window(percentUsed, now)],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: new Date(now).toISOString(),
      sourcesTried: ["oauth"],
    },
    ...extra,
  };
}

/** Local adapter that counts its vendor reads; lanes make it expand. */
function mockLocal(provider: ProviderId, lanes?: string[]): void {
  originals.set(provider, PROVIDERS[provider]);
  const adapter = {
    id: provider,
    label: PROVIDERS[provider].label,
    accountDiscovery: "none",
    fetchQuota: async () => {
      reads[`${provider}:default`] = (reads[`${provider}:default`] ?? 0) + 1;
      return localReading(provider, 70);
    },
    inspectAuth: async () => ({
      provider,
      label: PROVIDERS[provider].label,
      status: "usable",
      sourcesTried: [],
    }),
    ...(lanes
      ? {
          discoverAccounts: async () =>
            lanes.map((accountKey) => ({
              accountKey,
              fetchQuota: async () => {
                reads[`${provider}:${accountKey}`] =
                  (reads[`${provider}:${accountKey}`] ?? 0) + 1;
                return localReading(provider, 70);
              },
              inspectAuth: async () => ({
                provider,
                sources: [],
              }),
            })),
        }
      : {}),
  };
  PROVIDERS[provider] = adapter as unknown as ProviderAdapter;
}

type Row = {
  provider: ProviderId;
  accountKey: string;
  percentUsed?: number;
  ageMinutes?: number;
  subscription?: string;
  status?: string;
};

/** Another machine's `--export` payload. */
function exportFile(rows: Row[], name = "peer.json"): string {
  const now = Date.now();
  const file = join(tempDir, name);
  const report: QuotaAxiResponse = {
    generatedAt: new Date(now).toISOString(),
    schemaVersion: 6,
    providers: rows.map((row) => ({
      provider: row.provider,
      accountKey: row.accountKey,
      accountKeys: [row.accountKey],
      label: PROVIDERS[row.provider].label,
      source: "oauth",
      windows: [window(row.percentUsed ?? 20, now)],
      ...(row.subscription ? { subscription: row.subscription } : {}),
      state: {
        status: (row.status ?? "fresh") as "fresh",
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

async function quota(args: string[]): Promise<QuotaAxiResponse> {
  return JSON.parse(await quotaCommand([...args, "--json"], undefined));
}

function lane(report: QuotaAxiResponse, accountKey: string) {
  return report.providers.find((p) => p.accountKey === accountKey);
}

const CLAUDE_LANES = ["token:aaa", "token:bbb"];

function sharedSource(file: string, extra: Record<string, unknown> = {}) {
  return {
    name: "macbook",
    file,
    supplies: [
      { provider: "claude", accountKey: "mac-aaa", standsFor: "token:aaa" },
    ],
    maxAge: "10m",
    ...extra,
  };
}

describe("shared first, check when stale", () => {
  it("serves a lane from a fresh shared reading and skips its local read", async () => {
    mockLocal("claude", CLAUDE_LANES);
    writeConfig({
      sources: [
        sharedSource(
          exportFile([
            { provider: "claude", accountKey: "mac-aaa", percentUsed: 20 },
          ]),
        ),
      ],
    });

    const report = await quota(["--provider", "claude"]);

    expect(reads["claude:token:aaa"]).toBeUndefined();
    expect(reads["claude:token:bbb"]).toBe(1);
    const shared = lane(report, "token:aaa")!;
    expect(shared.state.sharedFrom).toBe("macbook");
    expect(shared.state.importedFrom).toBe("macbook");
    expect(shared.state.status).toBe("fresh");
    expect(shared.state.refreshedAt).toBeDefined();
    expect(shared.accountKeys).toEqual(["token:aaa"]);
    expect(shared.windows[0].percentRemaining).toBe(80);
    // The shared reading is the lane's row; it is not also its own source row.
    expect(lane(report, "source:macbook:mac-aaa")).toBeUndefined();
    // The sibling lane was read locally and says nothing about sharing.
    expect(lane(report, "token:bbb")!.state.sharedFrom).toBeUndefined();
    expect(lane(report, "token:bbb")!.windows[0].percentRemaining).toBe(30);
    expect(report.schemaVersion).toBe(6);
  });

  it("says in TOON which lane was served from a shared record", async () => {
    mockLocal("claude", CLAUDE_LANES);
    writeConfig({
      sources: [
        sharedSource(
          exportFile([{ provider: "claude", accountKey: "mac-aaa" }]),
        ),
      ],
    });

    const toon = await quotaCommand(["--provider", "claude"], undefined);

    expect(toon).toMatch(
      /claude,"token:aaa",all,shared,"macbook · last refreshed /,
    );
    expect(toon).not.toMatch(/"token:bbb",all,shared/);
    expect(toon).not.toContain("source:macbook");
  });

  it("serves the single selected lane when a supplies entry stands for default", async () => {
    mockLocal("claude");
    writeConfig({
      sources: [
        {
          name: "macbook",
          file: exportFile([{ provider: "claude", accountKey: "mac" }]),
          supplies: [
            { provider: "claude", accountKey: "mac", standsFor: "default" },
          ],
          maxAge: "10m",
        },
      ],
    });

    const report = await quota(["--provider", "claude"]);

    expect(reads["claude:default"]).toBeUndefined();
    expect(report.providers).toHaveLength(1);
    // The legacy keyless shape is kept: nothing expanded.
    expect(report.schemaVersion).toBe(5);
    expect(report.providers[0].accountKey).toBeUndefined();
    expect(report.providers[0].state.sharedFrom).toBe("macbook");
  });

  describe("falls back to the local read", () => {
    it("when the shared reading is older than the source's maxAge", async () => {
      mockLocal("claude", CLAUDE_LANES);
      writeConfig({
        sources: [
          sharedSource(
            exportFile([
              { provider: "claude", accountKey: "mac-aaa", ageMinutes: 30 },
            ]),
          ),
        ],
      });

      const report = await quota(["--provider", "claude"]);

      expect(reads["claude:token:aaa"]).toBe(1);
      expect(lane(report, "token:aaa")!.state.sharedFrom).toBeUndefined();
      expect(lane(report, "token:aaa")!.windows[0].percentRemaining).toBe(30);
      // The too-old reading is still reported, as a stale source row.
      expect(lane(report, "source:macbook:mac-aaa")!.state.error).toBe(
        "source_reading_too_old",
      );
    });

    it("when the source is missing", async () => {
      mockLocal("claude", CLAUDE_LANES);
      writeConfig({
        sources: [sharedSource(join(tempDir, "does-not-exist.json"))],
      });

      const report = await quota(["--provider", "claude"]);

      expect(reads["claude:token:aaa"]).toBe(1);
      expect(lane(report, "token:aaa")!.state.status).toBe("fresh");
      expect(lane(report, "source:macbook:mac-aaa")!.state.error).toBe(
        "source_unreachable",
      );
    });

    it("when the source has no row for the entry", async () => {
      mockLocal("claude", CLAUDE_LANES);
      writeConfig({
        sources: [
          sharedSource(
            exportFile([{ provider: "claude", accountKey: "someone-else" }]),
          ),
        ],
      });

      await quota(["--provider", "claude"]);

      expect(reads["claude:token:aaa"]).toBe(1);
    });

    it("when the source reports its own provider as failed", async () => {
      mockLocal("claude", CLAUDE_LANES);
      writeConfig({
        sources: [
          sharedSource(
            exportFile([
              {
                provider: "claude",
                accountKey: "mac-aaa",
                status: "auth_required",
              },
            ]),
          ),
        ],
      });

      const report = await quota(["--provider", "claude"]);

      expect(reads["claude:token:aaa"]).toBe(1);
      expect(lane(report, "token:aaa")!.state.status).toBe("fresh");
      expect(lane(report, "source:macbook:mac-aaa")!.state.error).toBe(
        "source_provider_auth_required",
      );
    });

    it("when the source answers malformed", async () => {
      mockLocal("claude", CLAUDE_LANES);
      const file = join(tempDir, "bad.json");
      writeFileSync(file, "not json", "utf8");
      writeConfig({ sources: [sharedSource(file)] });

      const report = await quota(["--provider", "claude"]);

      expect(reads["claude:token:aaa"]).toBe(1);
      expect(lane(report, "token:aaa")!.state.status).toBe("fresh");
    });

    it("when the source pins a subscription the reading does not carry", async () => {
      mockLocal("claude", CLAUDE_LANES);
      writeConfig({
        sources: [
          {
            ...sharedSource(
              exportFile([{ provider: "claude", accountKey: "mac-aaa" }]),
            ),
            supplies: [
              {
                provider: "claude",
                accountKey: "mac-aaa",
                standsFor: "token:aaa",
                subscription: "a".repeat(64),
              },
            ],
          },
        ],
      });

      await quota(["--provider", "claude"]);

      expect(reads["claude:token:aaa"]).toBe(1);
    });
  });

  describe("can be switched off", () => {
    const fresh = () =>
      exportFile([{ provider: "claude", accountKey: "mac-aaa" }]);

    it("with sharedFirst: false in config.json", async () => {
      mockLocal("claude", CLAUDE_LANES);
      writeConfig({ sharedFirst: false, sources: [sharedSource(fresh())] });

      const report = await quota(["--provider", "claude"]);

      expect(reads["claude:token:aaa"]).toBe(1);
      expect(lane(report, "token:aaa")!.state.sharedFrom).toBeUndefined();
      // The source is still read and listed as before.
      expect(lane(report, "source:macbook:mac-aaa")!.state.status).toBe(
        "fresh",
      );
    });

    it("rejects a non-boolean sharedFirst", async () => {
      mockLocal("claude", CLAUDE_LANES);
      writeConfig({ sharedFirst: "no", sources: [sharedSource(fresh())] });

      await expect(quota(["--provider", "claude"])).rejects.toThrow(
        /sharedFirst must be a boolean/,
      );
    });

    it("with --no-shared", async () => {
      mockLocal("claude", CLAUDE_LANES);
      writeConfig({ sources: [sharedSource(fresh())] });

      const report = await quota(["--provider", "claude", "--no-shared"]);

      expect(reads["claude:token:aaa"]).toBe(1);
      expect(lane(report, "token:aaa")!.state.sharedFrom).toBeUndefined();
      expect(lane(report, "source:macbook:mac-aaa")!.state.status).toBe(
        "fresh",
      );
    });

    it("per source with share: false", async () => {
      mockLocal("claude", CLAUDE_LANES);
      writeConfig({ sources: [sharedSource(fresh(), { share: false })] });

      const report = await quota(["--provider", "claude"]);

      expect(reads["claude:token:aaa"]).toBe(1);
      expect(lane(report, "source:macbook:mac-aaa")!.state.status).toBe(
        "fresh",
      );
    });

    it("with --no-sources, which reads no source at all", async () => {
      mockLocal("claude", CLAUDE_LANES);
      const requests: string[] = [];
      const server: Server = createServer((req, res) => {
        requests.push(req.url ?? "");
        res.end("{}");
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        writeConfig({
          sources: [
            {
              name: "macbook",
              url: `http://127.0.0.1:${port}/export.json`,
              allowInsecureTransport: true,
              supplies: [
                {
                  provider: "claude",
                  accountKey: "mac-aaa",
                  standsFor: "token:aaa",
                },
              ],
              maxAge: "10m",
            },
          ],
        });

        const report = await quota(["--provider", "claude", "--no-sources"]);

        expect(requests).toEqual([]);
        expect(reads["claude:token:aaa"]).toBe(1);
        expect(report.providers.map((p) => p.accountKey)).toEqual([
          "token:aaa",
          "token:bbb",
        ]);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("rejects --no-shared on auth, which never reads sources", async () => {
      await expect(authCommand(["--no-shared"], undefined)).rejects.toThrow(
        /--no-shared is only supported/,
      );
    });
  });

  describe("matches only on explicit identity", () => {
    it("never by label or email: a lane with no standsFor and no stamp is read locally", async () => {
      mockLocal("claude", CLAUDE_LANES);
      writeConfig({
        sources: [
          {
            name: "macbook",
            file: exportFile([
              { provider: "claude", accountKey: "token:aaa" },
              { provider: "claude", accountKey: "default" },
            ]),
            supplies: [
              // Same accountKey spelling as the local lane, but it only names
              // the source's row; it does not say which local lane it covers.
              { provider: "claude", accountKey: "token:aaa" },
              { provider: "claude", accountKey: "default" },
            ],
            maxAge: "10m",
          },
        ],
      });

      const report = await quota(["--provider", "claude"]);

      expect(reads["claude:token:aaa"]).toBe(1);
      expect(reads["claude:token:bbb"]).toBe(1);
      expect(report.providers.some((p) => p.state.sharedFrom)).toBe(false);
      expect(lane(report, "source:macbook:token:aaa")).toBeDefined();
    });

    it("never by position: a standsFor names a lane key, not an index", async () => {
      mockLocal("claude", CLAUDE_LANES);
      writeConfig({
        sources: [
          sharedSource(
            exportFile([{ provider: "claude", accountKey: "mac-aaa" }]),
            {
              supplies: [
                { provider: "claude", accountKey: "mac-aaa", standsFor: "0" },
              ],
            },
          ),
        ],
      });

      await quota(["--provider", "claude"]);

      expect(reads["claude:token:aaa"]).toBe(1);
      expect(reads["claude:token:bbb"]).toBe(1);
    });

    describe("by verified subscription hash", () => {
      const account = {
        accountId: "acct-shared",
        identityStatus: "verified" as const,
      };
      const hash = () =>
        subscriptionIdentity(localReading("grok", 1, { account }))!;

      function seedLocalSlot(
        extra: Partial<ProviderQuota> = {},
        ageMs = 0,
      ): void {
        const reading = localReading("grok", 65, { account, ...extra });
        reading.state.refreshedAt = new Date(Date.now() - ageMs).toISOString();
        writeCachedProviders([reading], reading.state.refreshedAt);
      }

      function subscriptionSource(subscription?: string) {
        return {
          name: "macbook",
          file: exportFile([
            { provider: "grok", accountKey: "default", subscription },
          ]),
          supplies: [{ provider: "grok", accountKey: "default" }],
          maxAge: "10m",
        };
      }

      it("serves the lane whose own last local read verified the same subscription", async () => {
        mockLocal("grok");
        seedLocalSlot();
        writeConfig({ sources: [subscriptionSource(hash())] });

        const report = await quota(["--provider", "grok"]);

        expect(reads["grok:default"]).toBeUndefined();
        expect(report.providers).toHaveLength(1);
        expect(report.providers[0].state.sharedFrom).toBe("macbook");
        expect(report.providers[0].windows[0].percentRemaining).toBe(80);
      });

      it("reads locally when the source's subscription differs", async () => {
        mockLocal("grok");
        seedLocalSlot();
        writeConfig({ sources: [subscriptionSource("b".repeat(64))] });

        const report = await quota(["--provider", "grok"]);

        expect(reads["grok:default"]).toBe(1);
        expect(report.providers.some((p) => p.state.sharedFrom)).toBe(false);
      });

      it("reads locally when the source publishes no subscription", async () => {
        mockLocal("grok");
        seedLocalSlot();
        writeConfig({ sources: [subscriptionSource(undefined)] });

        await quota(["--provider", "grok"]);

        expect(reads["grok:default"]).toBe(1);
      });

      it("reads locally when the lane has never verified an identity", async () => {
        mockLocal("grok");
        writeConfig({ sources: [subscriptionSource(hash())] });

        await quota(["--provider", "grok"]);

        expect(reads["grok:default"]).toBe(1);
      });

      it("reads locally when the lane's own last read is too old to vouch for it", async () => {
        mockLocal("grok");
        seedLocalSlot({}, 25 * 60 * MINUTE);
        writeConfig({ sources: [subscriptionSource(hash())] });

        await quota(["--provider", "grok"]);

        expect(reads["grok:default"]).toBe(1);
      });

      it("refuses a declared stand-in whose verified subscription differs", async () => {
        mockLocal("grok");
        seedLocalSlot();
        writeConfig({
          sources: [
            {
              ...subscriptionSource("c".repeat(64)),
              supplies: [
                {
                  provider: "grok",
                  accountKey: "default",
                  standsFor: "default",
                },
              ],
            },
          ],
        });

        await quota(["--provider", "grok"]);

        expect(reads["grok:default"]).toBe(1);
      });
    });
  });

  describe("keeps the safety rules", () => {
    it("never caches a shared lane as a local reading", async () => {
      mockLocal("claude", CLAUDE_LANES);
      writeConfig({
        sources: [
          sharedSource(
            exportFile([{ provider: "claude", accountKey: "mac-aaa" }]),
          ),
        ],
      });

      await quota(["--provider", "claude"]);

      const cache = existsSync(cacheFilePath())
        ? (JSON.parse(readFileSync(cacheFilePath(), "utf8")).providers as {
            accountKey?: string;
          }[])
        : [];
      expect(cache.map((entry) => entry.accountKey)).not.toContain("token:aaa");
      expect(JSON.stringify(cache)).not.toContain("macbook");
    });

    it("never re-exports a shared lane, and an export reads no source", async () => {
      mockLocal("claude", CLAUDE_LANES);
      writeConfig({
        sources: [
          sharedSource(
            exportFile([{ provider: "claude", accountKey: "mac-aaa" }]),
          ),
        ],
      });

      const exported = JSON.parse(
        await quotaCommand(["--provider", "claude", "--export"], undefined),
      ) as QuotaAxiResponse;

      expect(reads["claude:token:aaa"]).toBe(1);
      expect(exported.providers.map((p) => p.accountKey)).toEqual([
        "token:aaa",
        "token:bbb",
      ]);
      expect(exported.providers.some((p) => p.state.importedFrom)).toBe(false);

      const shared = JSON.parse(
        JSON.stringify({
          generatedAt: exported.generatedAt,
          schemaVersion: 6,
          providers: [
            {
              ...exported.providers[0],
              state: {
                ...exported.providers[0].state,
                importedFrom: "macbook",
                sharedFrom: "macbook",
              },
            },
            exported.providers[1],
          ],
        }),
      ) as QuotaAxiResponse;
      expect(
        quotaExportReport(shared).providers.map((p) => p.accountKey),
      ).toEqual(["token:bbb"]);
    });

    it("sends no credential or authorization header to the source", async () => {
      mockLocal("claude", CLAUDE_LANES);
      const headers: Record<string, unknown>[] = [];
      const file = exportFile([{ provider: "claude", accountKey: "mac-aaa" }]);
      const body = readFileSync(file, "utf8");
      const server: Server = createServer((req, res) => {
        headers.push(req.headers);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        writeConfig({
          sources: [
            {
              name: "macbook",
              url: `http://127.0.0.1:${port}/export.json`,
              allowInsecureTransport: true,
              supplies: [
                {
                  provider: "claude",
                  accountKey: "mac-aaa",
                  standsFor: "token:aaa",
                },
              ],
              maxAge: "10m",
            },
          ],
        });

        const report = await quota(["--provider", "claude"]);

        expect(lane(report, "token:aaa")!.state.sharedFrom).toBe("macbook");
        expect(headers).toHaveLength(1);
        expect(headers[0].authorization).toBeUndefined();
        expect(headers[0].cookie).toBeUndefined();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("lets a source failure leave every local read untouched", async () => {
      mockLocal("claude", CLAUDE_LANES);
      writeConfig({
        sources: [sharedSource(join(tempDir, "missing.json"))],
      });

      const report = await quota(["--provider", "claude"]);

      expect(reads["claude:token:aaa"]).toBe(1);
      expect(reads["claude:token:bbb"]).toBe(1);
      expect(lane(report, "token:aaa")!.windows[0].percentRemaining).toBe(30);
    });
  });

  describe("config validation", () => {
    it("rejects two entries standing in for one lane", async () => {
      mockLocal("claude", CLAUDE_LANES);
      writeConfig({
        sources: [
          sharedSource(join(tempDir, "a.json")),
          {
            ...sharedSource(join(tempDir, "b.json")),
            name: "other",
            supplies: [
              {
                provider: "claude",
                accountKey: "other-aaa",
                standsFor: "token:aaa",
              },
            ],
          },
        ],
      });

      await expect(quota(["--provider", "claude"])).rejects.toThrow(
        /duplicate standsFor/,
      );
    });

    it("rejects a malformed standsFor", async () => {
      writeConfig({
        sources: [
          sharedSource(join(tempDir, "a.json"), {
            supplies: [
              { provider: "claude", accountKey: "mac", standsFor: "A B" },
            ],
          }),
        ],
      });

      await expect(quota(["--provider", "claude"])).rejects.toThrow(
        /invalid standsFor/,
      );
    });
  });
});
