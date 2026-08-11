import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildBigPickleWindows,
  createBigPickleAdapter,
  DAILY_CAP,
  FIVE_HOUR_CAP,
  parseUsageRow,
  type BigPickleUsage,
} from "../../src/providers/bigpickle.js";

const NOW_MS = 1_700_000_000_000;
const HOUR_MS = 60 * 60 * 1_000;
const noAuthOptions = { allowKeychainPrompt: false };

const sqlite3Available = detectSqlite3();

function detectSqlite3(): boolean {
  try {
    execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("buildBigPickleWindows", () => {
  it("encodes the 5-hour and 24-hour estimated windows", () => {
    const usage: BigPickleUsage = {
      fiveHour: { count: 703, oldestMs: NOW_MS - HOUR_MS },
      daily: { count: 250, oldestMs: NOW_MS - 20 * HOUR_MS },
    };
    const windows = buildBigPickleWindows(usage, NOW_MS);

    expect(windows).toMatchObject([
      {
        id: "five_hour",
        label: "5-hour",
        kind: "session",
        percentUsed: 100,
        percentRemaining: 0,
        windowSeconds: 5 * 60 * 60,
        resetsAt: new Date(NOW_MS - HOUR_MS + 5 * HOUR_MS).toISOString(),
      },
      {
        id: "daily",
        label: "24-hour",
        kind: "unknown",
        percentUsed: 25,
        percentRemaining: 75,
        windowSeconds: 24 * 60 * 60,
        resetsAt: new Date(NOW_MS - 20 * HOUR_MS + 24 * HOUR_MS).toISOString(),
      },
    ]);
  });

  it("clamps usage above the observed cap and omits reset when the window is empty", () => {
    const usage: BigPickleUsage = {
      fiveHour: { count: FIVE_HOUR_CAP + 200 },
      daily: { count: 0 },
    };
    const [fiveHour, daily] = buildBigPickleWindows(usage, NOW_MS);

    expect(fiveHour.percentUsed).toBe(100);
    expect(fiveHour.percentRemaining).toBe(0);
    expect(fiveHour.resetsAt).toBeUndefined();
    expect(daily.percentUsed).toBe(0);
    expect(daily.percentRemaining).toBe(100);
    expect(DAILY_CAP).toBe(1000);
  });
});

describe("parseUsageRow", () => {
  it("parses a populated aggregate row", () => {
    const usage = parseUsageRow(
      `703|${NOW_MS - HOUR_MS}|1044|${NOW_MS - 10 * HOUR_MS}\n`,
    );
    expect(usage).toEqual({
      fiveHour: { count: 703, oldestMs: NOW_MS - HOUR_MS },
      daily: { count: 1044, oldestMs: NOW_MS - 10 * HOUR_MS },
    });
  });

  it("treats empty/NULL fields as zero counts with no oldest timestamp", () => {
    expect(parseUsageRow("0|||\n")).toEqual({
      fiveHour: { count: 0, oldestMs: undefined },
      daily: { count: 0, oldestMs: undefined },
    });
    expect(parseUsageRow("")).toEqual({
      fiveHour: { count: 0, oldestMs: undefined },
      daily: { count: 0, oldestMs: undefined },
    });
  });
});

describe("bigpickle adapter (mocked read layer)", () => {
  it("reports fresh, locally-derived windows when the DB is readable", async () => {
    const adapter = createBigPickleAdapter({
      resolveDbPath: () => "/fake/opencode.db",
      fileExists: () => true,
      sqlite3Available: async () => true,
      readUsage: async () => ({
        fiveHour: { count: 100, oldestMs: NOW_MS - HOUR_MS },
        daily: { count: 500, oldestMs: NOW_MS - 12 * HOUR_MS },
      }),
      now: () => NOW_MS,
    });

    const quota = await adapter.fetchQuota(noAuthOptions);

    expect(quota.provider).toBe("bigpickle");
    expect(quota.source).toBe("local");
    expect(quota.state.status).toBe("fresh");
    expect(quota.state.stale).toBe(false);
    expect(quota.windows.map((w) => w.id)).toEqual(["five_hour", "daily"]);
    expect(quota.attempts).toEqual([
      { source: "opencode-db", status: "success" },
    ]);
  });

  it("returns unavailable (not a throw) when sqlite3 is missing", async () => {
    const adapter = createBigPickleAdapter({
      sqlite3Available: async () => false,
      fileExists: () => true,
      readUsage: async () => {
        throw new Error("must not be called");
      },
    });

    const quota = await adapter.fetchQuota(noAuthOptions);
    expect(quota.state.status).toBe("unavailable");
    expect(quota.state.error).toBe("sqlite3_unavailable");
    expect(quota.windows).toEqual([]);
  });

  it("returns unavailable when the DB is missing", async () => {
    const adapter = createBigPickleAdapter({
      sqlite3Available: async () => true,
      fileExists: () => false,
      readUsage: async () => {
        throw new Error("must not be called");
      },
    });

    const quota = await adapter.fetchQuota(noAuthOptions);
    expect(quota.state.status).toBe("unavailable");
    expect(quota.state.error).toBe("database_missing");
    expect(quota.windows).toEqual([]);
  });

  it("returns unavailable (not a throw) when the read fails", async () => {
    const adapter = createBigPickleAdapter({
      sqlite3Available: async () => true,
      fileExists: () => true,
      readUsage: async () => {
        throw new Error("boom");
      },
    });

    const quota = await adapter.fetchQuota(noAuthOptions);
    expect(quota.state.status).toBe("unavailable");
    expect(quota.state.error).toBe("database_read_error");
    expect(quota.windows).toEqual([]);
  });

  it("inspects the local DB source without reading any secret", async () => {
    const available = await createBigPickleAdapter({
      resolveDbPath: () => "/fake/opencode.db",
      sqlite3Available: async () => true,
      fileExists: () => true,
    }).inspectAuth(noAuthOptions);
    expect(available).toEqual({
      provider: "bigpickle",
      sources: [
        {
          source: "opencode-db",
          path: "/fake/opencode.db",
          status: "available",
        },
      ],
    });

    const missing = await createBigPickleAdapter({
      resolveDbPath: () => "/fake/opencode.db",
      sqlite3Available: async () => true,
      fileExists: () => false,
    }).inspectAuth(noAuthOptions);
    expect(missing.sources[0].status).toBe("missing");

    const skipped = await createBigPickleAdapter({
      resolveDbPath: () => "/fake/opencode.db",
      sqlite3Available: async () => false,
    }).inspectAuth(noAuthOptions);
    expect(skipped.sources[0]).toMatchObject({
      status: "skipped",
      error: "sqlite3_unavailable",
    });
  });
});

describe.skipIf(!sqlite3Available)(
  "bigpickle adapter (real read-only SQLite fixture)",
  () => {
    let dir: string;
    let dbPath: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "quota-axi-bigpickle-"));
      dbPath = join(dir, "opencode.db");
      const bp = (ms: number, provider = "opencode", model = "big-pickle") =>
        `INSERT INTO message VALUES ('${ms}','s', ${ms}, ${ms}, ` +
        `'{"modelID":"${model}","providerID":"${provider}"}');`;
      const script = [
        "CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);",
        bp(NOW_MS - 1 * HOUR_MS), // in 5h + 24h
        bp(NOW_MS - 2 * HOUR_MS), // in 5h + 24h (oldest in 5h)
        bp(NOW_MS - 10 * HOUR_MS), // in 24h only (oldest in 24h)
        bp(NOW_MS - 30 * HOUR_MS), // outside both windows
        bp(NOW_MS - 1 * HOUR_MS, "opencode", "some-other-model"), // wrong model
        bp(NOW_MS - 1 * HOUR_MS, "anthropic"), // wrong provider
      ].join("\n");
      execFileSync("sqlite3", [dbPath, script]);
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("counts only big-pickle/opencode rows inside each trailing window", async () => {
      const adapter = createBigPickleAdapter({
        resolveDbPath: () => dbPath,
        now: () => NOW_MS,
      });
      const quota = await adapter.fetchQuota(noAuthOptions);

      expect(quota.state.status).toBe("fresh");
      const [fiveHour, daily] = quota.windows;
      expect(fiveHour.resetsAt).toBe(
        new Date(NOW_MS - 2 * HOUR_MS + 5 * HOUR_MS).toISOString(),
      );
      expect(daily.resetsAt).toBe(
        new Date(NOW_MS - 10 * HOUR_MS + 24 * HOUR_MS).toISOString(),
      );
      // 2 requests in the 5h window, 3 in the 24h window.
      expect(fiveHour.percentUsed).toBe(Math.round((2 / FIVE_HOUR_CAP) * 100));
      expect(daily.percentUsed).toBe(Math.round((3 / DAILY_CAP) * 100));
    });
  },
);
