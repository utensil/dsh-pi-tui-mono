#!/usr/bin/env bash
# tmux render regression for @dsh-pi/tui.
#
# Boots the tui-pi profile with a scripted transcript (mermaid + latex), with
# NO model interaction at all: the tui plugin replays dsh session events
# through agent.session.append after boot and the TUI renders them. We then
# capture the pane and assert the rendered artifacts (box-drawing diagram,
# unicode latex symbols).
#
# Usage: scripts/test-tui-render.sh [tmux-session-name]
set -eu

repo="$(cd "$(dirname "$0")/.." && pwd)"
session="${1:-dsh-pi-render}"
transcript="$repo/packages/tui/test/fixtures/render-transcript.json"

# A --patch overlay sets the tui row's TEST-ONLY transcript path. The overlay
# must restate the whole tui row config (patches replace per row).
overlay="$(mktemp -t dsh-pi-overlay.XXXXXX.yml)"
cat > "$overlay" <<EOF
- id: tui
  config:
    sessionId: !!js ctx.tuiStartup.sessionId
    testTranscript: "$transcript"
EOF

tmux kill-session -t "$session" 2>/dev/null || true
sleep 1
tmux new-session -d -s "$session" -x 160 -y 44 \
  "cd '$repo' && dsh --profile tui-pi --patch '$overlay' 2>/dev/null"
sleep 25

pane="$(tmux capture-pane -p -t "$session:0")"
tmux kill-session -t "$session" 2>/dev/null || true
rm -f "$overlay"

# Assertions target RENDERED artifacts, not the TUI frame's own box drawing:
# the mermaid diagram's arrow (`├───▶`) and the latex unicode.
fail=0
if echo "$pane" | grep -qE "├───▶"; then
  echo "PASS: mermaid box-drawing diagram rendered"
else
  echo "FAIL: no mermaid diagram (arrow ├───▶) in the pane"
  fail=1
fi
if echo "$pane" | grep -q "∫"; then
  echo "PASS: latex integral symbol rendered"
else
  echo "FAIL: no latex integral symbol in the pane"
  fail=1
fi
if echo "$pane" | grep -qE "mc²"; then
  echo "PASS: latex superscript rendered (mc²)"
else
  echo "FAIL: no latex superscript in the pane"
  fail=1
fi

[ "$fail" -eq 0 ] && echo "render regression: OK" || echo "render regression: FAILED"
exit "$fail"
