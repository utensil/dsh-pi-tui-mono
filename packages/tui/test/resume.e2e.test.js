// In-process /resume E2E with REAL dsh services (no mocks): a persisted dsh
// session log is resumed through ctx.agents.resume and the runtimeHost's
// switchSession, exactly like the live flow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zstdCompressSync } from "node:zlib";
import { Context } from "@deepseek-ai/cordis";
import SessionStore from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import * as SkillRegistry from "@deepseek-ai/dsh-skill-filesystem";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import Persistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import { createRuntimeHost } from "../lib/bridge.js";

test("in-process /resume E2E: a real persisted dsh session resumes through switchSession", async () => {
  const base = mkdtempSync(join(tmpdir(), "dsh-resume-e2e-"));
  const root = join(base, "persist");
  mkdirSync(root, { recursive: true });
  const id = "main-session-123e4567-e89b-12d3-a456-426614174000";
  const tmpRoot = tmpdir();
  const cwdSeg = `--${tmpRoot.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const logDir = join(root, cwdSeg, id);
  mkdirSync(logDir, { recursive: true });
  const header = JSON.stringify({ type: "session", version: 0, id, createdAt: Date.now(), cwd: tmpRoot, delegationDepth: 0 }) + "\n";
  const events = [
    JSON.stringify({ type: "user/message", seq: 0, time: Date.now(), data: { content: [{ type: "text", text: "hello persisted" }], source: { kind: "user" }, role: "user", id: "msg-1" }, surfaceOp: "append" }),
    JSON.stringify({ type: "assistant/message", seq: 1, time: Date.now() + 1, data: { turn: 1, step: 1, message: { id: "msg-2", role: "assistant", content: [{ type: "text", text: "welcome back" }], source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" } } }, surfaceOp: "append" }),
  ].join("\n") + "\n";
  writeFileSync(join(logDir, "session.jsonl.zstd"), Buffer.concat([zstdCompressSync(Buffer.from(header)), zstdCompressSync(Buffer.from(events))]));

  const ctx = new Context();
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false });
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(CommandRuntime);
  await ctx.plugin(SkillRegistry, {});
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(LlmRuntime, {});
  await ctx.plugin(Persistence, { root, compression: "zstd" });
  await ctx.plugin(AgentLoop, { agents: [] });

  // The tui runtimeHost's switchSession uses ctx.agents.resume (the real path).
  const sessionsDir = join(base, "bridge");
  const projcache = join(base, "projcache.json");
  writeFileSync(projcache, JSON.stringify({ tables: { sessions: { [id]: { identity: { cwd: tmpRoot }, rows: { title: { val: "E2E" } } } } } }));
  const agent = { session: { header: { cwd: "/boot" }, events: [], model: "x", append() {} }, followup() {}, steer() {}, cancel() {}, ctx: { on: () => () => {} }, options: {} };
  const hostCtx = { on: () => () => {}, agents: ctx.agents };
  const rt = createRuntimeHost(hostCtx, agent, "main-session-boot", { sessionsDir, projcachePath: projcache });
  // the bridge file for the persisted session
  const file = join(sessionsDir, `${id}.jsonl`);
  assert.ok(readdirSync(sessionsDir).includes(`${id}.jsonl`), "bridge file generated");

  let rebound = null;
  rt.setRebindSession((s) => { rebound = s; });
  const result = await rt.switchSession(file);
  assert.equal(result.cancelled, false);
  assert.ok(rebound, "rebind callback invoked");
  assert.equal(rebound.sessionId, id, "runtime session is the resumed id");

  // the real resume loaded the persisted events; replayHistory renders them
  const emitted = [];
  rebound.subscribe((e) => emitted.push(e));
  rebound.replayHistory();
  assert.ok(
    emitted.some((e) => e.type === "message_end" && e.message?.content?.[0]?.text === "welcome back"),
    "the persisted assistant reply renders after the real resume",
  );
});
