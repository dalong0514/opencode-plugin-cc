import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A fake `opencode` CLI used by the runtime tests. The companion resolves it via
// the OPENCODE_COMPANION_BIN env var, so no PATH games or .cmd shims are needed.
// Behavior switches on FAKE_OPENCODE_BEHAVIOR; each invocation is appended to
// FAKE_OPENCODE_LOG as a JSON line {argv, stdin} for assertions.

const FAKE_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");

const argv = process.argv.slice(2);
const behavior = process.env.FAKE_OPENCODE_BEHAVIOR || "task-ok";
const logFile = process.env.FAKE_OPENCODE_LOG || "";

function readStdin() {
  try {
    if (process.stdin.isTTY) return "";
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const stdin = readStdin();
if (logFile) {
  fs.appendFileSync(logFile, JSON.stringify({ argv, stdin }) + "\\n", "utf8");
}

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\\n");
}

const sessionID = process.env.FAKE_OPENCODE_SESSION_ID || "ses_fake0001";

function argValue(flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1] ?? null;
}

async function main() {
  if (argv[0] === "--version") {
    process.stdout.write("9.9.9-fake\\n");
    return 0;
  }

  if (argv[0] === "models") {
    if (behavior === "no-models") {
      return 0;
    }
    if (behavior === "models-fail") {
      process.stderr.write("provider registry unavailable\\n");
      return 1;
    }
    process.stdout.write(["opencode/big-pickle", "deepseek/deepseek-chat", "deepseek/deepseek-v4-pro"].join("\\n") + "\\n");
    return 0;
  }

  if (argv[0] !== "run") {
    process.stderr.write("fake opencode: unknown command " + argv.join(" ") + "\\n");
    return 1;
  }

  const resumed = argValue("--session");
  const activeSession = resumed || sessionID;

  if (behavior === "run-error") {
    emit({ type: "error", timestamp: 1, sessionID: activeSession, error: { name: "ProviderError", data: { message: "model not found" } } });
    return 1;
  }

  if (behavior === "spawn-fail") {
    process.stderr.write("fake opencode: hard failure before any event\\n");
    return 1;
  }

  emit({ type: "step_start", timestamp: 1, sessionID: activeSession, part: { type: "step-start", messageID: "msg_1" } });

  if (behavior === "with-tools" || behavior === "task-ok") {
    emit({
      type: "tool_use",
      timestamp: 2,
      sessionID: activeSession,
      part: { type: "tool", tool: "write", messageID: "msg_1", state: { status: "completed", title: "probe.txt", input: { filePath: "probe.txt" } } }
    });
  }

  if (behavior === "slow-task" || behavior === "interruptible-slow-task") {
    const waitMs = Number(process.env.FAKE_OPENCODE_SLEEP_MS || 4000);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  const reply = process.env.FAKE_OPENCODE_REPLY || (resumed ? "FAKE-RESUMED on " + activeSession : "FAKE-DONE");
  emit({
    type: "text",
    timestamp: 3,
    sessionID: activeSession,
    part: { type: "text", messageID: "msg_2", text: reply, time: { start: 1, end: 2 } }
  });
  emit({
    type: "step_finish",
    timestamp: 4,
    sessionID: activeSession,
    part: { type: "step-finish", messageID: "msg_2", reason: "stop", tokens: { total: 42, input: 10, output: 5 }, cost: 0 }
  });
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(String(error && error.message ? error.message : error) + "\\n");
    process.exit(1);
  }
);
`;

export function installFakeOpencode(baseDir = null) {
  const dir = baseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "fake-opencode-"));
  const scriptPath = path.join(dir, "fake-opencode.cjs");
  fs.writeFileSync(scriptPath, FAKE_SOURCE, "utf8");
  const logFile = path.join(dir, "invocations.jsonl");
  fs.writeFileSync(logFile, "", "utf8");
  return { dir, scriptPath, logFile };
}

export function readInvocations(logFile) {
  if (!fs.existsSync(logFile)) {
    return [];
  }
  return fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function buildEnv(fixture, overrides = {}) {
  return {
    ...process.env,
    OPENCODE_COMPANION_BIN: fixture.scriptPath,
    FAKE_OPENCODE_LOG: fixture.logFile,
    ...overrides
  };
}
