# Configuration

Relay supports user-level and project configuration. User-level configuration lives in the agent directory, which defaults to `~/.relay/agent`. Project configuration lives in `.relay` under the working directory and loads after [project trust](security.md#understand-project-trust) is granted. The only exception is `sessionDir`, which Relay reads before resolving trust so it can locate sessions.

In interactive mode, use `/settings` to change common preferences. For other options, ask Relay to update the configuration or edit the relevant files directly. Run `/reload` after manually changing settings, keybindings, system prompts, or resources. Context files such as `AGENTS.md` refresh automatically before subsequent model calls.

## Agent directory

The agent directory is shown as `<agent-dir>` below. Set its location with the `RELAY_CODING_AGENT_DIR` environment variable or the SDK's [`agentDir`](sdk.md) option.

| Path | Responsibility |
|---|---|
| `<agent-dir>/settings.json` | User-level [settings](settings.md), including preferences, defaults, resource paths, and Relay package declarations. |
| `<agent-dir>/keybindings.json` | Custom terminal UI and application [keybindings](keybindings.md). |
| `<agent-dir>/mcp.json` | [MCP servers](mcp.md) available in every project. |
| `<agent-dir>/models.json` | [Compatible endpoints, models, and model overrides](models.md#configure-a-compatible-endpoint). |
| `<agent-dir>/auth.json` | Saved API keys and OAuth credentials. |
| `<agent-dir>/AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, or `CLAUDE.MD` | User instructions applied across working directories. |
| `<agent-dir>/SYSTEM.md` | Replaces Relay’s default system prompt. |
| `<agent-dir>/APPEND_SYSTEM.md` | Adds instructions to Relay’s system prompt. |
| `<agent-dir>/extensions/` | User [extensions](extensions.md). |
| `<agent-dir>/skills/` | User [skills](skills.md) and supporting files. |
| `<agent-dir>/prompts/` | User [prompt templates](prompt-templates.md) exposed as slash commands. |
| `<agent-dir>/themes/` | User [theme](themes.md) files. |

## Project `.relay` directory

| Path | Responsibility |
|---|---|
| `.relay/settings.json` | Project-level [settings](settings.md), resource paths, and Relay package declarations. |
| `.relay/mcp.json` | Project [MCP servers](mcp.md). |
| `.relay/SYSTEM.md` | Replaces the system prompt for the project. |
| `.relay/APPEND_SYSTEM.md` | Adds project-specific instructions to the system prompt. |
| `.relay/extensions/` | Project extensions. |
| `.relay/skills/` | Project skills and supporting files. |
| `.relay/prompts/` | Project prompt templates exposed as slash commands. |
| `.relay/themes/` | Project theme files. |

For `SYSTEM.md` and `APPEND_SYSTEM.md`, the trusted project file takes precedence over the corresponding agent-directory file. Files with the same name are not combined.

## Context files

Context files are separate from project `.relay` configuration. Relay loads them from the agent directory, the working directory, and its parent directories. A context file applies whenever Relay runs in its directory or anywhere below it.

An `AGENTS.override.md` replaces `AGENTS.md` or `CLAUDE.md` only in the same directory. It does not suppress context files from the agent directory or other directories.

Context-file discovery does not require project trust.

### Development guide

When you start a task that changes project code, Relay instructs the selected model to create `AGENTS.md` if it is missing. The target is the Git repository or worktree root, including when you start Relay from a subdirectory. Outside Git, the target is the working directory. A global or parent-directory guide does not replace the project's own guide.

The model inspects the project and writes the guide through the session's available tools before changing the implementation. It documents verified architecture, stack, setup and validation commands, environment variable names and purposes, directory layout, services, jobs, data models, patterns, workflows, confirmed hurdles and solutions, and a post-implementation checklist. Sections that do not apply are omitted, and secret values are never included. Existing guides are preserved and evolve with confirmed project knowledge.

Questions and read-only reviews do not require creating a guide. Creation uses the current model and the normal session permissions; a session without permission or tools to write files cannot create it. No separate model or provider-specific setup is needed, including for compatible Ollama and LM Studio endpoints configured in [`models.json`](models.md#configure-a-compatible-endpoint).

New or edited context files are loaded in full before subsequent model calls, including tool continuations and model switches, without `/reload`. The existing `AGENTS.override.md` precedence still applies. Use `--no-context-files` (`-nc`) to disable both context loading and development-guide instructions. Extensions that supply an exact replacement system prompt control their own instructions.
