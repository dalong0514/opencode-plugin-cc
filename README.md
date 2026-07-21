# opencode-plugin-cc

Use [opencode](https://opencode.ai) models from Claude Code — delegate coding tasks or run code reviews with any model configured in your local opencode CLI (DeepSeek, opencode zen free models, and every other provider opencode supports).

This project mirrors the architecture of OpenAI's `codex-plugin-cc` (which lets Claude Code call Codex models like `gpt-5.6-terra --effort high`), adapted to the opencode CLI:

| codex plugin | this plugin |
| --- | --- |
| `codex app-server` JSON-RPC + broker | shared warm `opencode serve` per workspace; runs attach via `opencode run --attach` (falls back to one-shot `opencode run` automatically) |
| `--model gpt-5.6-terra --effort high` | `--model deepseek/deepseek-v4-pro --effort high` (mapped to opencode `--variant`) |
| sandbox `read-only` / `workspace-write` | opencode agent `plan` / `build` |
| `thread/resume` | `opencode run -s <sessionID>` |

## Requirements

- Node.js >= 18.18
- [opencode CLI](https://opencode.ai) on `PATH` (`npm install -g opencode-ai` or `bun add -g opencode-ai`)
- At least one provider configured (`opencode auth login`), or use the free `opencode/*` models

## Install

```
/plugin marketplace add D:\dalong.com\B.MyCreate\01.AI\opencode-plugin-cc
/plugin install opencode@opencode-cc
```

Then restart Claude Code (or `/reload-plugins`) and run `/opencode:setup`.

## Usage

Delegate a task to a specific opencode model (the analog of "指定使用codex的模型gpt-5.6-terra（--effort high）"):

> 指定使用opencode的模型 deepseek/deepseek-v4-pro（--effort high）来完成如下任务：...

or explicitly:

```
/opencode:rescue --model deepseek/deepseek-reasoner --effort high fix the failing test in tests/foo.test.ts
```

### Commands

- `/opencode:rescue [--background|--wait] [--resume|--fresh] [--model <provider/model>] [--effort <level>] [--allow-external] <task>` — delegate a task. Write-capable by default (opencode `build` agent); read-only requests use the `plan` agent.
- `/opencode:review [--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model ...] [--effort ...] [focus]` — adversarial read-only review of local git state.
- `/opencode:models` — list models available to `--model <provider/model>`.
- `/opencode:status [job-id] [--wait] [--all]` — active/recent jobs.
- `/opencode:result [job-id]` — stored final output of a finished job.
- `/opencode:cancel [job-id]` — cancel an active background job.
- `/opencode:setup [--enable-review-gate|--disable-review-gate]` — readiness check and optional stop-time review gate.

### Model & effort

- Models use opencode's `provider/model` format (`deepseek/deepseek-v4-pro`, `opencode/big-pickle`, ...). Unset means opencode's own configured default.
- `--effort` maps to opencode's `--variant` and is provider-specific; common values: `minimal`, `low`, `medium`, `high`, `max`, `xhigh`.

### Sessions

Every task run is a persistent opencode session. `--resume` continues the most recent task session from this Claude session; the session ID is printed so you can also open it in the opencode TUI with `opencode -s <sessionID>`.

### Shared warm server

The first task in a workspace starts a background `opencode serve` and later runs attach to it, cutting the per-call session cold start. The server is stopped when the Claude session ends and restarts on demand; if it cannot start (old opencode version, port trouble), runs silently fall back to one-shot mode. Set `OPENCODE_COMPANION_NO_SERVER=1` to disable the warm server entirely.

### Sandbox boundaries

Non-interactive opencode runs auto-reject permission prompts, including reads outside the project workspace. The companion now surfaces those rejections as explicit failures with a fix hint instead of a silent empty result. Options: copy the needed files into the project first (preferred), or pass `--allow-external` to auto-approve permissions for a trusted task. Claude Code skills are likewise invisible to opencode — the rescue command inlines referenced skill content into the task text before forwarding.

### Stop-time review gate (optional, off by default)

`/opencode:setup --enable-review-gate` makes the plugin run an opencode review of each Claude turn at stop time and block the stop when it finds unfixed issues. This can loop Claude and opencode for a while; disable with `--disable-review-gate`.

## Development

```
npm test          # node --test tests/*.test.mjs (uses a fake opencode binary, no network)
```

The companion CLI can be exercised directly:

```
node plugins/opencode/scripts/opencode-companion.mjs task --model opencode/big-pickle --write "create hello.txt with hello"
node plugins/opencode/scripts/opencode-companion.mjs status
```

Set `OPENCODE_COMPANION_BIN` to point at an alternate opencode binary (the tests use this to inject the fake).
