# pi TUI parity — verified features

This bundle mounts pi's real `InteractiveMode` (`@earendil-works/pi-coding-agent`)
over the dsh agent runtime. The features below are **verified working** (live in
a real terminal, tmux + herdr `pane.read`) and covered by regression tests in
`test/session-shim.test.js` (`npm test` / `node --test test/`).

## Faithful event translation

The bridge translates dsh session events to pi session events 1:1 — it does not
reorder or reconstruct content.

- One pi message per dsh step: dsh `assistant/message` → pi `message_end`
  (each model request renders as its own assistant message).
- Content blocks keep the **natural order** produced by the model:
  dsh `reasoning` → pi `thinking`, `text` → `text`, `tool-call` → `toolCall`,
  `image` → `image` (mime/data preserved). Interleaved
  `text → tool-call → text` renders in that exact order.
- `tool/call` → **`tool_execution_start` only**: the step's message (with the
  toolCall block) has already settled, so the card renders right after it and
  before any post-tool text — matching pi's layout
  (`thinking → card → post-tool reply`).
- `tool/result` → `tool_execution_end` with the nested result content and
  `isError`.
- Completed tools leave the streaming content, so later updates never re-create
  a duplicate card.

Verified layout (matches real pi): `thinking → card X → thinking + text →
card Y → final text`.

## Thinking rendering

dsh streams reasoning as `reasoning-delta` chunks inside `block-start/…/block-end`
blocks; the bridge accumulates them into pi `thinking` content (dim italic,
exactly pi's style), one block per step (no cross-step flooding).

## Tool cards

- Arguments arrive as a JSON string; they are parsed so the card shows the real
  command (`$ echo X`, not `$ …`).
- The tool output (nested in the dsh `tool-result` block) renders in the card,
  plus `isError`.
- Duration is real (`Took 1.0s` for a `sleep 1`), driven by the
  `tool_execution_start` → `tool_execution_end` gap.

## Model switching

- Default model: `deepseek-v4-flash` (agent config + shim defaults).
- `/model` (pi's dialog) switches flash ⇄ pro. The switch drives
  `installModelSelection(agent.ctx, target)` with provider
  **`deepseek-official`** (the dsh provider id — using `deepseek` breaks every
  request), updates the footer state, and applies to future steps.

## Session persistence + resume

- Sessions persist via the dsh storage stack (projection cache); `--resume
  <session-id>` continues the conversation (verified: resumed session
  remembered prior turns).
- Resume registers the agent asynchronously; the bundle waits for it instead of
  failing on the synchronous lookup.

## pi 0.84.2 markdown rendering (inherited)

pi updates flow through automatically (the bundle imports pi as a dependency):
- ` ```mermaid ` fences → **Unicode box-drawing diagrams** (grok-mermaid
  transformer, `markdown.mermaid` setting, default `streaming`).
- `$…$` / `$$…$$` LaTeX → **symbol/layout rendering** (pi-tui's LatexParser).
- `![alt](path)` in assistant text shows alt text only — same as pi, by design.
- Real images render via **tool results** (`Image` component) in terminals with
  image protocols (Kitty/iTerm2/Warp); pi disables them under tmux.

## Escape interrupt

Escape during a turn routes to `session.agent.abort()` → dsh `agent.cancel()`,
which clears the inbox and aborts the running phase.

## Slash commands

- Works: `/model` (flash ⇄ pro), `/scoped-models`, `/export` (session → JSONL/HTML
  file), `/name <name>` (persists a `session/title` event), `/hotkeys`, `/quit`.
- `--resume <id>` continues a persisted session (the `/resume` UI picker needs
  pi's file-based session store and is not bridged).
- Not applicable to dsh (reject with a descriptive message): `/new`, `/import`,
  `/login`, `/logout`, `/share`, `/clone`, `/trust`, `/settings`, `/tree`,
  `/fork`, `/session` pickers.

## Images: read vs read_image (dsh design)

dsh deliberately splits file access: the `read` tool is UTF-8 text only and
rejects binary files at the filesystem layer (`dsh-fs-local`, NUL-byte
detection) — unlike pi's `read`, which auto-detects images. Images display
through the dedicated `read_image` tool, which is **gated on the model's image
capability** (`deepseek-v4-flash` has none; a vision-capable model would
return an image block that the TUI renders in the tool card). The bundle adds
system-prompt guidance so agents use `read_image` for image paths instead of
hitting `read`'s binary rejection. The bridge itself renders image blocks
faithfully (unit-tested).

## dsh identity (not pi)

- `PI_OFFLINE=1` suppresses pi's "Update Available / run pi update" popup and
  pi's model-catalog network fetches.
- `getQuietStartup`/`getCollapseChangelog` → true hides the "pi vX" banner,
  startup hints, and the changelog notice. The TUI shell remains pi's (the
  design premise); the terminal title and hardcoded "pi" strings are inherited.

## Regression test coverage

| Test | Guards |
|---|---|
| faithful turn lifecycle | agent_start/user/assistant/message_end/agent_end order; content blocks |
| tool turn order | message_end < tool_execution_start < tool_execution_end < next message |
| no duplicate tool cards | completed tools absent from later updates; one card per call |
| natural content order | `text, toolCall, text` preserved in one step |
| image blocks | dsh `image` → pi `ImageContent` (data/mimeType) |
| finish-only reply | a step with no streaming chunks still renders |
| model switch | footer state + closure model updated (regression: shadowing bug) |
| escape interrupt | `session.agent.abort()` → `agent.cancel("interrupted")` |
| prompt resolves | `prompt()` promise settles on `turn/end` |
