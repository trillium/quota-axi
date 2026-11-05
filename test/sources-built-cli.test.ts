import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const BUILT_CLI = resolve("dist/bin/quota-axi.js");

function runCli(
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const env = { ...process.env, ...envOverrides };
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    const child = spawn(process.execPath, [BUILT_CLI, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (status) => res({ status, stdout, stderr }));
  });
}

describe("custom quota sources built CLI", () => {
  let root: string | undefined;
  let server: Server | undefined;
  let serverPort: number = 0;
  let serverRequests = 0;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "quota-axi-sources-built-cli-"));
    serverRequests = 0;
    server = createServer((_req, res) => {
      serverRequests++;
      const now = new Date().toISOString();
      const futureReset = new Date(Date.now() + 3600_000).toISOString();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          generatedAt: now,
          schemaVersion: 6,
          providers: [
            {
              provider: "claude",
              accountKey: "account_remote",
              accountKeys: ["account_remote"],
              label: "Claude",
              source: "oauth",
              plan: "max",
              windows: [
                {
                  id: "five_hour",
                  label: "5h",
                  kind: "session",
                  percentUsed: 25,
                  percentRemaining: 75,
                  resetsAt: futureReset,
                  windowSeconds: 18000,
                },
              ],
              state: {
                status: "fresh",
                stale: false,
                refreshedAt: now,
              },
            },
          ],
        }),
      );
    });

    await new Promise<void>((res) => {
      server!.listen(0, "127.0.0.1", () => {
        const addr = server!.address();
        serverPort = typeof addr === "object" && addr ? addr.port : 0;
        res();
      });
    });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((res) => server!.close(() => res()));
      server = undefined;
    }
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it("--export emits schema 5 or 6 JSON without sensitive fields", async () => {
    const configDir = join(root!, "config", "quota-axi");
    mkdirSync(configDir, { recursive: true });

    const proc = await runCli(["--export", "--provider", "claude"], {
      XDG_CONFIG_HOME: join(root!, "config"),
    });

    const parsed = JSON.parse(proc.stdout);
    expect([5, 6]).toContain(parsed.schemaVersion);
    expect(parsed.providers).toBeInstanceOf(Array);
  }, 20_000);

  it("reads declared URL and file sources and renders extra lane in TOON and JSON", async () => {
    const filePath = join(root!, "exported.json");
    const now = new Date().toISOString();
    const futureReset = new Date(Date.now() + 3600_000).toISOString();
    writeFileSync(
      filePath,
      JSON.stringify({
        generatedAt: now,
        schemaVersion: 6,
        providers: [
          {
            provider: "claude",
            accountKey: "account_file",
            accountKeys: ["account_file"],
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
            state: { status: "fresh", stale: false, refreshedAt: now },
          },
        ],
      }),
      "utf8",
    );

    const configDir = join(root!, "config", "quota-axi");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify(
        {
          sources: [
            {
              name: "remote-peer",
              url: `http://127.0.0.1:${serverPort}/export.json`,
              allowInsecureTransport: true,
              supplies: [{ provider: "claude", accountKey: "account_remote" }],
              maxAge: "10m",
            },
            {
              name: "local-file-peer",
              file: filePath,
              supplies: [{ provider: "claude", accountKey: "account_file" }],
              maxAge: "10m",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    // 1. JSON output
    const jsonProc = await runCli(["--json", "--provider", "claude"], {
      XDG_CONFIG_HOME: join(root!, "config"),
    });
    expect(jsonProc.status).toBe(0);
    const parsed = JSON.parse(jsonProc.stdout);
    const urlLane = parsed.providers.find(
      (p: any) => p.accountKey === "source:remote-peer:account_remote",
    );
    expect(urlLane).toBeDefined();
    expect(urlLane.state.importedFrom).toBe("remote-peer");
    expect(urlLane.state.status).toBe("fresh");

    const fileLane = parsed.providers.find(
      (p: any) => p.accountKey === "source:local-file-peer:account_file",
    );
    expect(fileLane).toBeDefined();
    expect(fileLane.state.importedFrom).toBe("local-file-peer");
    expect(fileLane.state.status).toBe("fresh");

    // 2. TOON output
    const toonProc = await runCli(["--provider", "claude"], {
      XDG_CONFIG_HOME: join(root!, "config"),
    });
    expect(toonProc.status).toBe(0);
    expect(toonProc.stdout).toContain("source:remote-peer:account_remote");
    expect(toonProc.stdout).toContain("remote-peer");
    expect(toonProc.stdout).toContain("source:local-file-peer:account_file");
    expect(toonProc.stdout).toContain("local-file-peer");

    // 3. --no-sources suppresses sources
    serverRequests = 0;
    const noSourcesProc = await runCli(
      ["--json", "--provider", "claude", "--no-sources"],
      {
        XDG_CONFIG_HOME: join(root!, "config"),
      },
    );
    expect(noSourcesProc.status).toBe(1);
    expect(serverRequests).toBe(0);
    const noSourcesParsed = JSON.parse(noSourcesProc.stdout);
    const missingUrl = noSourcesParsed.providers.find(
      (p: any) => p.accountKey === "source:remote-peer:account_remote",
    );
    expect(missingUrl).toBeUndefined();
    const missingFile = noSourcesParsed.providers.find(
      (p: any) => p.accountKey === "source:local-file-peer:account_file",
    );
    expect(missingFile).toBeUndefined();
  }, 30_000);
});
