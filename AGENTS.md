# AGENTS.md — dsh-pi-tui-shim

A dsh (DeepSeek Harness) profile bundle that mounts pi's real
`InteractiveMode` as the terminal front door, bridged to the dsh agent
runtime. The look ships with `@earendil-works/pi-coding-agent`, so pi TUI
updates arrive without edits to this repo.

## Repo standards

- **Public-ready open source.** MIT. No private information anywhere: no
  personal paths (`/Users/<user>`), no tokens, keys, hostnames, or identity
  details. Tests and fixtures must use `t.TempDir()`-style isolated paths.
  Never commit credentials or personal files.
- **TypeScript-first source** in `src/`, built to `lib/` (ESM). Keep the
  dependency surface minimal: `@earendil-works/pi-coding-agent` (TUI/theme)
  plus dsh packages.

## Commit discipline

- Use **git** (not jj).
- **Author and committer** must both be the repository owner's GitHub
  identity (resolve via `gh api user --jq .login`).
- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`.
  Short title explaining the *why* + a description of *what* changed.
- One logical change per commit; stage only files belonging to that change.
- ALWAYS end the title with `[AGENT]` (e.g.
  `feat: bridge dsh agent events to pi session model [AGENT]`).
- Verify before committing: `git diff --check`, lint, and the bundle boots
  (`dsh --profile tui-pi --dump-config`, tmux smoke test).

## Verification

- Parity target: the `tui` profile (`@dsh-tui/dsh-tui`) as the functional
  reference — same turns, tools, reasoning, `/resume`, and credentials work
  through this bundle's front door.
- TUI verification happens in a real terminal: tmux session + `capture-pane`.
- CI-style checks: schema validation on boot, plugin load without loader
  errors, clean `--dump-config` composition.
