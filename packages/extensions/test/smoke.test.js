import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { Context } from "@deepseek-ai/cordis";
import SessionStore from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import * as SkillRegistry from "@deepseek-ai/dsh-skill-filesystem";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import { applyPiHost, resolvePiPackage, analyzePackage } from "pi2dsh";

/** The short list is the SAME set of pi extensions installed on the reference
 * device (~/.pi/agent/npm/node_modules). CI installs these exact packages as
 * devDependencies and smokes each; locally the real installs are used when
 * present. */
export const SMOKE_LIST = [
  "pi-codex-goal",
  "pi-web-access",
  "pi-sidequest",
  "pi-boomerang",
  "pi-subagents",
  "pi-dynamic-workflows",
];

function resolveExtensionDir(name) {
  // Local pi install first (exact device versions), then the workspace
  // node_modules (CI installs the same short list as devDependencies).
  const piDir = join(homedir(), ".pi", "agent", "npm", "node_modules", name);
  if (existsSync(join(piDir, "package.json"))) return { dir: piDir, source: "local-pi" };
  const require = createRequire(import.meta.url);
  try {
    return { dir: join(require.resolve(`${name}/package.json`), ".."), source: "node_modules" };
  } catch {
    return undefined;
  }
}

async function mountExtension(dir) {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(CommandRuntime);
  await ctx.plugin(SkillRegistry, {});
  await ctx.plugin(AgentRegistry);
  // applyPiHost throws only when every requested package failed to mount —
  // for a single package, no throw means its extension factory ran and its
  // tool/command registration executed without error (a real smoke).
  await applyPiHost(ctx, { packages: [{ name: dir }] });
  return ctx;
}

for (const name of SMOKE_LIST) {
  test(`smoke: ${name} loads + registers + has no FATAL interface gaps`, async (t) => {
    const resolved = resolveExtensionDir(name);
    if (resolved === undefined) {
      // In CI the packages are devDependencies; locally the pi install may be
      // absent. A missing package is a SKIP, not a failure — the short list is
      // what the reference device installs.
      t.skip(`${name} not resolvable (no local pi install, not in node_modules)`);
      return;
    }
    t.diagnostic(`resolved from ${resolved.source}`);
    let ctx;
    try {
      ctx = await mountExtension(resolved.dir);
    } catch (err) {
      assert.fail(`${name} failed to mount: ${err.message}`);
    }
    assert.ok(ctx, `${name} mounted`);
    // Static ABI analysis: no FATAL interface usage (surfaces pi2dsh cannot
    // serve at all would break at runtime; 'partial'/'unsupported' are the
    // documented degradation status and are recorded, not failed).
    const pkg = await resolvePiPackage(resolved.dir);
    const report = await analyzePackage(pkg);
    t.diagnostic(
      `${name} verdict=${report.verdict} full=${report.summary.full} ` +
      `partial=${report.summary.partial} unsupported=${report.summary.unsupported} fatal=${report.summary.fatal}`,
    );
    assert.equal(report.summary.fatal, 0, `${name}: no FATAL interface gaps`);
    if (report.summary.unsupported > 0) {
      t.diagnostic(`${name}: ${report.summary.unsupported} unsupported surface(s) — runtime behavior there is degraded by design (pi2dsh limits)`);
    }
  });
}
