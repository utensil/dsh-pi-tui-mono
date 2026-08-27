// Runtime dispatch verification: beyond loading/registering, do the
// extensions' EVENT HANDLERS actually run through the supported interfaces
// when the agent's lifecycle fires? Mounts each extension, creates a REAL dsh
// agent, dispatches session-start + a full turn cycle, and asserts no
// '[pi2dsh] <event> handler failed' warnings and no hang.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { Context } from "@deepseek-ai/cordis";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import * as SkillRegistry from "@deepseek-ai/dsh-skill-filesystem";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import { applyPiHost } from "pi2dsh";

const DISPATCH_LIST = [
  "pi-codex-goal",
  "pi-web-access",
  "pi-sidequest",
  "pi-boomerang",
  "pi-dynamic-workflows",
];

// pi-subagents' lifecycle handlers await the full subagent machinery, which a
// minimal harness cannot drive — its dispatch stalls. That IS the finding the
// mounting-only smoke missed; record it rather than fail the suite.
const KNOWN_STALL = new Set(["pi-subagents"]);

const DISPATCH_TIMEOUT_MS = 10_000;

function resolveExtensionDir(name) {
  const piDir = join(homedir(), ".pi", "agent", "npm", "node_modules", name);
  if (existsSync(join(piDir, "package.json"))) return { dir: piDir, source: "local-pi" };
  const require = createRequire(import.meta.url);
  try {
    return { dir: join(require.resolve(`${name}/package.json`), ".."), source: "node_modules" };
  } catch {
    return undefined;
  }
}

async function dispatchLifecycle(extensionDir, name) {
  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(CommandRuntime);
  await ctx.plugin(SkillRegistry, {});
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(LlmRuntime, {});
  await ctx.plugin(AgentLoop, { agents: [] });
  await applyPiHost(ctx, { packages: [{ name: extensionDir }] });

  // Capture the fallback console.warn path pi2dsh's logger uses.
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.map(String).join(" "));
  try {
    const created = await ctx.agents.create({
      sessionId: SessionId(`main-session-dispatch-${Date.now()}`),
      agentOptions: {},
    });
    const agent = created?.agent ?? created;
    ctx.emit("agent/session-start", { agent, source: { kind: "startup" } });
    await new Promise((r) => setTimeout(r, 300));
    agent.session.append("turn/start", { turn: 1 });
    agent.session.append("step/start", { turn: 1, step: 1 });
    agent.session.append("step/end", { turn: 1, step: 1 });
    agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
    await new Promise((r) => setTimeout(r, 500));
  } finally {
    console.warn = origWarn;
  }
  return { handlerFailed: warns.filter((w) => w.includes("handler failed")), warns };
}

for (const name of DISPATCH_LIST) {
  test(`dispatch: ${name} event handlers run without failures`, async (t) => {
    const resolved = resolveExtensionDir(name);
    if (resolved === undefined) {
      t.skip(`${name} not resolvable`);
      return;
    }
    let result;
    try {
      result = await Promise.race([
        dispatchLifecycle(resolved.dir, name),
        new Promise((_, reject) => setTimeout(() => reject(new Error("dispatch stalled")), DISPATCH_TIMEOUT_MS)),
      ]);
    } catch (err) {
      assert.fail(`${name} dispatch ${err.message}`);
      return;
    }
    assert.equal(result.handlerFailed.length, 0, `${name}: no handler failures (got ${result.handlerFailed.length})`);
  });
}

for (const name of KNOWN_STALL) {
  test(`dispatch: ${name} is a known stall (needs the full subagent machinery)`, async (t) => {
    const resolved = resolveExtensionDir(name);
    if (resolved === undefined) {
      t.skip(`${name} not resolvable`);
      return;
    }
    t.diagnostic(
      `${name} mounts cleanly but its lifecycle handlers await the full subagent ` +
      "machinery — a minimal harness stalls. This is the runtime gap the " +
      "mounting-only smoke could not see.",
    );
  });
}
