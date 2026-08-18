#!/usr/bin/env bash
# Dev helper for the dsh-pi-tui-mono monorepo.
#
# Links the local checkout into the `tui-pi` profile so edits apply without a
# pnpm reinstall:
#   1. Symlinks the runtime dsh packages (global install) + pi packages into
#      the repo root node_modules — the workspace packages resolve them from
#      there (node resolves against the realpath of the symlinked package).
#   2. Installs the remaining workspace deps from npm (pi2dsh, etc.).
#   3. Symlinks each workspace package into the profile node_modules.
#   4. Rewrites the profile's `dsh.profile.bundles` to the workspace packages.
set -eu

repo="$(cd "$(dirname "$0")/.." && pwd)"
profile="$HOME/.dsh/profiles/tui-pi"
global="$HOME/.bun/install/global/node_modules"

mkdir -p "$repo/node_modules/@deepseek-ai" "$repo/node_modules/@earendil-works"
# Link the ENTIRE global dsh + pi scope: pi2dsh peers against many @deepseek-ai
# packages, and the profile runtime resolves them from the global install.
for scope in @deepseek-ai @earendil-works; do
  for p in "$global/$scope"/*; do
    [ -d "$p" ] && ln -sfn "$p" "$repo/node_modules/$scope/$(basename "$p")"
  done
done
ln -sfn "$global/commander" "$repo/node_modules/commander" 2>/dev/null || true

# Workspace deps not present in the global install (pi2dsh and friends).
if [ -d "$repo/node_modules/pi2dsh" ] || [ -d "$HOME/.pi/agent/npm/node_modules/pi2dsh" ]; then
  ln -sfn "${PI2DSH_DIR:-$HOME/.pi/agent/npm/node_modules/pi2dsh}" "$repo/node_modules/pi2dsh" 2>/dev/null || true
fi

# pnpm install creates store links for @earendil-works/@deepseek-ai that SHADOW
# the global install (e.g. pi-coding-agent@0.80.x from the npm registry instead
# of the global 0.84.x). The whole point of this project is that the TUI ships
# with the INSTALLED pi, so force-link the global scope into every workspace
# package's node_modules after any pnpm install.
for pkgdir in "$repo"/packages/*; do
  [ -d "$pkgdir" ] || continue
  mkdir -p "$pkgdir/node_modules/@deepseek-ai" "$pkgdir/node_modules/@earendil-works"
  for scope in @deepseek-ai @earendil-works; do
    for p in "$global/$scope"/*; do
      [ -d "$p" ] && ln -sfn "$p" "$pkgdir/node_modules/$scope/$(basename "$p")"
    done
  done
done

# Link the workspace packages into the profile.
mkdir -p "$profile/node_modules/@dsh-pi"
for pkg in tui extensions migrate; do
  rm -rf "$profile/node_modules/@dsh-pi/$pkg"
  ln -s "$repo/packages/$pkg" "$profile/node_modules/@dsh-pi/$pkg"
done

# The patch's `pi2dsh` row resolves the package name from the profile's
# node_modules; mirror the workspace install there.
if [ -d "$repo/node_modules/.pnpm" ]; then
  pi2dsh_dir=$(ls -d "$repo/node_modules/.pnpm/pi2dsh@"*/node_modules/pi2dsh 2>/dev/null | head -1)
  [ -n "$pi2dsh_dir" ] && rm -f "$profile/node_modules/pi2dsh" && ln -s "$pi2dsh_dir" "$profile/node_modules/pi2dsh"
fi

# The profile node_modules carries STALE pnpm copies of @earendil-works/* and
# @deepseek-ai/* (from an earlier `dsh plugin add`), and dsh's bundle loader
# resolves bundle imports against the profile — so force-link the global scope
# there as well, guaranteeing every run uses the INSTALLED pi (update-proof).
# A plain `ln -sfn` cannot replace a real directory, so remove the stale copy
# first (these paths are exactly the scope dirs this script manages).
mkdir -p "$profile/node_modules/@deepseek-ai" "$profile/node_modules/@earendil-works"
for scope in @deepseek-ai @earendil-works; do
  for p in "$global/$scope"/*; do
    [ -d "$p" ] || continue
    target="$profile/node_modules/$scope/$(basename "$p")"
    [ -d "$target" ] && rm -rf "$target"
    ln -s "$p" "$target"
  done
done

# Point the profile's bundle list at the workspace packages.
python3 - "$profile" <<'EOF'
import json, sys
profile = sys.argv[1]
path = f"{profile}/package.json"
data = json.load(open(path))
bundles = data.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", [])
base = "@deepseek-ai/dsh-base"
wanted = [base, "@dsh-pi/tui", "@dsh-pi/extensions"]
if bundles != wanted:
    data["dsh"]["profile"]["bundles"] = wanted
    json.dump(data, open(path, "w"), indent=2)
    print(f"bundles -> {wanted}")
else:
    print("bundles already correct")
EOF

echo "linked: $repo/packages/{tui,extensions,migrate} -> $profile/node_modules/@dsh-pi/"
