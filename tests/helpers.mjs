import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const COMPANION_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "opencode",
  "scripts",
  "opencode-companion.mjs"
);

export const STOP_GATE_HOOK_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "opencode",
  "scripts",
  "stop-review-gate-hook.mjs"
);

export function runCompanion(args, options = {}) {
  return spawnSync(process.execPath, [COMPANION_PATH, ...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeout ?? 60000
  });
}

export function runHook(hookPath, input, options = {}) {
  return spawnSync(process.execPath, [hookPath], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    input: JSON.stringify(input),
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeout ?? 60000
  });
}

export function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeGitRepo(prefix = "opencode-plugin-repo-") {
  const dir = makeTempDir(prefix);
  const git = (args) =>
    spawnSync("git", args, { cwd: dir, encoding: "utf8", shell: false });
  git(["init"]);
  git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n", "utf8");
  git(["add", "."]);
  git(["commit", "-m", "init"]);
  return { dir, git };
}

export async function waitFor(predicate, { timeoutMs = 30000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
