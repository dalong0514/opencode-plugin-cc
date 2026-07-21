import { spawn } from "node:child_process";
import process from "node:process";
import readline from "node:readline";

import { runCommand, terminateProcessTree } from "./process.mjs";

export const SERVICE_NAME = "claude_code_opencode_plugin";
export const TASK_SESSION_PREFIX = "opencode Companion Task";
export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";
export const BIN_ENV = "OPENCODE_COMPANION_BIN";

const WRITE_AGENT = "build";
const READ_ONLY_AGENT = "plan";
const MODELS_TIMEOUT_MS = 60000;

let cachedBinary = null;

function resolveViaPathLookup(name) {
  const lookupCommand = process.platform === "win32" ? "where.exe" : "which";
  const result = runCommand(lookupCommand, [name], { shell: false });
  if (result.error || result.status !== 0) {
    return null;
  }
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }
  if (process.platform === "win32") {
    return lines.find((line) => /\.exe$/i.test(line)) ?? lines[0];
  }
  return lines[0];
}

export function resolveOpencodeBinary(env = process.env) {
  const override = env[BIN_ENV];
  if (override && override.trim()) {
    return override.trim();
  }
  if (cachedBinary) {
    return cachedBinary;
  }
  cachedBinary = resolveViaPathLookup("opencode") ?? "opencode";
  return cachedBinary;
}

export function resetBinaryCacheForTests() {
  cachedBinary = null;
}

// Compose a spawn spec that never routes repository-derived text through a shell.
export function buildSpawnSpec(binary, args) {
  const lower = binary.toLowerCase();
  if (lower.endsWith(".mjs") || lower.endsWith(".cjs") || lower.endsWith(".js")) {
    return { command: process.execPath, args: [binary, ...args] };
  }
  if (process.platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", binary, ...args] };
  }
  return { command: binary, args };
}

export function getOpencodeAvailability(cwd, env = process.env) {
  const binary = resolveOpencodeBinary(env);
  const spec = buildSpawnSpec(binary, ["--version"]);
  const result = runCommand(spec.command, spec.args, { cwd, env, shell: false });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  const version = result.stdout.trim() || result.stderr.trim() || "ok";
  return { available: true, detail: version, version };
}

export function listOpencodeModels(cwd, env = process.env) {
  const binary = resolveOpencodeBinary(env);
  const spec = buildSpawnSpec(binary, ["models"]);
  const result = runCommand(spec.command, spec.args, {
    cwd,
    env,
    shell: false,
    maxBuffer: 10 * 1024 * 1024,
    timeout: MODELS_TIMEOUT_MS
  });
  if (result.error || result.status !== 0) {
    const detail =
      result.error?.message ?? result.stderr.trim() ?? result.stdout.trim() ?? `exit ${result.status}`;
    return { ok: false, detail, models: [] };
  }
  const models = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line.includes("/") && !line.startsWith("["));
  return { ok: true, detail: `${models.length} model(s) available`, models };
}

export function getOpencodeAuthStatus(cwd, env = process.env) {
  const availability = getOpencodeAvailability(cwd, env);
  if (!availability.available) {
    return { loggedIn: false, detail: `opencode unavailable: ${availability.detail}`, models: [] };
  }
  const models = listOpencodeModels(cwd, env);
  if (!models.ok) {
    return { loggedIn: false, detail: `could not list models: ${models.detail}`, models: [] };
  }
  if (models.models.length === 0) {
    return {
      loggedIn: false,
      detail: "no models available. Run `opencode auth login` to configure a provider.",
      models: []
    };
  }
  return { loggedIn: true, detail: models.detail, models: models.models };
}

export function getSessionRuntimeStatus(env = process.env, cwd = process.cwd()) {
  const availability = getOpencodeAvailability(cwd, env);
  if (!availability.available) {
    return { mode: "unavailable", label: `opencode CLI unavailable (${availability.detail})` };
  }
  return { mode: "per-run", label: `per-run opencode CLI (v${availability.version})` };
}

export function buildTaskSessionTitle(prompt) {
  const excerpt = String(prompt ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 56);
  return excerpt ? `${TASK_SESSION_PREFIX}: ${excerpt}` : TASK_SESSION_PREFIX;
}

function describeToolEvent(part) {
  const tool = String(part?.tool ?? "tool");
  const state = part?.state ?? {};
  const input = state.input ?? {};
  const title = typeof state.title === "string" && state.title.trim() ? state.title.trim() : null;

  if (tool === "bash") {
    const command = typeof input.command === "string" ? input.command : title ?? "";
    return { message: `Running command: ${command}`.trim(), phase: "running" };
  }
  if (tool === "write" || tool === "edit" || tool === "patch") {
    const filePath = typeof input.filePath === "string" ? input.filePath : title ?? "";
    return { message: `Applying file change: ${tool} ${filePath}`.trim(), phase: "editing", filePath };
  }
  if (tool === "read" || tool === "grep" || tool === "glob" || tool === "list" || tool === "webfetch") {
    return { message: `Running tool: ${tool}${title ? ` ${title}` : ""}`, phase: "investigating" };
  }
  if (tool === "task") {
    return { message: `Starting collaboration tool: ${title ?? "task"}`, phase: "investigating" };
  }
  return { message: `Running tool: ${tool}${title ? ` ${title}` : ""}`, phase: "running" };
}

function extractErrorMessage(error) {
  if (!error) {
    return "";
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error?.data?.message === "string" && error.data.message.trim()) {
    return error.data.message.trim();
  }
  if (typeof error?.message === "string" && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error?.name === "string" && error.name.trim()) {
    return error.name.trim();
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function buildRunArgs(options = {}) {
  const args = ["run", "--format", "json"];
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.variant) {
    args.push("--variant", options.variant);
  }
  if (options.agent) {
    args.push("--agent", options.agent);
  }
  if (options.resumeSessionId) {
    args.push("--session", options.resumeSessionId);
  }
  if (options.title) {
    args.push("--title", options.title);
  }
  if (options.cwd) {
    args.push("--dir", options.cwd);
  }
  return args;
}

export function resolveRunAgent(options = {}) {
  if (options.agent) {
    return options.agent;
  }
  return options.write ? WRITE_AGENT : READ_ONLY_AGENT;
}

export async function runOpencodeTurn(cwd, options = {}) {
  const env = options.env ?? process.env;
  const prompt = String(options.prompt ?? "").trim() || String(options.defaultPrompt ?? "").trim();
  if (!prompt) {
    throw new Error("No prompt was provided for the opencode run.");
  }

  const onProgress = options.onProgress ?? null;
  const agent = resolveRunAgent(options);
  const runArgs = buildRunArgs({
    model: options.model ?? null,
    variant: options.variant ?? null,
    agent,
    resumeSessionId: options.resumeSessionId ?? null,
    title: options.resumeSessionId ? null : options.title ?? null,
    cwd
  });
  const binary = resolveOpencodeBinary(env);
  const spec = buildSpawnSpec(binary, runArgs);

  onProgress?.({
    message: `Starting opencode (${agent} agent${options.model ? `, model ${options.model}` : ""}${
      options.variant ? `, variant ${options.variant}` : ""
    }).`,
    phase: "starting"
  });

  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(spec.command, spec.args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      reject(error);
      return;
    }

    let sessionId = options.resumeSessionId ?? null;
    let stderrText = "";
    let errorMessage = "";
    let lastMessageId = null;
    const textsByMessage = new Map();
    const toolCalls = [];
    const touchedFiles = new Set();
    let usage = null;
    let settled = false;
    let timeoutHandle = null;
    let timedOut = false;

    const settle = (value, error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };

    if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        onProgress?.({ message: `opencode run timed out after ${options.timeoutMs} ms. Terminating.`, phase: "failed" });
        try {
          terminateProcessTree(child.pid ?? Number.NaN);
        } catch {
          // Best effort: the exit handler still settles the promise.
        }
      }, options.timeoutMs);
    }

    child.on("error", (error) => {
      settle(null, error);
    });

    child.stderr.on("data", (chunk) => {
      stderrText += String(chunk);
    });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) {
        return;
      }
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return;
      }

      if (!sessionId && typeof event.sessionID === "string" && event.sessionID) {
        sessionId = event.sessionID;
        onProgress?.({ message: `opencode session ready: ${sessionId}`, phase: "starting", threadId: sessionId });
      }

      const part = event.part ?? {};
      switch (event.type) {
        case "tool_use": {
          const described = describeToolEvent(part);
          toolCalls.push({
            tool: part.tool ?? "tool",
            status: part.state?.status ?? "completed",
            title: part.state?.title ?? null
          });
          if (described.filePath) {
            touchedFiles.add(described.filePath);
          }
          if (part.state?.status === "error") {
            onProgress?.({ message: `Tool failed: ${part.tool ?? "tool"}`, phase: "running" });
          } else {
            onProgress?.(described);
          }
          break;
        }
        case "text": {
          const messageId = typeof part.messageID === "string" ? part.messageID : "message";
          lastMessageId = messageId;
          const texts = textsByMessage.get(messageId) ?? [];
          texts.push(String(part.text ?? ""));
          textsByMessage.set(messageId, texts);
          onProgress?.({
            message: "Assistant message received.",
            logTitle: "Assistant message",
            logBody: String(part.text ?? "")
          });
          break;
        }
        case "step_finish": {
          if (part.tokens || part.cost != null) {
            usage = { tokens: part.tokens ?? null, cost: part.cost ?? null };
          }
          break;
        }
        case "error": {
          const message = extractErrorMessage(event.error);
          if (message) {
            errorMessage = errorMessage ? `${errorMessage}\n${message}` : message;
            onProgress?.({ message: `opencode error: ${message}`, phase: "failed" });
          }
          break;
        }
        default:
          break;
      }
    });

    child.on("close", (code, signal) => {
      rl.close();
      const finalTexts = lastMessageId ? textsByMessage.get(lastMessageId) ?? [] : [];
      const finalMessage = finalTexts.join("\n\n").trim();
      const allTexts = [...textsByMessage.values()].flat().join("\n\n").trim();
      const exitStatus = timedOut ? 124 : code ?? (signal ? 1 : 0);

      if (timedOut && !errorMessage) {
        errorMessage = `opencode run timed out after ${options.timeoutMs} ms.`;
      }
      if (exitStatus !== 0 && !errorMessage) {
        errorMessage = stderrText.trim() || `opencode exited with status ${exitStatus}${signal ? ` (signal ${signal})` : ""}`;
      }

      onProgress?.({
        message: exitStatus === 0 ? "Turn completed." : `Failed: ${errorMessage}`,
        phase: exitStatus === 0 ? "finalizing" : "failed",
        threadId: sessionId
      });

      settle({
        status: exitStatus,
        threadId: sessionId,
        turnId: null,
        finalMessage: finalMessage || allTexts,
        toolCalls,
        touchedFiles: [...touchedFiles],
        usage,
        errorMessage,
        stderr: stderrText,
        timedOut
      });
    });

    child.stdin.on("error", () => {
      // The child may exit before the prompt finishes writing; the close handler reports the failure.
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
