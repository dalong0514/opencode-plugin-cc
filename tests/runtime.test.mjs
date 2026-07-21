import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildEnv, installFakeOpencode, readInvocations } from "./fake-opencode-fixture.mjs";
import {
  COMPANION_PATH,
  SESSION_LIFECYCLE_HOOK_PATH,
  STOP_GATE_HOOK_PATH,
  makeGitRepo,
  makeTempDir,
  runCompanion,
  runHook,
  waitFor
} from "./helpers.mjs";

function freshContext(overrides = {}) {
  const fixture = installFakeOpencode();
  const repo = makeGitRepo();
  const pluginData = makeTempDir("opencode-plugin-data-");
  const env = buildEnv(fixture, {
    CLAUDE_PLUGIN_DATA: pluginData,
    OPENCODE_COMPANION_SESSION_ID: "claude-session-test",
    ...overrides
  });
  return { fixture, repo, pluginData, env };
}

function lastRunInvocation(fixture) {
  const runs = readInvocations(fixture.logFile).filter((entry) => entry.argv[0] === "run");
  return runs[runs.length - 1] ?? null;
}

test("task forwards model, effort->variant, write agent, and stdin prompt", () => {
  const { fixture, repo, env } = freshContext();
  const result = runCompanion(
    ["task", "--model", "deepseek/deepseek-v4-pro", "--effort", "high", "--write", "do the thing"],
    { cwd: repo.dir, env }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /FAKE-DONE/);

  const invocation = lastRunInvocation(fixture);
  assert.ok(invocation, "expected a run invocation");
  const argv = invocation.argv;
  assert.equal(argv[0], "run");
  assert.ok(argv.includes("--format") && argv.includes("json"));
  assert.equal(argv[argv.indexOf("--model") + 1], "deepseek/deepseek-v4-pro");
  assert.equal(argv[argv.indexOf("--variant") + 1], "high");
  assert.equal(argv[argv.indexOf("--agent") + 1], "build");
  const normalizePath = (value) => String(value).replace(/\\/g, "/").toLowerCase();
  assert.equal(normalizePath(argv[argv.indexOf("--dir") + 1]), normalizePath(repo.dir));
  assert.equal(invocation.stdin.trim(), "do the thing");
  const title = argv[argv.indexOf("--title") + 1];
  assert.match(title, /^opencode Companion Task: do the thing/);
});

test("task defaults to the read-only plan agent without --write", () => {
  const { fixture, repo, env } = freshContext();
  const result = runCompanion(["task", "diagnose the flaky test"], { cwd: repo.dir, env });

  assert.equal(result.status, 0, result.stderr);
  const invocation = lastRunInvocation(fixture);
  assert.equal(invocation.argv[invocation.argv.indexOf("--agent") + 1], "plan");
});

test("task --json returns payload with session id and raw output", () => {
  const { repo, env } = freshContext();
  const result = runCompanion(["task", "--json", "say hi"], { cwd: repo.dir, env });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 0);
  assert.equal(payload.threadId, "ses_fake0001");
  assert.match(payload.rawOutput, /FAKE-DONE/);
});

test("invalid effort is rejected before spawning opencode", () => {
  const { fixture, repo, env } = freshContext();
  const result = runCompanion(["task", "--effort", "very high", "prompt"], { cwd: repo.dir, env });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported reasoning effort/);
  assert.equal(lastRunInvocation(fixture), null);
});

test("task --resume-last resumes the most recent tracked session", () => {
  const { fixture, repo, env } = freshContext();

  const first = runCompanion(["task", "--json", "start the work"], { cwd: repo.dir, env });
  assert.equal(first.status, 0, first.stderr);

  const resumed = runCompanion(["task", "--json", "--resume-last", "keep going"], { cwd: repo.dir, env });
  assert.equal(resumed.status, 0, resumed.stderr);
  const payload = JSON.parse(resumed.stdout);
  assert.match(payload.rawOutput, /FAKE-RESUMED on ses_fake0001/);

  const invocation = lastRunInvocation(fixture);
  assert.equal(invocation.argv[invocation.argv.indexOf("--session") + 1], "ses_fake0001");
  assert.ok(!invocation.argv.includes("--title"), "resume runs must not rename the session");
});

test("task failure propagates the opencode error and records a failed job", () => {
  const { repo, env } = freshContext({ FAKE_OPENCODE_BEHAVIOR: "run-error" });
  const result = runCompanion(["task", "--json", "explode"], { cwd: repo.dir, env });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 1);

  const status = runCompanion(["status", "--json"], { cwd: repo.dir, env });
  const report = JSON.parse(status.stdout);
  assert.equal(report.latestFinished.status, "failed");
});

test("background task completes via detached worker; status --wait and result see it", async () => {
  const { repo, env } = freshContext();
  const launch = runCompanion(["task", "--json", "--background", "--write", "background work"], {
    cwd: repo.dir,
    env
  });
  assert.equal(launch.status, 0, launch.stderr);
  const { jobId } = JSON.parse(launch.stdout);
  assert.ok(jobId, "expected a job id");

  const waited = runCompanion(["status", jobId, "--wait", "--timeout-ms", "30000", "--json"], {
    cwd: repo.dir,
    env,
    timeout: 45000
  });
  assert.equal(waited.status, 0, waited.stderr);
  const snapshot = JSON.parse(waited.stdout);
  assert.equal(snapshot.job.status, "completed");

  const result = runCompanion(["result", jobId], { cwd: repo.dir, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /FAKE-DONE/);
  assert.match(result.stdout, /opencode session ID: ses_fake0001/);
  assert.match(result.stdout, /Resume in opencode: opencode -s ses_fake0001/);
});

test("cancel terminates a running background task", async () => {
  const { repo, env } = freshContext({
    FAKE_OPENCODE_BEHAVIOR: "slow-task",
    FAKE_OPENCODE_SLEEP_MS: "30000"
  });
  const launch = runCompanion(["task", "--json", "--background", "long slow work"], { cwd: repo.dir, env });
  assert.equal(launch.status, 0, launch.stderr);
  const { jobId } = JSON.parse(launch.stdout);

  await waitFor(() => {
    const status = runCompanion(["status", jobId, "--json"], { cwd: repo.dir, env });
    const snapshot = JSON.parse(status.stdout);
    return snapshot.job.status === "running";
  });

  const cancel = runCompanion(["cancel", jobId, "--json"], { cwd: repo.dir, env });
  assert.equal(cancel.status, 0, cancel.stderr);

  const status = runCompanion(["status", jobId, "--json"], { cwd: repo.dir, env });
  const snapshot = JSON.parse(status.stdout);
  assert.equal(snapshot.job.status, "cancelled");
});

test("setup --json reports ready with fake opencode and models", () => {
  const { repo, env } = freshContext();
  const result = runCompanion(["setup", "--json"], { cwd: repo.dir, env });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, true);
  assert.equal(report.opencode.available, true);
  assert.match(report.opencode.detail, /9\.9\.9-fake/);
  assert.equal(report.auth.loggedIn, true);
  assert.equal(report.reviewGateEnabled, false);
});

test("setup toggles the stop review gate", () => {
  const { repo, env } = freshContext();
  const enable = runCompanion(["setup", "--json", "--enable-review-gate"], { cwd: repo.dir, env });
  assert.equal(JSON.parse(enable.stdout).reviewGateEnabled, true);

  const disable = runCompanion(["setup", "--json", "--disable-review-gate"], { cwd: repo.dir, env });
  assert.equal(JSON.parse(disable.stdout).reviewGateEnabled, false);
});

test("models lists the available models", () => {
  const { repo, env } = freshContext();
  const result = runCompanion(["models"], { cwd: repo.dir, env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /deepseek\/deepseek-v4-pro/);
  assert.match(result.stdout, /opencode\/big-pickle/);
});

test("review runs read-only with git context and renders the output", () => {
  const { fixture, repo, env } = freshContext({ FAKE_OPENCODE_REPLY: "Verdict: approve\n\nSummary: fine.\n\nFindings:\nNo material findings." });
  fs.writeFileSync(path.join(repo.dir, "app.js"), "console.log('hello')\n", "utf8");

  const result = runCompanion(["review", "--wait"], { cwd: repo.dir, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# opencode Review/);
  assert.match(result.stdout, /Target: working tree diff/);
  assert.match(result.stdout, /Verdict: approve/);

  const invocation = lastRunInvocation(fixture);
  assert.equal(invocation.argv[invocation.argv.indexOf("--agent") + 1], "plan");
  assert.match(invocation.stdin, /adversarial software reviewer/);
  assert.match(invocation.stdin, /app\.js/);
});

test("task-resume-candidate reports availability after a completed task", () => {
  const { repo, env } = freshContext();
  const none = runCompanion(["task-resume-candidate", "--json"], { cwd: repo.dir, env });
  assert.equal(JSON.parse(none.stdout).available, false);

  const task = runCompanion(["task", "seed a session"], { cwd: repo.dir, env });
  assert.equal(task.status, 0, task.stderr);

  const found = runCompanion(["task-resume-candidate", "--json"], { cwd: repo.dir, env });
  const payload = JSON.parse(found.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.candidate.threadId, "ses_fake0001");
});

test("stop gate allows when disabled and blocks on BLOCK output when enabled", () => {
  const { repo, env } = freshContext({ FAKE_OPENCODE_REPLY: "BLOCK: the change breaks startup" });

  const hookInput = {
    session_id: "claude-session-test",
    cwd: repo.dir,
    last_assistant_message: "I edited app.js"
  };

  const disabled = runHook(STOP_GATE_HOOK_PATH, hookInput, { cwd: repo.dir, env });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(disabled.stdout.trim(), "");

  const enable = runCompanion(["setup", "--json", "--enable-review-gate"], { cwd: repo.dir, env });
  assert.equal(enable.status, 0, enable.stderr);

  const blocked = runHook(STOP_GATE_HOOK_PATH, hookInput, { cwd: repo.dir, env, timeout: 60000 });
  assert.equal(blocked.status, 0, blocked.stderr);
  const decision = JSON.parse(blocked.stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /the change breaks startup/);

  const allowedEnv = { ...env, FAKE_OPENCODE_REPLY: "ALLOW: no code changes" };
  const allowed = runHook(STOP_GATE_HOOK_PATH, hookInput, { cwd: repo.dir, env: allowedEnv, timeout: 60000 });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
});

function serveInvocations(fixture) {
  return readInvocations(fixture.logFile).filter((entry) => entry.argv[0] === "serve");
}

test("task starts one shared server and attaches subsequent runs to it", () => {
  const { fixture, repo, env } = freshContext();

  const first = runCompanion(["task", "first prompt"], { cwd: repo.dir, env });
  assert.equal(first.status, 0, first.stderr);
  const second = runCompanion(["task", "second prompt"], { cwd: repo.dir, env });
  assert.equal(second.status, 0, second.stderr);

  assert.equal(serveInvocations(fixture).length, 1, "the warm server must be reused across runs");
  const runs = readInvocations(fixture.logFile).filter((entry) => entry.argv[0] === "run");
  assert.equal(runs.length, 2);
  for (const run of runs) {
    const attachIndex = run.argv.indexOf("--attach");
    assert.ok(attachIndex !== -1, "runs must attach to the shared server");
    assert.match(run.argv[attachIndex + 1], /^http:\/\/127\.0\.0\.1:\d+$/);
  }
});

test("SessionEnd stops the shared server; the next task starts a fresh one", () => {
  const { fixture, repo, env } = freshContext();

  const first = runCompanion(["task", "warm up"], { cwd: repo.dir, env });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(serveInvocations(fixture).length, 1);

  const hook = runHook(
    SESSION_LIFECYCLE_HOOK_PATH,
    { hook_event_name: "SessionEnd", cwd: repo.dir, session_id: "claude-session-test" },
    { cwd: repo.dir, env }
  );
  assert.equal(hook.status, 0, hook.stderr);

  const second = runCompanion(["task", "after restart"], { cwd: repo.dir, env });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(serveInvocations(fixture).length, 2, "a stopped server must be replaced, not reused");
});

test("task falls back to a plain run when the server cannot start", () => {
  const { fixture, repo, env } = freshContext({ FAKE_OPENCODE_BEHAVIOR: "serve-fail" });

  const result = runCompanion(["task", "no server available"], { cwd: repo.dir, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /FAKE-DONE/);

  const invocation = lastRunInvocation(fixture);
  assert.ok(!invocation.argv.includes("--attach"), "fallback runs must not attach");
});

test("permission auto-reject surfaces as an explicit failure with remediation", () => {
  const { repo, env } = freshContext({ FAKE_OPENCODE_BEHAVIOR: "permission-reject" });

  const result = runCompanion(["task", "read something outside"], { cwd: repo.dir, env });
  assert.notEqual(result.status, 0, "a rejected run with no answer must fail");
  assert.match(result.stdout, /auto-rejected permission request/);
  assert.match(result.stdout, /external_directory \(outside-dir\/\*\)/);
  assert.match(result.stdout, /--allow-external/);

  const status = runCompanion(["status", "--json"], { cwd: repo.dir, env });
  assert.equal(JSON.parse(status.stdout).latestFinished.status, "failed");
});

test("--allow-external forwards opencode's --auto approval flag", () => {
  const { fixture, repo, env } = freshContext();

  const result = runCompanion(["task", "--allow-external", "trusted task"], { cwd: repo.dir, env });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(lastRunInvocation(fixture).argv.includes("--auto"));
});

test("companion help prints usage", () => {
  const result = runCompanion([], {});
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.ok(fs.existsSync(COMPANION_PATH));
});
