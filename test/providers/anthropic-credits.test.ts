import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withQuotaSemantics } from "../../src/interpretation.js";
import {
  buildCreditWindows,
  createAnthropicCreditsAdapter,
  parseDeclaredCredits,
} from "../../src/providers/anthropic-credits.js";
import { renderQuotaToon } from "../../src/render.js";
import { renderQuotaTui } from "../../src/tui.js";

const NOW = Date.parse("2026-11-02T18:00:00Z");
const options = { allowKeychainPrompt: false };
const PRODUCTS = ["Agent SDK", "API", "Batch API"];

const declared = {
  credits: {
    asOf: "2026-11-02",
    grants: [
      {
        remainingUsd: 153.26,
        totalUsd: 153.26,
        grantedAt: "2026-10-25",
        expiresAt: "2026-11-28",
        appliesTo: PRODUCTS,
      },
      {
        remainingUsd: 75.43,
        totalUsd: 100,
        grantedAt: "2026-10-18",
        expiresAt: "2026-11-11",
        appliesTo: PRODUCTS,
      },
    ],
  },
};

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "quota-axi-credits-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function adapterFor(config: unknown, now = NOW) {
  const path = join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    path,
    typeof config === "string" ? config : JSON.stringify(config),
  );
  return createAnthropicCreditsAdapter({
    configPath: () => path,
    now: () => now,
  });
}

describe("anthropic credits provider", () => {
  it("reports declared grants soonest-expiry first with amounts, products and expiry", async () => {
    const report = await adapterFor(declared).fetchQuota(options);

    expect(report).toMatchObject({
      provider: "anthropic-api",
      source: "local",
      credits: { remaining: 228.69, unit: "usd" },
      declared: { basis: "declared", asOf: "2026-11-02", stale: false },
      state: { status: "fresh", stale: false },
    });
    expect(report.windows).toMatchObject([
      {
        id: "grant:2026-11-11",
        kind: "credits",
        spentUsd: 24.57,
        limitUsd: 100,
        percentRemaining: 75,
        resetsAt: "2026-11-11T00:00:00.000Z",
        startsAt: "2026-10-18T00:00:00.000Z",
        appliesTo: PRODUCTS,
      },
      { id: "grant:2026-11-28", limitUsd: 153.26, percentRemaining: 100 },
    ]);
  });

  it("drops a grant at or past its expiry", () => {
    const grants = parseDeclaredCredits(declared)!.grants;
    const windows = buildCreditWindows(
      grants,
      Date.parse("2026-11-11T00:00:00Z"),
    );
    expect(windows.map(({ id }) => id)).toEqual(["grant:2026-11-28"]);
  });

  it("flags a declared value older than 7 days as stale", async () => {
    const report = await adapterFor(declared, NOW + 8 * 86_400_000).fetchQuota(
      options,
    );
    expect(report.state).toMatchObject({
      status: "stale",
      stale: true,
      error: "declared_value_stale",
    });
    expect(report.declared).toMatchObject({ stale: true, ageDays: 8 });
    const interpreted = withQuotaSemantics(report, "2026-11-10T18:00:00Z");
    expect(interpreted.quotaSemantics?.effectiveAvailability[0]).toMatchObject({
      status: "unknown",
    });
  });

  it("is not stale at exactly seven days", async () => {
    const report = await adapterFor(declared, NOW + 5 * 86_400_000).fetchQuota(
      options,
    );
    expect(report.declared?.stale).toBe(false);
  });

  it("is unavailable, without throwing, when nothing is declared", async () => {
    const missing = createAnthropicCreditsAdapter({
      configPath: () => join(dir, "absent.json"),
    });
    expect(await missing.fetchQuota(options)).toMatchObject({
      state: { status: "unavailable", error: "credits_not_declared" },
    });
    expect(await adapterFor({ other: 1 }).fetchQuota(options)).toMatchObject({
      state: { status: "unavailable", error: "credits_not_declared" },
    });
    expect(await adapterFor("{nope").fetchQuota(options)).toMatchObject({
      state: { status: "unavailable", error: "config_invalid" },
    });
    expect(
      await adapterFor({
        credits: { asOf: "2026-11-02", grants: [{ remainingUsd: 5 }] },
      }).fetchQuota(options),
    ).toMatchObject({
      state: { status: "unavailable", error: "credits_invalid" },
    });
  });

  it("rejects remaining above total", () => {
    expect(
      parseDeclaredCredits({
        credits: {
          asOf: "2026-11-02",
          grants: [{ remainingUsd: 9, totalUsd: 5, expiresAt: "2026-12-01" }],
        },
      }),
    ).toBeUndefined();
  });

  it("pools the balance and anchors runway on the earliest expiry", async () => {
    const report = await adapterFor(declared).fetchQuota(options);
    const interpreted = withQuotaSemantics(report, "2026-11-02T18:00:00Z");
    const [effective] = interpreted.quotaSemantics!.effectiveAvailability;

    expect(effective).toMatchObject({
      scope: "api_credits",
      status: "known",
      effectivePercentRemaining: 90.3,
      limitingWindowIds: ["grant:2026-11-11"],
      runway: { limitingWindowId: "grant:2026-11-11" },
    });
  });

  it("projects exhaustion before expiry when the earliest grant burns fast", async () => {
    const fast = {
      credits: {
        asOf: "2026-11-02",
        grants: [
          {
            remainingUsd: 10,
            totalUsd: 100,
            grantedAt: "2026-10-30",
            expiresAt: "2026-11-30",
            appliesTo: PRODUCTS,
          },
        ],
      },
    };
    const report = await adapterFor(fast).fetchQuota(options);
    const [effective] = withQuotaSemantics(report, "2026-11-02T18:00:00Z")
      .quotaSemantics!.effectiveAvailability;
    expect(effective.runway).toMatchObject({
      status: "projected_exhaustion",
      limitingWindowId: "grant:2026-11-30",
    });
  });

  it("renders declared basis, as-of date and products in TOON, JSON and TUI", async () => {
    const report = withQuotaSemantics(
      await adapterFor(declared).fetchQuota(options),
      "2026-11-02T18:00:00Z",
    );
    const response = {
      generatedAt: "2026-11-02T18:00:00Z",
      schemaVersion: 3 as const,
      providers: [report],
    };

    const toon = renderQuotaToon(response, "quota-axi", false);
    expect(toon).toContain("credits[2]");
    expect(toon).toContain("75.43,100,Agent SDK + API + Batch API");
    expect(toon).toContain("declared,2026-11-02,false");

    expect(JSON.parse(JSON.stringify(response)).providers[0].declared).toEqual(
      report.declared,
    );

    const tui = renderQuotaTui(response, { columns: 100 });
    expect(tui).toContain("declared 2026-11-02, not measured");
    expect(tui).toContain("$75.43");
    expect(tui).toContain("covers Agent SDK, API, Batch API");
  });

  it("reports the config source in auth inspection", async () => {
    const adapter = adapterFor(declared);
    const auth = await adapter.inspectAuth(options);
    expect(auth).toMatchObject({
      provider: "anthropic-api",
      sources: [{ source: "config:credits", status: "available" }],
    });
  });
});
