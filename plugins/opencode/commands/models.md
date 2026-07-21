---
description: List the models available to opencode for use with --model
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" models "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it.
Remind the user that a model is selected with `--model <provider/model>` and that reasoning effort is passed with `--effort <level>` when the model supports variants.
