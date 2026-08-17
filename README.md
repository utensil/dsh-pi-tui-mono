# dsh-pi-tui-shim

pi's real terminal UI as the front door for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

`dsh-pi-tui-shim` is a dsh profile bundle that mounts
[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)'s
`InteractiveMode` — the exact TUI pi uses — and bridges it to the dsh agent
runtime. The agent, tools, sessions, and credentials stay DeepSeek Harness;
the look is pi's, and it updates automatically whenever pi updates its TUI.

## Status

⚠️ **Work in progress.** The bundle loads and composes over `@deepseek-ai/dsh-base`
(milestone 0). The agent-event bridge (`InteractiveMode` ⇄ dsh agent-loop) is
under active development. Until it lands, the profile boots but does not yet
render turns.

## Why not just use `@dsh-tui/dsh-tui`?

Other dsh TUIs are *reimplementations* of a terminal UI — same library family
(`@earendil-works/pi-tui`), different components, different palette, different
rendering. This project instead reuses pi's actual `InteractiveMode` and theme
as a dependency, so the visual identity is pi's by construction and follows pi
releases without edits here.

## Requirements

- `dsh` CLI ([DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness))
- Node.js `^22.19 || >=24`
- pnpm (for profile plugin management)

## Install

Install from GitHub (not yet published to npm):

```sh
dsh plugin --profile tui-pi add github:utensil/dsh-pi-tui-shim
dsh --profile tui-pi
```

Resume a persisted session:

```sh
dsh --profile tui-pi --resume <session-id>
```

### Credentials

The profile reads `DEEPSEEK_API_KEY` through the dsh credentials service,
exactly like the shipped `headless`/`web` profiles — store it once via the
credentials store or environment:

```sh
# managed store (~/.dsh/.credentials.yaml, mode 0600)
# or the launching environment:
export DEEPSEEK_API_KEY=sk-...
```

## How it works

```
dsh (cordis runtime)
  ├── dsh-base            agent-loop · sessions · tools · credentials · models
  └── dsh-pi-tui-shim
        ├── tui-startup   parses --resume, provides the session identity
        └── tui           mounts pi's InteractiveMode (imported), bridged to
                          the dsh agent via an AgentSessionRuntime-shaped shim
```

- The **TUI shell, theme, and rendering** are pi's `InteractiveMode` — imported,
  never reimplemented.
- The **bridge** translates user input → dsh turns and dsh agent events → pi
  session events (assistant messages, tool calls, reasoning).
- Everything else (tools, sessions, permissions, credentials) is unmodified
  `dsh-base`.

## Development

```sh
git clone git@github.com:utensil/dsh-pi-tui-shim.git
cd dsh-pi-tui-shim
dsh plugin --profile tui-pi add file:.
dsh --profile tui-pi            # or --dump-config to inspect composition
```

TUI changes are verified in a real terminal (tmux + `capture-pane`), mirroring
the interaction tests in the dsh ecosystem.

## License

[MIT](LICENSE)
