import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { traceInput } from "../lib/input-trace.js";

/** Overrides the directory scanned for Claude setup-token files. */
export const CLAUDE_TOKEN_DIR_ENV = "QUOTA_AXI_CLAUDE_TOKEN_DIR";

/** One setup-token file. The token value is read only on demand, never held. */
export type ClaudeTokenFile = {
  path: string;
  accountKey: string;
  /** Resolves the trimmed token, or undefined when empty or unreadable. */
  read(): string | undefined;
};

export function claudeTokenDir(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[CLAUDE_TOKEN_DIR_ENV]?.trim();
  return value && isAbsolute(value)
    ? value
    : join(homedir(), ".config", "claude-tokens");
}

/**
 * The lane key derives from the token file's name only (conventionally the
 * account email), as a one-way digest: stable across token rotation and
 * directory moves, and it exposes neither the name nor any token content.
 */
export function claudeTokenAccountKey(fileName: string): string {
  return `token:${createHash("sha256")
    .update(JSON.stringify(["claude-token-file-v1", fileName]))
    .digest("hex")
    .slice(0, 24)}`;
}

/** `*.token` regular files in the directory, sorted by name. No contents read. */
export function discoverClaudeTokenFiles(
  dir = claudeTokenDir(),
): ClaudeTokenFile[] {
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter(
        (name) => name.endsWith(".token") && name.length > ".token".length,
      )
      .sort();
  } catch {
    return [];
  }
  const files: ClaudeTokenFile[] = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    files.push({
      path,
      accountKey: claudeTokenAccountKey(basename(path)),
      read: () => {
        traceInput(path);
        try {
          return readFileSync(path, "utf8").trim() || undefined;
        } catch {
          return undefined;
        }
      },
    });
  }
  return files;
}
