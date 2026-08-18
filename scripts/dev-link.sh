#!/usr/bin/env bash
# Dev helper: link the local checkout into the tui-pi profile so edits apply
# without a pnpm reinstall. The profile's node_modules must be a symlink to
# this repo, and this repo's node_modules must resolve the runtime packages
# (they live in the global dsh installation, not npm).
set -eu

repo="${1:-$HOME/projects/dsh-pi-tui-shim}"
profile="$HOME/.dsh/profiles/tui-pi"

mkdir -p "$repo/node_modules/@deepseek-ai" "$repo/node_modules/@earendil-works"
for p in cordis schemastery dsh-session dsh-llm dsh-agent-loop dsh-agent dsh-cmdline; do
  ln -sfn "$HOME/.bun/install/global/node_modules/@deepseek-ai/$p" "$repo/node_modules/@deepseek-ai/$p"
done
ln -sfn "$HOME/.bun/install/global/node_modules/@earendil-works/pi-coding-agent" "$repo/node_modules/@earendil-works/pi-coding-agent"
ln -sfn "$HOME/.bun/install/global/node_modules/commander" "$repo/node_modules/commander" 2>/dev/null || true

rm -rf "$profile/node_modules/dsh-pi-tui-shim"
ln -s "$repo" "$profile/node_modules/dsh-pi-tui-shim"

echo "linked: $repo -> $profile/node_modules/dsh-pi-tui-shim"
