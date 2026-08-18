#!/usr/bin/env node
/**
 * @dsh-pi/migrate CLI.
 *
 *   dsh-pi-migrate                    # dry-run plan for ~/.pi/agent -> ~/.dsh/profiles/tui-pi
 *   dsh-pi-migrate --apply            # write the migrated config into the profile
 *   dsh-pi-migrate --pi-home DIR      # another pi home
 *   dsh-pi-migrate --profile DIR      # another target profile dir
 *
 * The default profile dir is $DSH_HOME/profiles/tui-pi. Everything is neutral:
 * values come from the source installation, never from this program.
 */
import { join } from "node:path";
import { DEFAULT_DSH_HOME, planMigration, applyMigration } from "./index.js";

function parseArgs(argv) {
  const out = { apply: false, piHome: undefined, profileDir: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--pi-home" && argv[i + 1]) out.piHome = argv[i + 1], i++;
    else if (a === "--profile" && argv[i + 1]) out.profileDir = argv[i + 1], i++;
    else if (a === "-h" || a === "--help") out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log([
    "dsh-pi-migrate — migrate a pi installation into a dsh profile",
    "",
    "usage:",
    "  dsh-pi-migrate                     plan only (default, dry run)",
    "  dsh-pi-migrate --apply              write the migrated config",
    "  dsh-pi-migrate --pi-home DIR        source pi agent dir (default ~/.pi/agent)",
    "  dsh-pi-migrate --profile DIR        target profile dir (default $DSH_HOME/profiles/tui-pi)",
  ].join("\n"));
  process.exit(0);
}

const piHome = args.piHome;
const profileDir = args.profileDir ?? join(DEFAULT_DSH_HOME(), "profiles", "tui-pi");

const result = applyMigration({ piHome, profileDir, dryRun: !args.apply });

console.log(`pi home:      ${piHome ?? "~/.pi/agent"}`);
console.log(`profile:      ${profileDir}`);
console.log(`mode:         ${args.apply ? "apply" : "dry-run"}`);
console.log("");
if (result.plan.settings.agentLoop) {
  console.log(`model:        ${result.plan.settings.agentLoop.model} (provider ${result.plan.settings.agentLoop.provider})`);
}
if (result.plan.settings.theme) console.log(`theme:        ${result.plan.settings.theme}`);
if (result.plan.settings.thinkingLevel) console.log(`thinking:     ${result.plan.settings.thinkingLevel}`);
console.log(`themes:       ${result.plan.themes.length} custom theme file(s)`);
console.log(`extensions:   ${result.plan.extensions.npm.length} npm package(s), ${result.plan.extensions.files.length} standalone file(s)`);
console.log("");
for (const w of result.report.written) console.log(`  will write: ${w}`);
for (const cmd of result.installCommands) console.log(`  run:        ${cmd}`);
for (const note of result.plan.notes) console.log(`  note:       ${note}`);
if (!args.apply) {
  console.log("\n(dry run — re-run with --apply to write)");
}
