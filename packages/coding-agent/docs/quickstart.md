# Quickstart

Relay runs in your terminal and works with files on your machine. To use it, you need access to a model through a supported provider. This can be a subscription, an API key, or a local model.

For native Windows setup, read [Windows Setup](windows.md). For Android, read [Termux Setup](termux.md).

## 1. Install Relay

Relay requires Node.js 22.19 or newer. Install it from npm:

```bash
npm install -g --ignore-scripts @relay-harness/coding-agent
```

Relay does not require dependency lifecycle scripts, so `--ignore-scripts` is safe. To update Relay, run the same command again. `relay update` updates installed packages and model catalogs, not Relay itself.

To work on Relay itself, build it from a checkout instead:

```bash
git clone https://github.com/eltonssouza/relay-harness.git
cd relay-harness
npm install --ignore-scripts
npm run build
```

With Nix on macOS or Linux, install the latest release from Relay's flake. Nix builds Relay from source:

```bash
nix profile add github:eltonssouza/relay-harness
```

Older Nix versions use `nix profile install` instead. Update with `nix profile upgrade relay`. To pin a release, use a tag such as `github:eltonssouza/relay-harness/v1.0.0`.

Verify the installation:

```bash
relay --version
```

From a source checkout, run `./relay-test.sh --version` (Linux and macOS) or `./relay-test.ps1 --version` (Windows PowerShell) instead.

The examples below use `relay` for this command.

## 2. Start Relay

Change to the folder you want Relay to work with, then start it:

```bash
cd /path/to/folder
relay
```

The working folder helps Relay discover relevant files, instructions, and configuration. Relay also uses it to group saved sessions.

<p align="center"><img src="images/interactive-mode.png" alt="Relay running in a terminal with a conversation, input editor, and status footer" width="750"></p>

The interface shows your conversation, an editor for prompts and commands, and a footer with the current folder, model, and session status. See [Use Relay in the terminal](usage.md) to learn how to add files, run commands, direct ongoing work, and manage results.

## 3. Choose a model

A **model** generates Relay's responses. A **provider** is the service or account Relay uses to access that model.

In Relay, run:

```text
/login
```

Choose a provider, then follow the prompts to use a subscription or store an API key. Run `/model` afterward if you want to select a different available model.

See [Choose a model and provider](models.md) for supported providers, environment-variable authentication, local models, and custom endpoints.

## 4. Give Relay a task

Relay shows each file read, search, command, and edit it performs. It does not ask before every tool call.

Enter a task that matches your work, for example:

```text
Summarize @meeting-notes.md and save the action items to action-items.md.
```

```text
Explain how this repository is structured and how to run its checks.
```

```text
Compare @previous.csv with @current.csv and summarize the important changes.
```

Type `@` in the editor to search for a file instead of entering its full path. When Relay finishes, review its response and any changed files. Use version control or backups for important work. For untrusted or unattended work, use a container or another sandbox. See [Security](security.md).

## Continue later

Relay saves sessions automatically. Exit Relay, then resume the most recent session for the same working folder with:

```bash
relay --continue
```

Use `/resume` to choose another saved session. See [Continue or branch a session](sessions.md) for session naming, branching, compaction, export, and sharing.

## Next steps

- [Use Relay interactively](usage.md) to learn input, commands, shortcuts, and queued messages.
- [Add instructions](configuration.md#context-files) that Relay should follow whenever it works in a folder.
- [Choose a model and provider](models.md).

### Choose how to customize Relay

Start with the least powerful mechanism that meets your need:

| Need | Start with |
|---|---|
| Give Relay persistent instructions for a folder | [`AGENTS.md`](configuration.md#context-files) |
| Reuse a prompt from the `/` menu | [Prompt template](prompt-templates.md) |
| Add task-specific instructions and supporting files | [Skill](skills.md) |
| Add executable tools, commands, or event handlers | [Extension](extensions.md) |
| Build a custom terminal component | [Terminal UI](tui.md) |
| Connect an unsupported model service | [Custom provider](custom-provider.md) |
| Install or distribute several resources | [Relay package](packages.md) |

## Uninstall Relay

If you installed Relay from npm, run:

```bash
npm uninstall -g @relay-harness/coding-agent
```

If you built Relay from source, delete the checkout.

If you installed Relay with Nix, run:

```bash
nix profile remove relay
```

None of these methods removes configuration, credentials, sessions, or installed Relay packages from `~/.relay/agent/`.
