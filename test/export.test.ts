import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { authCommand } from "../src/commands.js";
import { quotaExportReport } from "../src/render.js";
import { parseFlags, parseModelsFlags } from "../src/args.js";
import { subscriptionIdentity } from "../src/cache.js";
import { sourceLanes } from "../src/sources.js";
import type { ProviderQuota, QuotaAxiResponse } from "../src/types.js";

describe("--export output tier", () => {
  it("parses --export as quota flag implying --json and rejecting --tui", () => {
    const flags = parseFlags(["--provider", "claude", "--export"]);
    expect(flags.export).toBe(true);
    expect(flags.json).toBe(true);

    expect(() =>
      parseFlags(["--provider", "claude", "--export", "--tui"]),
    ).toThrow(AxiError);
  });

  it("is rejected by models and auth commands", async () => {
    expect(() =>
      parseModelsFlags(["--provider", "claude", "--export"]),
    ).toThrow(AxiError);

    await expect(
      authCommand(["--provider", "claude", "--export"], undefined),
    ).rejects.toThrow(AxiError);
  });

  it("contains derivation inputs and subscription, but excludes identity, locators, and attempts", () => {
    const now = new Date().toISOString();
    const futureReset = new Date(Date.now() + 3600_000).toISOString();

    const sampleProvider: ProviderQuota = {
      provider: "claude",
      accountKey: "default",
      accountKeys: ["default"],
      label: "Claude",
      source: "oauth",
      plan: "max",
      account: {
        email: "user@example.com",
        organization: "My Org",
        accountId: "user_12345",
        identityStatus: "verified",
      },
      accountLocator: {
        kind: "config-dir",
        path: "/Users/secret/.claude",
      },
      windows: [
        {
          id: "five_hour",
          label: "5h",
          kind: "session",
          percentUsed: 40,
          percentRemaining: 60,
          startsAt: now,
          resetsAt: futureReset,
          windowSeconds: 18000,
        },
      ],
      credits: {
        remaining: 50,
        unit: "usd",
      },
      state: {
        status: "fresh",
        stale: false,
        refreshedAt: now,
        sourcesTried: ["oauth"],
      },
      attempts: [
        {
          source: "oauth",
          status: "success",
        },
      ],
    };

    const response: QuotaAxiResponse = {
      generatedAt: now,
      schemaVersion: 6,
      providers: [sampleProvider],
    };

    const exported = quotaExportReport(response);
    const serialized = JSON.stringify(exported);

    // Identity, paths, attempts removed
    expect(serialized).not.toContain("user@example.com");
    expect(serialized).not.toContain("My Org");
    expect(serialized).not.toContain("/Users/secret/.claude");
    expect(exported.providers[0].account).toBeUndefined();
    expect(exported.providers[0].accountLocator).toBeUndefined();
    expect(exported.providers[0].attempts).toBeUndefined();

    // Derivation inputs and subscription present
    expect(exported.providers[0].windows[0].windowSeconds).toBe(18000);
    expect(exported.providers[0].windows[0].percentUsed).toBe(40);
    expect(exported.providers[0].windows[0].percentRemaining).toBe(60);
    expect(exported.providers[0].state.refreshedAt).toBe(now);
    expect(exported.providers[0].subscription).toBe(
      subscriptionIdentity(sampleProvider),
    );
    expect(exported.providers[0].credits).toEqual({
      remaining: 50,
      unit: "usd",
    });
  });

  it("omits subscription when account identity is unverified", () => {
    const now = new Date().toISOString();
    const sampleProvider: ProviderQuota = {
      provider: "claude",
      accountKey: "default",
      label: "Claude",
      source: "oauth",
      account: {
        accountId: "temp_id",
        identityStatus: "unverified",
      },
      windows: [],
      state: {
        status: "fresh",
        stale: false,
        refreshedAt: now,
      },
    };

    const exported = quotaExportReport({
      generatedAt: now,
      schemaVersion: 6,
      providers: [sampleProvider],
    });

    expect(exported.providers[0].subscription).toBeUndefined();
  });

  it("round-trips: export consumed as source yields identical windows and derived numbers", () => {
    const clock = Date.now();
    const nowIso = new Date(clock).toISOString();
    const futureReset = new Date(clock + 3600_000).toISOString();

    const sampleProvider: ProviderQuota = {
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
    };

    const exported = quotaExportReport({
      generatedAt: nowIso,
      schemaVersion: 6,
      providers: [sampleProvider],
    });

    // Consume the export as a declared source
    const sourceDeclaration = {
      name: "producer-machine",
      url: "https://producer.internal/export.json",
      supplies: [{ provider: "claude" as const, accountKey: "default" }],
      maxAge: 600,
      timeout: 3,
    };

    const lanes = sourceLanes(
      sourceDeclaration,
      { status: "success", report: exported },
      clock,
    );

    expect(lanes).toHaveLength(1);
    const lane = lanes[0];

    expect(lane.accountKey).toBe("source:producer-machine:default");
    expect(lane.state.status).toBe("fresh");
    expect(lane.state.importedFrom).toBe("producer-machine");
    expect(lane.state.refreshedAt).toBe(nowIso);
    expect(lane.windows).toHaveLength(1);
    expect(lane.windows[0].id).toBe("five_hour");
    expect(lane.windows[0].percentUsed).toBe(50);
    expect(lane.windows[0].percentRemaining).toBe(50);
    expect(lane.windows[0].windowSeconds).toBe(18000);
  });
});
