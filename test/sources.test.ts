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
import { authCommand, quotaCommand } from "../src/commands.js";
import { PROVIDERS } from "../src/providers/index.js";
import type { QuotaAxiResponse } from "../src/types.js";

let tempDir: string | undefined;
let originalXdg: string | undefined;
let server: Server | undefined;
let serverPort: number;
let requestCount = 0;
let serverHandler: (req: any, res: any) => void;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-sources-test-"));
  originalXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tempDir;
  requestCount = 0;

  server = createServer((req, res) => {
    requestCount++;
    serverHandler(req, res);
  });

  await new Promise<void>((resolve) => {
    server!.listen(0, "127.0.0.1", () => {
      const addr = server!.address();
      serverPort = typeof addr === "object" && addr ? addr.port : 0;
      resolve();
    });
  });
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  process.env.XDG_CONFIG_HOME = originalXdg;
});

function writeConfig(json: unknown): string {
  const dir = join(tempDir!, "quota-axi");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify(json, null, 2), "utf8");
  return file;
}

function mockEmptyLocalProviders(): { restore: () => void } {
  const originalClaude = PROVIDERS.claude;
  const originalCodex = PROVIDERS.codex;

  PROVIDERS.claude = {
    label: "Claude",
    accountDiscovery: "none",
    fetchQuota: async () => ({
      provider: "claude",
      label: "Claude",
      source: "unavailable",
      windows: [],
      state: { status: "unavailable", stale: false, sourcesTried: [] },
    }),
    inspectAuth: async () => ({
      provider: "claude",
      label: "Claude",
      status: "unusable",
      sourcesTried: [],
    }),
  };

  PROVIDERS.codex = {
    label: "Codex",
    accountDiscovery: "none",
    fetchQuota: async () => ({
      provider: "codex",
      label: "Codex",
      source: "unavailable",
      windows: [],
      state: { status: "unavailable", stale: false, sourcesTried: [] },
    }),
    inspectAuth: async () => ({
      provider: "codex",
      label: "Codex",
      status: "unusable",
      sourcesTried: [],
    }),
  };

  return {
    restore: () => {
      PROVIDERS.claude = originalClaude;
      PROVIDERS.codex = originalCodex;
    },
  };
}

describe("custom quota sources read semantics and failure modes", () => {
  it("imports a fresh row: schema 6, lane key, importedFrom, refreshedAt in default --json, imported attention row, pace re-derived", async () => {
    const clock = Date.now();
    const nowIso = new Date(clock).toISOString();
    const futureReset = new Date(clock + 3600_000).toISOString();

    const producerReport: QuotaAxiResponse = {
      generatedAt: nowIso,
      schemaVersion: 6,
      providers: [
        {
          provider: "claude",
          accountKey: "default",
          accountKeys: ["default"],
          label: "Claude",
          source: "oauth",
          windows: [
            {
              id: "five_hour",
              label: "5h",
              kind: "session",
              percentUsed: 20,
              percentRemaining: 80,
              startsAt: new Date(clock - 1800_000).toISOString(),
              resetsAt: futureReset,
              windowSeconds: 18000,
            },
          ],
          state: {
            status: "fresh",
            stale: false,
            refreshedAt: nowIso,
            sourcesTried: ["oauth"],
          },
        },
      ],
    };

    serverHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(producerReport));
    };

    writeConfig({
      sources: [
        {
          name: "machine-a",
          url: `http://127.0.0.1:${serverPort}/export.json`,
          allowInsecureTransport: true,
          supplies: [{ provider: "claude", accountKey: "default" }],
          maxAge: "10m",
        },
      ],
    });

    const local = mockEmptyLocalProviders();
    try {
      // 1. JSON output
      const jsonOutput = await quotaCommand(
        ["--provider", "claude", "--json"],
        undefined,
      );
      const report: QuotaAxiResponse = JSON.parse(jsonOutput);

      expect(report.schemaVersion).toBe(6);
      const lane = report.providers.find(
        (p) => p.accountKey === "source:machine-a:default",
      );
      expect(lane).toBeDefined();
      expect(lane!.state.status).toBe("fresh");
      expect(lane!.state.stale).toBe(false);
      expect(lane!.state.importedFrom).toBe("machine-a");
      // refreshedAt is preserved in default --json because importedFrom is set
      expect(lane!.state.refreshedAt).toBe(nowIso);
      expect(lane!.windows).toHaveLength(1);
      // pace is re-derived at consumer time
      expect(lane!.windows[0].pace).toBeDefined();
      expect(lane!.quotaSemantics).toBeDefined();

      // 2. TOON output carries imported attention row
      const toonOutput = await quotaCommand(
        ["--provider", "claude"],
        undefined,
      );
      expect(toonOutput).toContain("attention");
      expect(toonOutput).toContain("source:machine-a:default");
      expect(toonOutput).toContain("imported");
      expect(toonOutput).toContain("machine-a");
    } finally {
      local.restore();
    }
  });

  describe("A.6 failure table", () => {
    it("source_unreachable on connection error or missing file", async () => {
      writeConfig({
        sources: [
          {
            name: "unreachable-file",
            file: "/tmp/nonexistent-quota-axi-file-xyz.json",
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "10m",
          },
        ],
      });

      const local = mockEmptyLocalProviders();
      try {
        const out = await quotaCommand(
          ["--provider", "claude", "--json"],
          undefined,
        );
        const report: QuotaAxiResponse = JSON.parse(out);
        const lane = report.providers.find(
          (p) => p.accountKey === "source:unreachable-file:default",
        );
        expect(lane).toBeDefined();
        expect(lane!.state.status).toBe("unavailable");
        expect(lane!.state.error).toBe("source_unreachable");
        expect(lane!.windows).toHaveLength(0);
      } finally {
        local.restore();
      }
    });

    it("source_timeout when source does not respond in time", async () => {
      serverHandler = (_req, _res) => {
        // never respond
      };

      writeConfig({
        sources: [
          {
            name: "hanging-server",
            url: `http://127.0.0.1:${serverPort}/export.json`,
            allowInsecureTransport: true,
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "10m",
            timeout: "1s",
          },
        ],
      });

      const local = mockEmptyLocalProviders();
      try {
        const out = await quotaCommand(
          ["--provider", "claude", "--json"],
          undefined,
        );
        const report: QuotaAxiResponse = JSON.parse(out);
        const lane = report.providers.find(
          (p) => p.accountKey === "source:hanging-server:default",
        );
        expect(lane).toBeDefined();
        expect(lane!.state.status).toBe("unavailable");
        expect(lane!.state.error).toBe("source_timeout");
      } finally {
        local.restore();
      }
    });

    it("source_http_error on non-2xx or redirect", async () => {
      serverHandler = (_req, res) => {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      };

      writeConfig({
        sources: [
          {
            name: "http-error-source",
            url: `http://127.0.0.1:${serverPort}/export.json`,
            allowInsecureTransport: true,
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "10m",
          },
        ],
      });

      const local = mockEmptyLocalProviders();
      try {
        const out = await quotaCommand(
          ["--provider", "claude", "--json"],
          undefined,
        );
        const report: QuotaAxiResponse = JSON.parse(out);
        const lane = report.providers.find(
          (p) => p.accountKey === "source:http-error-source:default",
        );
        expect(lane).toBeDefined();
        expect(lane!.state.status).toBe("unavailable");
        expect(lane!.state.error).toBe("source_http_error");
      } finally {
        local.restore();
      }
    });

    it("source_response_too_large when body exceeds 256 KiB", async () => {
      const hugeBody = "x".repeat(300_000);
      serverHandler = (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(hugeBody);
      };

      writeConfig({
        sources: [
          {
            name: "huge-source",
            url: `http://127.0.0.1:${serverPort}/export.json`,
            allowInsecureTransport: true,
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "10m",
          },
        ],
      });

      const local = mockEmptyLocalProviders();
      try {
        const out = await quotaCommand(
          ["--provider", "claude", "--json"],
          undefined,
        );
        const report: QuotaAxiResponse = JSON.parse(out);
        const lane = report.providers.find(
          (p) => p.accountKey === "source:huge-source:default",
        );
        expect(lane).toBeDefined();
        expect(lane!.state.status).toBe("unavailable");
        expect(lane!.state.error).toBe("source_response_too_large");
      } finally {
        local.restore();
      }
    });

    it("source_malformed when body is not JSON or bad schema structure", async () => {
      serverHandler = (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("NOT VALID JSON {{{");
      };

      writeConfig({
        sources: [
          {
            name: "malformed-source",
            url: `http://127.0.0.1:${serverPort}/export.json`,
            allowInsecureTransport: true,
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "10m",
          },
        ],
      });

      const local = mockEmptyLocalProviders();
      try {
        const out = await quotaCommand(
          ["--provider", "claude", "--json"],
          undefined,
        );
        const report: QuotaAxiResponse = JSON.parse(out);
        const lane = report.providers.find(
          (p) => p.accountKey === "source:malformed-source:default",
        );
        expect(lane).toBeDefined();
        expect(lane!.state.status).toBe("unavailable");
        expect(lane!.state.error).toBe("source_malformed");
      } finally {
        local.restore();
      }
    });

    it("source_unsupported_schema when schemaVersion is not 5 or 6", async () => {
      serverHandler = (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            generatedAt: new Date().toISOString(),
            schemaVersion: 4,
            providers: [],
          }),
        );
      };

      writeConfig({
        sources: [
          {
            name: "old-schema-source",
            url: `http://127.0.0.1:${serverPort}/export.json`,
            allowInsecureTransport: true,
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "10m",
          },
        ],
      });

      const local = mockEmptyLocalProviders();
      try {
        const out = await quotaCommand(
          ["--provider", "claude", "--json"],
          undefined,
        );
        const report: QuotaAxiResponse = JSON.parse(out);
        const lane = report.providers.find(
          (p) => p.accountKey === "source:old-schema-source:default",
        );
        expect(lane).toBeDefined();
        expect(lane!.state.status).toBe("unavailable");
        expect(lane!.state.error).toBe("source_unsupported_schema");
      } finally {
        local.restore();
      }
    });

    it("source_missing_account when declared accountKey is absent in producer report", async () => {
      serverHandler = (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            generatedAt: new Date().toISOString(),
            schemaVersion: 6,
            providers: [
              {
                provider: "claude",
                accountKey: "profile:different-account",
                accountKeys: ["profile:different-account"],
                label: "Claude",
                source: "oauth",
                windows: [],
                state: {
                  status: "fresh",
                  stale: false,
                  refreshedAt: new Date().toISOString(),
                },
              },
            ],
          }),
        );
      };

      writeConfig({
        sources: [
          {
            name: "missing-account-source",
            url: `http://127.0.0.1:${serverPort}/export.json`,
            allowInsecureTransport: true,
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "10m",
          },
        ],
      });

      const local = mockEmptyLocalProviders();
      try {
        const out = await quotaCommand(
          ["--provider", "claude", "--json"],
          undefined,
        );
        const report: QuotaAxiResponse = JSON.parse(out);
        const lane = report.providers.find(
          (p) => p.accountKey === "source:missing-account-source:default",
        );
        expect(lane).toBeDefined();
        expect(lane!.state.status).toBe("unavailable");
        expect(lane!.state.error).toBe("source_missing_account");
      } finally {
        local.restore();
      }
    });

    it("source_account_mismatch when subscription pin does not match", async () => {
      serverHandler = (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            generatedAt: new Date().toISOString(),
            schemaVersion: 6,
            providers: [
              {
                provider: "claude",
                accountKey: "default",
                accountKeys: ["default"],
                subscription: "b".repeat(64),
                label: "Claude",
                source: "oauth",
                windows: [],
                state: {
                  status: "fresh",
                  stale: false,
                  refreshedAt: new Date().toISOString(),
                },
              },
            ],
          }),
        );
      };

      writeConfig({
        sources: [
          {
            name: "mismatch-source",
            url: `http://127.0.0.1:${serverPort}/export.json`,
            allowInsecureTransport: true,
            supplies: [
              {
                provider: "claude",
                accountKey: "default",
                subscription: "a".repeat(64),
              },
            ],
            maxAge: "10m",
          },
        ],
      });

      const local = mockEmptyLocalProviders();
      try {
        const out = await quotaCommand(
          ["--provider", "claude", "--json"],
          undefined,
        );
        const report: QuotaAxiResponse = JSON.parse(out);
        const lane = report.providers.find(
          (p) => p.accountKey === "source:mismatch-source:default",
        );
        expect(lane).toBeDefined();
        expect(lane!.state.status).toBe("unavailable");
        expect(lane!.state.error).toBe("source_account_mismatch");
      } finally {
        local.restore();
      }
    });

    it("source_account_unverified when subscription pin is declared but producer published none", async () => {
      serverHandler = (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            generatedAt: new Date().toISOString(),
            schemaVersion: 6,
            providers: [
              {
                provider: "claude",
                accountKey: "default",
                accountKeys: ["default"],
                label: "Claude",
                source: "oauth",
                windows: [],
                state: {
                  status: "fresh",
                  stale: false,
                  refreshedAt: new Date().toISOString(),
                },
              },
            ],
          }),
        );
      };

      writeConfig({
        sources: [
          {
            name: "unverified-source",
            url: `http://127.0.0.1:${serverPort}/export.json`,
            allowInsecureTransport: true,
            supplies: [
              {
                provider: "claude",
                accountKey: "default",
                subscription: "a".repeat(64),
              },
            ],
            maxAge: "10m",
          },
        ],
      });

      const local = mockEmptyLocalProviders();
      try {
        const out = await quotaCommand(
          ["--provider", "claude", "--json"],
          undefined,
        );
        const report: QuotaAxiResponse = JSON.parse(out);
        const lane = report.providers.find(
          (p) => p.accountKey === "source:unverified-source:default",
        );
        expect(lane).toBeDefined();
        expect(lane!.state.status).toBe("unavailable");
        expect(lane!.state.error).toBe("source_account_unverified");
      } finally {
        local.restore();
      }
    });

    it("source_reading_too_old when reading exceeds maxAge; no quota[] row", async () => {
      const clock = Date.now();
      const oldTime = new Date(clock - 900_000).toISOString(); // 15 mins old
      const futureReset = new Date(clock + 3600_000).toISOString();

      serverHandler = (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            generatedAt: oldTime,
            schemaVersion: 6,
            providers: [
              {
                provider: "claude",
                accountKey: "default",
                accountKeys: ["default"],
                label: "Claude",
                source: "oauth",
                windows: [
                  {
                    id: "five_hour",
                    label: "5h",
                    kind: "session",
                    percentUsed: 30,
                    percentRemaining: 70,
                    resetsAt: futureReset,
                    windowSeconds: 18000,
                  },
                ],
                state: {
                  status: "fresh",
                  stale: false,
                  refreshedAt: oldTime,
                },
              },
            ],
          }),
        );
      };

      writeConfig({
        sources: [
          {
            name: "old-source",
            url: `http://127.0.0.1:${serverPort}/export.json`,
            allowInsecureTransport: true,
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "10m", // 10 minutes maxAge, but reading is 15 minutes old
          },
        ],
      });

      const local = mockEmptyLocalProviders();
      try {
        // 1. In JSON, lane is stale with source_reading_too_old
        const out = await quotaCommand(
          ["--provider", "claude", "--json"],
          undefined,
        );
        const report: QuotaAxiResponse = JSON.parse(out);
        const lane = report.providers.find(
          (p) => p.accountKey === "source:old-source:default",
        );
        expect(lane).toBeDefined();
        expect(lane!.state.status).toBe("stale");
        expect(lane!.state.stale).toBe(true);
        expect(lane!.state.error).toBe("source_reading_too_old");

        // 2. In TOON, no quota[] row, attention is stale
        const toon = await quotaCommand(["--provider", "claude"], undefined);
        expect(toon).toContain("quota[0]:");
        expect(toon).toContain("source:old-source:default");
        expect(toon).toContain("stale");
        expect(toon).toContain("source_reading_too_old");
      } finally {
        local.restore();
      }
    });

    it("source_stale when producer row is already stale; no quota[] row", async () => {
      const now = new Date().toISOString();
      serverHandler = (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            generatedAt: now,
            schemaVersion: 6,
            providers: [
              {
                provider: "claude",
                accountKey: "default",
                accountKeys: ["default"],
                label: "Claude",
                source: "oauth",
                windows: [],
                state: {
                  status: "stale",
                  stale: true,
                  error: "producer_vendor_error",
                  refreshedAt: now,
                },
              },
            ],
          }),
        );
      };

      writeConfig({
        sources: [
          {
            name: "already-stale-source",
            url: `http://127.0.0.1:${serverPort}/export.json`,
            allowInsecureTransport: true,
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "10m",
          },
        ],
      });

      const local = mockEmptyLocalProviders();
      try {
        const out = await quotaCommand(
          ["--provider", "claude", "--json"],
          undefined,
        );
        const report: QuotaAxiResponse = JSON.parse(out);
        const lane = report.providers.find(
          (p) => p.accountKey === "source:already-stale-source:default",
        );
        expect(lane).toBeDefined();
        expect(lane!.state.status).toBe("stale");
        expect(lane!.state.stale).toBe(true);
        expect(lane!.state.error).toBe("source_stale");
      } finally {
        local.restore();
      }
    });

    it("source_clock_ahead when refreshedAt is in the future by > 60s", async () => {
      const futureTime = new Date(Date.now() + 120_000).toISOString();
      serverHandler = (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            generatedAt: futureTime,
            schemaVersion: 6,
            providers: [
              {
                provider: "claude",
                accountKey: "default",
                accountKeys: ["default"],
                label: "Claude",
                source: "oauth",
                windows: [],
                state: {
                  status: "fresh",
                  stale: false,
                  refreshedAt: futureTime,
                },
              },
            ],
          }),
        );
      };

      writeConfig({
        sources: [
          {
            name: "future-source",
            url: `http://127.0.0.1:${serverPort}/export.json`,
            allowInsecureTransport: true,
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "10m",
          },
        ],
      });

      const local = mockEmptyLocalProviders();
      try {
        const out = await quotaCommand(
          ["--provider", "claude", "--json"],
          undefined,
        );
        const report: QuotaAxiResponse = JSON.parse(out);
        const lane = report.providers.find(
          (p) => p.accountKey === "source:future-source:default",
        );
        expect(lane).toBeDefined();
        expect(lane!.state.status).toBe("unavailable");
        expect(lane!.state.error).toBe("source_clock_ahead");
      } finally {
        local.restore();
      }
    });

    it("source_expired when all windows are past their reset", async () => {
      const pastReset = new Date(Date.now() - 3600_000).toISOString();
      const pastRefreshed = new Date(Date.now() - 60_000).toISOString();
      serverHandler = (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            generatedAt: pastRefreshed,
            schemaVersion: 6,
            providers: [
              {
                provider: "claude",
                accountKey: "default",
                accountKeys: ["default"],
                label: "Claude",
                source: "oauth",
                windows: [
                  {
                    id: "five_hour",
                    label: "5h",
                    kind: "session",
                    percentUsed: 50,
                    percentRemaining: 50,
                    resetsAt: pastReset,
                    windowSeconds: 18000,
                  },
                ],
                state: {
                  status: "fresh",
                  stale: false,
                  refreshedAt: pastRefreshed,
                },
              },
            ],
          }),
        );
      };

      writeConfig({
        sources: [
          {
            name: "expired-windows-source",
            url: `http://127.0.0.1:${serverPort}/export.json`,
            allowInsecureTransport: true,
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "10m",
          },
        ],
      });

      const local = mockEmptyLocalProviders();
      try {
        const out = await quotaCommand(
          ["--provider", "claude", "--json"],
          undefined,
        );
        const report: QuotaAxiResponse = JSON.parse(out);
        const lane = report.providers.find(
          (p) => p.accountKey === "source:expired-windows-source:default",
        );
        expect(lane).toBeDefined();
        expect(lane!.state.status).toBe("unavailable");
        expect(lane!.state.error).toBe("source_expired");
      } finally {
        local.restore();
      }
    });
  });

  it("producer auth_required row becomes unavailable without remedyCommand or authStatus", async () => {
    const now = new Date().toISOString();
    serverHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          generatedAt: now,
          schemaVersion: 6,
          providers: [
            {
              provider: "claude",
              accountKey: "default",
              accountKeys: ["default"],
              label: "Claude",
              source: "oauth",
              windows: [],
              state: {
                status: "auth_required",
                stale: false,
                error: "Claude sign-in required",
                authStatus: "unusable",
                remedyCommand: "claude login",
                refreshedAt: now,
              },
            },
          ],
        }),
      );
    };

    writeConfig({
      sources: [
        {
          name: "remote-auth-req",
          url: `http://127.0.0.1:${serverPort}/export.json`,
          allowInsecureTransport: true,
          supplies: [{ provider: "claude", accountKey: "default" }],
          maxAge: "10m",
        },
      ],
    });

    const local = mockEmptyLocalProviders();
    try {
      const out = await quotaCommand(
        ["--provider", "claude", "--full", "--json"],
        undefined,
      );
      const report: QuotaAxiResponse = JSON.parse(out);
      const lane = report.providers.find(
        (p) => p.accountKey === "source:remote-auth-req:default",
      );
      expect(lane).toBeDefined();
      expect(lane!.state.status).toBe("unavailable");
      expect(lane!.state.error).toBe("source_provider_auth_required");
      expect(lane!.state.authStatus).toBeUndefined();
      expect(lane!.state.remedyCommand).toBeUndefined();
    } finally {
      local.restore();
    }
  });

  it("never cached: local cache file is unchanged by a fresh source and not reused on source failure", async () => {
    const clock = Date.now();
    const nowIso = new Date(clock).toISOString();
    const futureReset = new Date(clock + 3600_000).toISOString();

    const producerReport: QuotaAxiResponse = {
      generatedAt: nowIso,
      schemaVersion: 6,
      providers: [
        {
          provider: "claude",
          accountKey: "default",
          accountKeys: ["default"],
          label: "Claude",
          source: "oauth",
          windows: [
            {
              id: "five_hour",
              label: "5h",
              kind: "session",
              percentUsed: 10,
              percentRemaining: 90,
              resetsAt: futureReset,
              windowSeconds: 18000,
            },
          ],
          state: {
            status: "fresh",
            stale: false,
            refreshedAt: nowIso,
          },
        },
      ],
    };

    serverHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(producerReport));
    };

    const cacheHome = join(tempDir!, "cache");
    process.env.XDG_CACHE_HOME = cacheHome;

    writeConfig({
      sources: [
        {
          name: "source-cache-test",
          url: `http://127.0.0.1:${serverPort}/export.json`,
          allowInsecureTransport: true,
          supplies: [{ provider: "claude", accountKey: "default" }],
          maxAge: "10m",
        },
      ],
    });

    const local = mockEmptyLocalProviders();
    try {
      // 1. Initial read with fresh source
      await quotaCommand(["--provider", "claude", "--json"], undefined);

      const cacheFile = join(cacheHome, "quota-axi", "cache-v3.json");
      let cacheContentBefore = "";
      if (existsSync(cacheFile)) {
        cacheContentBefore = readFileSync(cacheFile, "utf8");
      }
      expect(cacheContentBefore).not.toContain("source:source-cache-test");

      // 2. Now fail the server
      serverHandler = (_req, res) => {
        res.writeHead(500);
        res.end();
      };

      // Read again: failing source must NOT serve cached reading!
      const outSecond = await quotaCommand(
        ["--provider", "claude", "--json"],
        undefined,
      );
      const reportSecond: QuotaAxiResponse = JSON.parse(outSecond);
      const lane = reportSecond.providers.find(
        (p) => p.accountKey === "source:source-cache-test:default",
      );
      expect(lane).toBeDefined();
      expect(lane!.state.status).toBe("unavailable");
      expect(lane!.state.error).toBe("source_http_error");
    } finally {
      local.restore();
      delete process.env.XDG_CACHE_HOME;
    }
  });

  it("--provider scoping: source supplying claude is not contacted under --provider codex", async () => {
    writeConfig({
      sources: [
        {
          name: "claude-only-source",
          url: `http://127.0.0.1:${serverPort}/export.json`,
          allowInsecureTransport: true,
          supplies: [{ provider: "claude", accountKey: "default" }],
          maxAge: "10m",
        },
      ],
    });

    const local = mockEmptyLocalProviders();
    try {
      await quotaCommand(["--provider", "codex", "--json"], undefined);
      expect(requestCount).toBe(0);
    } finally {
      local.restore();
    }
  });

  it("makes only one request per source even when it supplies two providers", async () => {
    const now = new Date().toISOString();
    serverHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          generatedAt: now,
          schemaVersion: 6,
          providers: [
            {
              provider: "claude",
              accountKey: "default",
              accountKeys: ["default"],
              label: "Claude",
              source: "oauth",
              windows: [],
              state: { status: "fresh", stale: false, refreshedAt: now },
            },
            {
              provider: "codex",
              accountKey: "default",
              accountKeys: ["default"],
              label: "Codex",
              source: "oauth",
              windows: [],
              state: { status: "fresh", stale: false, refreshedAt: now },
            },
          ],
        }),
      );
    };

    writeConfig({
      sources: [
        {
          name: "multi-provider-source",
          url: `http://127.0.0.1:${serverPort}/export.json`,
          allowInsecureTransport: true,
          supplies: [
            { provider: "claude", accountKey: "default" },
            { provider: "codex", accountKey: "default" },
          ],
          maxAge: "10m",
        },
      ],
    });

    const local = mockEmptyLocalProviders();
    try {
      await quotaCommand(["--provider", "claude,codex", "--json"], undefined);
      expect(requestCount).toBe(1);
    } finally {
      local.restore();
    }
  });

  it("--no-sources and auth make zero source requests", async () => {
    writeConfig({
      sources: [
        {
          name: "test-source",
          url: `http://127.0.0.1:${serverPort}/export.json`,
          allowInsecureTransport: true,
          supplies: [{ provider: "claude", accountKey: "default" }],
          maxAge: "10m",
        },
      ],
    });

    const local = mockEmptyLocalProviders();
    try {
      // 1. --no-sources
      await quotaCommand(
        ["--provider", "claude", "--no-sources", "--json"],
        undefined,
      );
      expect(requestCount).toBe(0);

      // 2. auth
      await authCommand(["--provider", "claude", "--json"], undefined);
      expect(requestCount).toBe(0);
    } finally {
      local.restore();
    }
  });
});
