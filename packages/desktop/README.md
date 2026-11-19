# Relay Desktop

A desktop window for Relay. The window is a client of `relay --mode rpc`: it shows the sessions, the conversation, the harness's authorization requests, the harness state (constraints you can forget, the evidence of the last completion, approvals, context savings), the subagents the `agent` tool runs, pickers for the model and the thinking level, and a dialog for the harness settings. It keeps no agent logic of its own.

- `src/`: the screen, in TypeScript with no framework. Model and tool text is always set as text, never parsed as HTML.
- `src-tauri/`: the Tauri 2 shell. It starts `relay --mode rpc` on the window's first command, writes the window's commands to its stdin, and sends each line it prints back to the window. The window may only send lines and listen to the output (`capabilities/default.json`); the content security policy allows no remote content.

## Run it

```sh
npm run build                       # in packages/desktop: compiles the screen into dist/
cargo run -p relay-desktop          # from the repository root
```

The shell runs `relay` from `PATH` (`relay.cmd` on Windows when npm installed it). Set `RELAY_DESKTOP_COMMAND` to run another command, such as `node /path/to/relay/packages/coding-agent/dist/cli.js`, and `RELAY_DESKTOP_CWD` to choose the working directory.

On Linux the shell needs the WebKitGTK development packages: `libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev`.

## Tests

`npm test` runs the built screen in the system Chrome through Playwright, against a scripted bridge that plays relay's side of the RPC protocol: the conversation and its tool results, streaming, the authorization dialog (focus on Deny, Escape denies), session switching, text that looks like markup, relay stopping, the harness panel and forgetting a constraint, the subagents view, the model and thinking pickers, and the settings dialog (a refused value is marked and not sent).
