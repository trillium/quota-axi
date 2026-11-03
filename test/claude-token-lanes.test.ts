import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Setup-token lanes: one per `*.token` file under the token directory. All
 * tokens are synthetic fixtures; fetch is stubbed, no network is touched.
 */

let home: string;
let tokenDir: string;
let sent: string[];

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), "quota-claude-token-"));
  tokenDir = join(home, "tokens");
  mkdirSync(tokenDir);
  sent = [];
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("XDG_CACHE_HOME", join(home, "cache"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", undefined);
  vi.stubEnv("QUOTA_AXI_CLAUDE_PROFILES", undefined);
  vi.stubEnv("QUOTA_AXI_CLAUDE_SWAP", undefined);
  vi.stubEnv("QUOTA_AXI_CLAUDE_TOKEN_DIR", tokenDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

function stubFetch(handler: (bearer: string, url: string) => Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).authorization;
      sent.push(auth);
      return handler(auth.replace("Bearer ", ""), url);
    }),
  );
}

const scopeDenied = () =>
  new Response(
    JSON.stringify({
      error: {
        type: "permission_error",
        message: "OAuth token does not meet scope requirement user:profile",
      },
    }),
    { status: 403 },
  );

describe("claude setup-token lanes", () => {
  it("adds nothing when the directory has no token files", async () => {
    writeFileSync(join(tokenDir, "notes.txt"), "x");
    const { claudeAdapter } = await import("../src/providers/claude.js");
    expect(await claudeAdapter.discoverAccounts?.()).toBeUndefined();
  });

  it("keys each token file distinctly from its name, never its contents", async () => {
    writeFileSync(
      join(tokenDir, "a@example.invalid.token"),
      "fake-token-aaa\n",
    );
    writeFileSync(
      join(tokenDir, "b@example.invalid.token"),
      "fake-token-bbb\n",
    );
    const { claudeAdapter } = await import("../src/providers/claude.js");
    const accounts = (await claudeAdapter.discoverAccounts?.())!;
    const tokens = accounts.filter((a) => a.locator?.kind === "token-file");
    expect(tokens).toHaveLength(2);
    expect(accounts.length).toBe(tokens.length + 1); // plus the ordinary login
    const keys = tokens.map((a) => a.accountKey);
    expect(new Set(keys).size).toBe(2);
    for (const key of keys) expect(key).toMatch(/^token:[0-9a-f]{24}$/);
    expect(JSON.stringify(keys)).not.toContain("fake-token");

    // Rewriting the token's contents leaves the key unchanged
    writeFileSync(join(tokenDir, "a@example.invalid.token"), "rotated-fake\n");
    vi.resetModules();
    const again = (await (
      await import("../src/providers/claude.js")
    ).claudeAdapter.discoverAccounts?.())!;
    expect(again.map((a) => a.accountKey).sort()).toEqual(
      accounts.map((a) => a.accountKey).sort(),
    );
  });

  it("reports a scope-denied setup token as unmeasured, with no invented numbers", async () => {
    writeFileSync(
      join(tokenDir, "a@example.invalid.token"),
      "fake-token-aaa\n",
    );
    stubFetch(() => scopeDenied());
    const { claudeAdapter } = await import("../src/providers/claude.js");
    const account = (await claudeAdapter.discoverAccounts?.())!.find(
      (a) => a.locator?.kind === "token-file",
    )!;
    const report = (await account.fetchQuota({ refreshCredentials: false }))!;
    expect(report.windows).toEqual([]);
    expect(report.state.status).toBe("unavailable");
    expect(report.state.error).toBe("claude_env_usage_scope_unavailable");
    expect(report.state.authStatus).toBe("usable");
    expect(sent).toEqual(["Bearer fake-token-aaa"]);
    expect(JSON.stringify(report)).not.toContain("fake-token");
  });

  it("reports real windows when a token does carry the usage scope", async () => {
    writeFileSync(
      join(tokenDir, "a@example.invalid.token"),
      "fake-token-aaa\n",
    );
    stubFetch((_bearer, url) =>
      url.endsWith("/profile")
        ? new Response("", { status: 404 })
        : new Response(
            JSON.stringify({
              five_hour: { utilization: 20, resets_at: "2026-10-14T15:00:00Z" },
            }),
          ),
    );
    const { claudeAdapter } = await import("../src/providers/claude.js");
    const account = (await claudeAdapter.discoverAccounts?.())!.find(
      (a) => a.locator?.kind === "token-file",
    )!;
    const report = (await account.fetchQuota({ refreshCredentials: false }))!;
    expect(report.state.status).toBe("fresh");
    expect(report.windows.length).toBeGreaterThan(0);
  });

  it("reports an empty token file without a request", async () => {
    writeFileSync(join(tokenDir, "a@example.invalid.token"), "\n");
    stubFetch(() => scopeDenied());
    const { claudeAdapter } = await import("../src/providers/claude.js");
    const account = (await claudeAdapter.discoverAccounts?.())!.find(
      (a) => a.locator?.kind === "token-file",
    )!;
    const report = (await account.fetchQuota({ refreshCredentials: false }))!;
    expect(report.state.error).toBe("claude_token_file_empty");
    expect(sent).toEqual([]);
  });
});
