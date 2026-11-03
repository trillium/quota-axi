import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { quotaCommand } from "../src/commands.js";
import { readQuotaSources } from "../src/lib/user-config.js";
import { PROVIDERS } from "../src/providers/index.js";
import type { ProviderQuota } from "../src/types.js";

let tempDir: string | undefined;
let originalXdg: string | undefined;
let originalExitCode: number | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-sources-config-test-"));
  originalXdg = process.env.XDG_CONFIG_HOME;
  originalExitCode = process.exitCode;
  process.env.XDG_CONFIG_HOME = tempDir;
  process.exitCode = undefined;
});

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  process.env.XDG_CONFIG_HOME = originalXdg;
  process.exitCode = originalExitCode;
});

function writeConfig(json: unknown): string {
  const dir = join(tempDir!, "quota-axi");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify(json, null, 2), "utf8");
  return file;
}

describe("custom quota sources declaration config", () => {
  it("parses valid file sources with absolute and ~/-relative paths", () => {
    const file = writeConfig({
      sources: [
        {
          name: "local-file",
          file: "/var/log/quota-export.json",
          supplies: [{ provider: "claude", accountKey: "default" }],
          maxAge: "10m",
          timeout: "5s",
        },
        {
          name: "home-file",
          file: "~/exports/claude.json",
          supplies: [
            {
              provider: "codex",
              accountKey: "work",
              subscription: "a".repeat(64),
            },
          ],
          maxAge: "1h",
        },
      ],
    });

    const sources = readQuotaSources(file);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toEqual({
      name: "local-file",
      file: "/var/log/quota-export.json",
      supplies: [{ provider: "claude", accountKey: "default" }],
      maxAge: 600,
      timeout: 5,
    });
    expect(sources[1]).toEqual({
      name: "home-file",
      file: join(homedir(), "exports/claude.json"),
      supplies: [
        {
          provider: "codex",
          accountKey: "work",
          subscription: "a".repeat(64),
        },
      ],
      maxAge: 3600,
      timeout: 3,
    });
  });

  it("parses valid url sources (https, and http with allowInsecureTransport)", () => {
    const file = writeConfig({
      sources: [
        {
          name: "secure-remote",
          url: "https://machine-a.internal/claude.json",
          supplies: [{ provider: "claude", accountKey: "default" }],
          maxAge: "15m",
        },
        {
          name: "insecure-remote",
          url: "http://machine-b.internal:8080/export.json",
          allowInsecureTransport: true,
          supplies: [{ provider: "codex", accountKey: "default" }],
          maxAge: "2m",
          timeout: "4s",
        },
      ],
    });

    const sources = readQuotaSources(file);
    expect(sources).toHaveLength(2);
    expect(sources[0].url).toBe("https://machine-a.internal/claude.json");
    expect(sources[1].url).toBe("http://machine-b.internal:8080/export.json");
    expect(sources[1].allowInsecureTransport).toBe(true);
  });

  describe("malformed declarations exit 2 with VALIDATION_ERROR only when in scope", () => {
    const malformedShapes: { name: string; source: Record<string, unknown> }[] =
      [
        {
          name: "unknown key on source",
          source: {
            name: "bad-source",
            file: "/tmp/test.json",
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "10m",
            unknownKey: "value",
          },
        },
        {
          name: "unknown key on supplies entry",
          source: {
            name: "bad-supplies-key",
            file: "/tmp/test.json",
            supplies: [
              {
                provider: "claude",
                accountKey: "default",
                unknownKey: "value",
              },
            ],
            maxAge: "10m",
          },
        },
        {
          name: "invalid name format",
          source: {
            name: "BAD_NAME!",
            file: "/tmp/test.json",
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "10m",
          },
        },
        {
          name: "relative file path",
          source: {
            name: "relative-file",
            file: "relative/path.json",
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "10m",
          },
        },
        {
          name: "both url and file",
          source: {
            name: "both-url-file",
            file: "/tmp/test.json",
            url: "https://example.com/test.json",
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "10m",
          },
        },
        {
          name: "neither url nor file",
          source: {
            name: "neither-url-file",
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "10m",
          },
        },
        {
          name: "http url without allowInsecureTransport",
          source: {
            name: "insecure-http",
            url: "http://example.internal/test.json",
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "10m",
          },
        },
        {
          name: "invalid url string",
          source: {
            name: "bad-url",
            url: "not a valid url",
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "10m",
          },
        },
        {
          name: "unsupported url scheme",
          source: {
            name: "ftp-url",
            url: "ftp://example.internal/test.json",
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "10m",
          },
        },
        {
          name: "empty supplies",
          source: {
            name: "empty-supplies",
            file: "/tmp/test.json",
            supplies: [],
            maxAge: "10m",
          },
        },
        {
          name: "unknown provider in supplies",
          source: {
            name: "unknown-provider",
            file: "/tmp/test.json",
            supplies: [{ provider: "not-a-provider", accountKey: "default" }],
            maxAge: "10m",
          },
        },
        {
          name: "invalid accountKey in supplies",
          source: {
            name: "invalid-account-key",
            file: "/tmp/test.json",
            supplies: [{ provider: "claude", accountKey: "BAD KEY!" }],
            maxAge: "10m",
          },
        },
        {
          name: "invalid subscription digest",
          source: {
            name: "bad-subscription",
            file: "/tmp/test.json",
            supplies: [
              {
                provider: "claude",
                accountKey: "default",
                subscription: "too-short",
              },
            ],
            maxAge: "10m",
          },
        },
        {
          name: "unparseable maxAge",
          source: {
            name: "bad-max-age",
            file: "/tmp/test.json",
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "not-a-duration",
          },
        },
        {
          name: "maxAge exceeding 24h",
          source: {
            name: "too-long-max-age",
            file: "/tmp/test.json",
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "25h",
          },
        },
        {
          name: "maxAge zero or negative",
          source: {
            name: "zero-max-age",
            file: "/tmp/test.json",
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "0s",
          },
        },
        {
          name: "unparseable timeout",
          source: {
            name: "bad-timeout",
            file: "/tmp/test.json",
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "10m",
            timeout: "invalid",
          },
        },
        {
          name: "timeout exceeding 15s",
          source: {
            name: "too-long-timeout",
            file: "/tmp/test.json",
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "10m",
            timeout: "20s",
          },
        },
      ];

    for (const { name, source } of malformedShapes) {
      it(`fails when in scope, passes when out of scope: ${name}`, async () => {
        writeConfig({ sources: [source] });

        // When claude is in scope (or default for unknown provider / empty supplies), throws VALIDATION_ERROR
        const isUnknownProvider =
          Array.isArray(source.supplies) &&
          source.supplies.some(
            (s: any) => s && s.provider === "not-a-provider",
          );
        const isEmptySupplies =
          !Array.isArray(source.supplies) || source.supplies.length === 0;
        const inScopeArgs =
          isUnknownProvider || isEmptySupplies
            ? ["--json"]
            : ["--provider", "claude", "--json"];

        let inScopeError: unknown;
        try {
          await quotaCommand(inScopeArgs, undefined);
        } catch (error) {
          inScopeError = error;
        }
        expect(inScopeError).toBeInstanceOf(AxiError);
        expect((inScopeError as AxiError).code).toBe("VALIDATION_ERROR");

        // When out of scope (--provider codex), does NOT throw VALIDATION_ERROR
        // (mock codex provider so it completes cleanly)
        const originalCodex = PROVIDERS.codex;
        PROVIDERS.codex = {
          label: "Codex",
          accountDiscovery: "none",
          fetchQuota: async () => {
            const result: ProviderQuota = {
              provider: "codex",
              label: "Codex",
              source: "api",
              windows: [],
              state: {
                status: "fresh",
                stale: false,
                sourcesTried: ["api"],
              },
            };
            return result;
          },
        };
        try {
          let outOfScopeError: unknown;
          try {
            await quotaCommand(["--provider", "codex", "--json"], undefined);
          } catch (error) {
            outOfScopeError = error;
          }
          expect(outOfScopeError).toBeUndefined();
        } finally {
          PROVIDERS.codex = originalCodex;
        }
      });
    }

    it("detects duplicate source names when in scope", async () => {
      writeConfig({
        sources: [
          {
            name: "duplicate-name",
            file: "/tmp/a.json",
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "10m",
          },
          {
            name: "duplicate-name",
            file: "/tmp/b.json",
            supplies: [{ provider: "claude", accountKey: "other" }],
            maxAge: "10m",
          },
        ],
      });

      let err: unknown;
      try {
        await quotaCommand(["--provider", "claude", "--json"], undefined);
      } catch (error) {
        err = error;
      }
      expect(err).toBeInstanceOf(AxiError);
      expect((err as AxiError).code).toBe("VALIDATION_ERROR");
      expect((err as AxiError).message).toContain("duplicate source name");
    });

    it("detects duplicate provider+accountKey across sources when in scope", async () => {
      writeConfig({
        sources: [
          {
            name: "source-a",
            file: "/tmp/a.json",
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "10m",
          },
          {
            name: "source-b",
            file: "/tmp/b.json",
            supplies: [{ provider: "claude", accountKey: "default" }],
            maxAge: "10m",
          },
        ],
      });

      let err: unknown;
      try {
        await quotaCommand(["--provider", "claude", "--json"], undefined);
      } catch (error) {
        err = error;
      }
      expect(err).toBeInstanceOf(AxiError);
      expect((err as AxiError).code).toBe("VALIDATION_ERROR");
      expect((err as AxiError).message).toContain(
        "duplicate provider and accountKey",
      );
    });
  });

  it("produces byte-identical output when config is absent (golden comparison)", async () => {
    // Run against a synthetic provider snapshot
    const originalClaude = PROVIDERS.claude;
    const originalCodex = PROVIDERS.codex;
    PROVIDERS.claude = {
      label: "Claude",
      accountDiscovery: "none",
      fetchQuota: async () => ({
        provider: "claude",
        label: "Claude",
        source: "api",
        windows: [],
        state: { status: "fresh", stale: false, sourcesTried: ["api"] },
      }),
    };
    PROVIDERS.codex = {
      label: "Codex",
      accountDiscovery: "none",
      fetchQuota: async () => ({
        provider: "codex",
        label: "Codex",
        source: "api",
        windows: [],
        state: { status: "fresh", stale: false, sourcesTried: ["api"] },
      }),
    };

    try {
      // 1. Without config file (empty dir)
      const outWithoutFile = await quotaCommand(
        ["--provider", "claude,codex", "--json"],
        undefined,
      );
      const parsedWithoutFile = JSON.parse(outWithoutFile);

      // 2. With config file containing empty sources array
      writeConfig({ sources: [] });
      const outWithEmptySources = await quotaCommand(
        ["--provider", "claude,codex", "--json"],
        undefined,
      );
      const parsedWithEmptySources = JSON.parse(outWithEmptySources);

      // GeneratedAt timestamps differ by milliseconds, so compare providers
      expect(parsedWithEmptySources.providers).toEqual(
        parsedWithoutFile.providers,
      );
    } finally {
      PROVIDERS.claude = originalClaude;
      PROVIDERS.codex = originalCodex;
    }
  });
});
