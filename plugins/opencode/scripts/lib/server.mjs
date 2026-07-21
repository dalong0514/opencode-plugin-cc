import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { buildSpawnSpec, resolveOpencodeBinary } from "./opencode.mjs";
import { terminateProcessTree } from "./process.mjs";
import { resolveStateDir } from "./state.mjs";

// Broker-lite: keep one `opencode serve` warm per workspace and attach runs to
// it. opencode persists session data on its own; what this layer keeps warm is
// the process and provider state that a cold `opencode run` rebuilds every call.
const SERVER_FILE_NAME = "server.json";
const SERVER_PASSWORD_ENV = "OPENCODE_SERVER_PASSWORD";
const DISABLE_ENV = "OPENCODE_COMPANION_NO_SERVER";
const START_TIMEOUT_MS = 12000;
const PROBE_TIMEOUT_MS = 800;
const FAILURE_BACKOFF_MS = 30 * 60 * 1000;
const URL_RE = /(https?:\/\/[^\s"']+)/;

export function serverModeDisabled(env = process.env) {
  const value = env[DISABLE_ENV];
  return value != null && value !== "" && value !== "0" && value !== "false";
}

export function resolveServerFile(cwd) {
  return path.join(resolveStateDir(cwd), SERVER_FILE_NAME);
}

export function readServerRecord(cwd) {
  try {
    return JSON.parse(fs.readFileSync(resolveServerFile(cwd), "utf8"));
  } catch {
    return null;
  }
}

function writeServerRecord(cwd, record) {
  const file = resolveServerFile(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export function clearServerRecord(cwd) {
  try {
    fs.unlinkSync(resolveServerFile(cwd));
  } catch {
    // Already gone.
  }
}

function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error?.code === "EPERM";
  }
}

function parseServerUrl(text) {
  const match = URL_RE.exec(text);
  if (!match) {
    return null;
  }
  try {
    const url = new URL(match[1]);
    if (url.hostname === "0.0.0.0" || url.hostname === "::") {
      url.hostname = "127.0.0.1";
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function probeServer(url, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolve(false);
      return;
    }
    const socket = net.connect({
      host: parsed.hostname,
      port: Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80)
    });
    const finish = (alive) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function markServerFailure(cwd, detail) {
  writeServerRecord(cwd, {
    disabledUntil: Date.now() + FAILURE_BACKOFF_MS,
    lastError: String(detail ?? "").slice(0, 500)
  });
}

const BABYSITTER_PATH = path.resolve(fileURLToPath(new URL("../serve-babysitter.mjs", import.meta.url)));

function startServerProcess(cwd, env, password) {
  const serverEnv = { ...env, [SERVER_PASSWORD_ENV]: password };
  if (process.platform === "win32") {
    // Direct detached spawn would give the launcher shim's re-spawned runtime a
    // visible console window; a non-detached spawn dies with the companion via
    // libuv's kill-on-close job object. The babysitter (see its header comment)
    // avoids both: it runs detached and console-less, and keeps serve under a
    // hidden console. Recorded pid = babysitter pid; taskkill /T reaps the tree.
    return spawn(process.execPath, [BABYSITTER_PATH], {
      cwd,
      env: serverEnv,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
  }

  const binary = resolveOpencodeBinary(env);
  const spec = buildSpawnSpec(binary, ["serve", "--port", "0"]);
  return spawn(spec.command, spec.args, {
    cwd,
    env: serverEnv,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
}

async function waitForServerUrl(child, timeoutMs) {
  return await new Promise((resolve) => {
    let buffered = "";
    let settled = false;
    const finish = (url, detail) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ url, detail });
    };
    const timer = setTimeout(() => finish(null, `no server URL announced within ${timeoutMs} ms: ${buffered}`), timeoutMs);
    const onChunk = (chunk) => {
      buffered += String(chunk);
      const url = parseServerUrl(buffered);
      if (url) {
        finish(url, null);
      }
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.on("error", (error) => finish(null, error.message));
    child.on("exit", (code) => finish(null, `opencode serve exited with status ${code}: ${buffered}`));
  });
}

function detachServerChild(child) {
  child.stdout.removeAllListeners("data");
  child.stderr.removeAllListeners("data");
  child.removeAllListeners("error");
  child.removeAllListeners("exit");
  // Let the parent exit while the server keeps running.
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
}

export async function ensureCompanionServer(cwd, options = {}) {
  const env = options.env ?? process.env;
  const onProgress = options.onProgress ?? null;
  if (serverModeDisabled(env)) {
    return null;
  }

  const record = readServerRecord(cwd);
  if (record?.disabledUntil) {
    if (Date.now() < record.disabledUntil) {
      return null;
    }
    clearServerRecord(cwd);
  } else if (record?.url) {
    if (pidAlive(record.pid) && (await probeServer(record.url))) {
      return record;
    }
    // Stale record: the server died or the port was recycled.
    try {
      terminateProcessTree(record.pid ?? Number.NaN);
    } catch {
      // Best effort.
    }
    clearServerRecord(cwd);
  }

  const password = crypto.randomBytes(16).toString("hex");
  let child;
  try {
    child = startServerProcess(cwd, env, password);
  } catch (error) {
    markServerFailure(cwd, error.message);
    return null;
  }

  const { url, detail } = await waitForServerUrl(child, options.startTimeoutMs ?? START_TIMEOUT_MS);
  if (!url) {
    try {
      terminateProcessTree(child.pid ?? Number.NaN);
    } catch {
      // Best effort.
    }
    markServerFailure(cwd, detail);
    onProgress?.({ message: `opencode server unavailable, falling back to per-run mode (${detail})`, phase: "starting" });
    return null;
  }

  detachServerChild(child);
  const nextRecord = {
    pid: child.pid,
    url,
    password,
    startedAt: new Date().toISOString(),
    startedBySession: env.OPENCODE_COMPANION_SESSION_ID ?? null
  };
  writeServerRecord(cwd, nextRecord);
  onProgress?.({ message: `opencode server ready at ${url} (pid ${child.pid}).`, phase: "starting" });
  return nextRecord;
}

export function stopCompanionServer(cwd) {
  const record = readServerRecord(cwd);
  if (!record) {
    return { stopped: false };
  }
  if (record.pid && pidAlive(record.pid)) {
    try {
      terminateProcessTree(record.pid);
    } catch {
      // Best effort during shutdown.
    }
  }
  clearServerRecord(cwd);
  return { stopped: Boolean(record.pid), pid: record.pid ?? null };
}
