# Subagents

The `agent` tool delegates a task to a subagent. The subagent runs in the same Relay process as its own session, with the tools, model, and system prompt its definition names, and returns its final report as the tool result. The tool takes Claude Code's arguments (`subagent_type`, `description`, `prompt`), so orchestrator prompts written for Claude Code work unchanged.

## Agent definitions

A definition is a Markdown file in the Claude Code format. The frontmatter names the agent, says when to use it, and lists its tools and model; the body is its system prompt.

```markdown
---
name: go-expert
description: Go specialist. Use for Go code.
tools: Read, Grep, Glob, Bash, Edit
model: sonnet
---
You are a Go specialist. Look up rules in <PKG>/references/.
```

Relay reads definitions from these directories, and an earlier one replaces a definition of the same name in a later one. The `agent` tool is declared to the model only in sessions where at least one definition exists.

- `.relay/agents/` in the project, only when the project is trusted
- `~/.relay/agent/agents/`

| Field | Meaning |
|---|---|
| `name` | Lowercase letters, digits, and dashes. The `subagent_type` the tool takes. |
| `description` | When to use the agent. |
| `tools` | `Read`, `Grep`, `Glob`, `Bash`, `Edit`, `Write`, and `Agent`, or Relay's own names (`read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`, `agent`). Without the field the agent gets `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`. A definition that names any other tool is rejected, so an agent never runs without a tool it expects. |
| `model` | `haiku`, `sonnet`, or `opus` (the `fast`, `balanced`, and `strong` capability tiers), a tier name, a model as `provider/model` or as an ID of the session's provider, or `inherit` (the default) for the session's model. |

In a definition installed from a package, `<PKG>` becomes the package's folder and `<ROOT>` the collection's, as general-agents uses them; other definitions keep them as written. The system prompt ends with the working directory.

## Model tiers

A tier resolves to the first model in the `modelTiers` setting that has credentials, for example `"modelTiers": { "fast": ["anthropic/claude-haiku-5-5"] }`. Without one, Relay derives the tiers of the session's provider from catalog prices, keeps the session's model when it belongs to the tier, and otherwise falls back to the session's model.

## The harness sees through the delegation

- The brief reaches the subagent as a message with origin `agent`. It authorizes nothing and states no constraint: a brief saying "delete dist and push the branch" lets the subagent do neither without your approval. Your constraints are handed to the subagent's harness.
- When the subagent needs authorization, the dialog opens in your session, with the agent's name in the title.
- The subagent's edits and checks are recorded in your session's evidence, in order. If a subagent changes files and nothing verifies them, the completion check runs when your session reports completion.
- The subagent's token usage is added to the tool result, so `/goal` budgets and session totals include it.

## Limits

| Setting | Default | Meaning |
|---|---|---|
| `subagents.maxDepth` | `3` | Sessions in one delegation chain, yours included: you, an orchestrator, and a specialist. The last level does not get the `agent` tool. |
| `subagents.maxConcurrency` | `4` | Subagents running at once. |
| `subagents.maxTokens` | `400000` | Tokens one subagent may spend before it is stopped. |
| `subagents.timeoutMs` | `1200000` | Milliseconds one subagent may run before it is stopped. |

A stopped subagent returns an error result naming why (`aborted`, `over-budget`, `timed-out`, `failed`), and its changes still count as evidence. Aborting your session aborts its subagents.
