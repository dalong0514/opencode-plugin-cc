#!/usr/bin/env node

// Windows helper that keeps `opencode serve` alive without a visible console.
//
// Why it exists: a detached child on Windows has NO console (DETACHED_PROCESS),
// so when a launcher shim (e.g. bun's opencode.exe) re-spawns the real runtime,
// Windows allocates a new VISIBLE console window for it. A non-detached child
// gets a hidden console via windowsHide (CREATE_NO_WINDOW) — which its
// grandchildren inherit — but libuv places it in the parent's kill-on-close job
// object, so it dies with the companion. This babysitter is spawned detached
// (invisible, survives the companion) and runs serve non-detached under itself:
// serve stays hidden, lives as long as the babysitter, and `taskkill /T` on the
// babysitter tears the whole tree down.

import { spawn } from "node:child_process";
import process from "node:process";

import { buildSpawnSpec, resolveOpencodeBinary } from "./lib/opencode.mjs";

// The companion detaches from our stdio after reading the announce line; keep
// relaying without crashing on the broken pipe.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

const binary = resolveOpencodeBinary(process.env);
const spec = buildSpawnSpec(binary, ["serve", "--port", "0"]);
const child = spawn(spec.command, spec.args, {
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

child.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    process.exit(0);
  });
}
