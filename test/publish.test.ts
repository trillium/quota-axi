import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { writeCachedProviders } from "../src/cache.js";
import { cacheFilePath } from "../src/lib/fs.js";
import {
  PUBLISH_MAX_AGE_SECONDS,
  SINGLE_QUERIER_RULE,
  buildPublishPayload,
  parsePublishFlags,
  publishCommand,
} from "../src/publish.js";
import { parseSourceReport } from "../src/sources.js";
import type { ProviderId, ProviderQuota } from "../src/types.js";

const env = { ...process.env };
let dir: string;
let server: Server | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "quota-axi-publish-"));
  process.env.XDG_CACHE_HOME = join(dir, "cache");
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  process.exitCode = undefined;
});

afterEach(async () => {
  process.env.XDG_CACHE_HOME = env.XDG_CACHE_HOME;
  if (env.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  process.exitCode = undefined;
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve(),
  );
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function reading(
  provider: ProviderId,
  refreshedAt = new Date().toISOString(),
  resetsAt?: string,
): ProviderQuota {
  return {
    provider,
    label: provider,
    source: "oauth",
    windows: [
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        percentUsed: 30,
        percentRemaining: 70,
        ...(resetsAt ? { resetsAt } : {}),
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt,
      sourcesTried: ["oauth"],
    },
    account: { email: "person@example.invalid", accountId: "acct-1" },
    attempts: [{ source: "oauth", status: "success" }],
  };
}

function writeConfig(publish: unknown): void {
  const file = join(dir, "config", "quota-axi", "config.json");
  mkdirSync(join(dir, "config", "quota-axi"), { recursive: true });
  writeFileSync(file, JSON.stringify({ publish }));
}

async function hub(status = 204): Promise<{ url: string; bodies: string[] }> {
  const bodies: string[] = [];
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      bodies.push(
        `${request.method} ${request.url} ${request.headers.authorization ?? ""}|${Buffer.concat(chunks).toString()}`,
      );
      response.statusCode = status;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/fm_quota/macbook`, bodies };
}

describe("publish", () => {
  it("posts the cached export-tier report to the hub and states the single-querier rule", async () => {
    writeCachedProviders([reading("grok"), reading("cursor")]);
    const { url, bodies } = await hub();
    writeConfig({ url, allowInsecureTransport: true });

    const output = await publishCommand([]);

    expect(bodies).toHaveLength(1);
    const [head, body] = bodies[0].split("|");
    expect(head).toBe("POST /fm_quota/macbook ");
    const parsed = parseSourceReport(body);
    expect(parsed.status).toBe("success");
    const providers = (JSON.parse(body) as { providers: ProviderQuota[] })
      .providers;
    expect(providers.map((p) => p.provider).sort()).toEqual(["cursor", "grok"]);
    expect(body).not.toContain("person@example.invalid");
    expect(body).not.toContain("acct-1");
    expect(body).not.toContain('"attempts"');
    expect(output).toContain("publish: posted");
    expect(output).toContain("providers: 2");
    expect(output).toContain(SINGLE_QUERIER_RULE);
    expect(process.exitCode).toBeUndefined();

    const status = await publishCommand(["--status"]);
    expect(status).toContain("lastAttempt: ok");
    expect(status).toContain("cachedProviders: 2");
    expect(status).toContain(SINGLE_QUERIER_RULE);
    expect(status).toContain(url.replace("http://", "http://"));
    expect(
      statSync(join(cacheFilePath(), "..", "publish-state.json")).mode & 0o777,
    ).toBe(0o600);
  });

  it("never reads a vendor: the publisher module does not import a provider adapter", () => {
    const source = readFileSync(
      join(import.meta.dirname, "..", "src", "publish.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/providers\/(index|accounts|common)/);
    expect(source).not.toMatch(/fetchQuota|fetchAccountQuotas|PROVIDERS/);
  });

  it("leaves out readings whose reset passed or that are older than the publish bound", () => {
    const old = new Date(
      Date.now() - (PUBLISH_MAX_AGE_SECONDS + 60) * 1000,
    ).toISOString();
    writeCachedProviders([
      reading("grok"),
      reading("cursor", old),
      reading(
        "kimi",
        new Date().toISOString(),
        new Date(Date.now() - 1000).toISOString(),
      ),
    ]);
    const { payload } = buildPublishPayload();
    expect(payload.providers.map((p) => p.provider)).toEqual(["grok"]);
  });

  it("reports an empty cache as a failure instead of posting nothing", async () => {
    const { url, bodies } = await hub();
    writeConfig({ url, allowInsecureTransport: true });
    const output = await publishCommand([]);
    expect(bodies).toHaveLength(0);
    expect(output).toContain("publish: failed");
    expect(output).toContain("error: cache_empty");
    expect(process.exitCode).toBe(1);
  });

  it("reports a hub HTTP error and keeps the last success", async () => {
    writeCachedProviders([reading("grok")]);
    const ok = await hub();
    writeConfig({ url: ok.url, allowInsecureTransport: true });
    await publishCommand([]);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    const bad = await hub(500);
    writeConfig({ url: bad.url, allowInsecureTransport: true });
    const output = await publishCommand([]);
    expect(output).toContain("error: hub_http_500");
    expect(process.exitCode).toBe(1);
    const status = await publishCommand(["--status"]);
    expect(status).toMatch(/lastAttempt: failed hub_http_500/);
    expect(status).not.toContain("lastSuccessAt: never");
  });

  it("--dry-run builds the payload and posts nothing", async () => {
    writeCachedProviders([reading("grok")]);
    const { url, bodies } = await hub();
    const output = await publishCommand([
      "--to",
      url,
      "--allow-insecure-transport",
      "--dry-run",
    ]);
    expect(bodies).toHaveLength(0);
    expect(output).toContain("publish: dry_run");
    expect(output).toContain("posted: no");
    expect(output).toContain(SINGLE_QUERIER_RULE);
  });

  it("refuses plain http without opt-in, and a missing target", async () => {
    writeCachedProviders([reading("grok")]);
    await expect(
      publishCommand(["--to", "http://127.0.0.1:1/x"]),
    ).rejects.toThrow(AxiError);
    await expect(publishCommand([])).rejects.toThrow(/No publish target/);
  });

  it("strips userinfo and query from every displayed target and never sends authorization", async () => {
    writeCachedProviders([reading("grok")]);
    const { url, bodies } = await hub();
    const withSecret =
      url.replace("http://", "http://user:pw@") + "?token=hunter2";
    const output = await publishCommand([
      "--to",
      withSecret,
      "--allow-insecure-transport",
    ]);
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("user:pw");
    expect(bodies[0].split("|")[0]).not.toContain("Basic");
  });

  it("rejects unknown flags and unknown config keys", async () => {
    expect(() => parsePublishFlags(["--bogus"])).toThrow(AxiError);
    expect(() => parsePublishFlags(["--status", "--dry-run"])).toThrow(
      AxiError,
    );
    writeConfig({ url: "https://x.invalid/a", extra: 1 });
    await expect(publishCommand(["--status"])).rejects.toThrow(
      /Unknown publish key/,
    );
  });

  it("--status works with nothing configured and makes no request", async () => {
    const output = await publishCommand(["--status"]);
    expect(output).toContain("publisher: not_configured");
    expect(output).toContain("lastAttemptAt: never");
    expect(output).toContain(SINGLE_QUERIER_RULE);
  });
});
