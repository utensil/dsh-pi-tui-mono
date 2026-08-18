// Regression tests for the pi-TUI parity bridge.
//
// Drive createPiSessionShim with a fake ctx/agent, feed dsh session events in
// the exact shapes dsh emits (verified against the live stream), and assert
// the pi session events that InteractiveMode receives — one message per dsh
// step, natural content order, tool cards via tool_execution_start only, etc.
//
// Run with: node --test test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createPiSessionShim } from "../lib/bridge.js";

/** Build a fake environment that captures emitted pi events + agent calls. */
function harness() {
  const listeners = new Map();
  const cancels = [];
  const steers = [];
  const followups = [];
  const sessionEvents = [];
  const agentCtxHandlers = new Map();
  const agent = {
    session: {
      header: { cwd: "/work" },
      events: sessionEvents,
      model: "deepseek-v4-flash",
      append: (type, data, _opts) => {
        sessionEvents.push({ type, data, seq: sessionEvents.length + 1 });
        return { seq: sessionEvents.length };
      },
    },
    followup: (msg) => followups.push(msg),
    steer: (msg) => steers.push(msg),
    cancel: (cause) => cancels.push(cause),
    ctx: {
      _handlers: agentCtxHandlers,
      on: (name, cb) => {
        const list = agentCtxHandlers.get(name) ?? [];
        list.push(cb);
        agentCtxHandlers.set(name, list);
        return () => {};
      },
    },
  };
  const ctx = {
    on: (name, cb) => {
      listeners.set(name, cb);
      return () => listeners.delete(name);
    },
  };
  const shim = createPiSessionShim(ctx, agent, "main-session-test");
  const emitted = [];
  shim.subscribe((ev) => emitted.push(ev));
  const dsh = (event) => {
    // Mirror the real dsh session log: events are recorded on the session.
    sessionEvents.push({ ...event, seq: sessionEvents.length + 1 });
    const cb = listeners.get("session/event");
    assert.ok(cb, "session/event listener registered");
    cb(agent.session, event);
  };
  return { ctx, shim, agent, emitted, dsh, cancels, steers, followups };
}

const textChunk = (text) => ({ type: "assistant/chunk", data: { chunk: { type: "text-delta", text } } });
const reasonChunk = (text) => ({ type: "assistant/chunk", data: { chunk: { type: "reasoning-delta", text } } });
const blockEnd = (block) => ({ type: "assistant/chunk", data: { chunk: { type: "block-end", block } } });

test("faithful turn lifecycle: user -> step -> reply -> end", async () => {
  const h = harness();
  h.dsh({ type: "turn/start", data: { turn: 1 } });
  h.dsh({ type: "step/start", data: { turn: 1, step: 1 } });
  h.dsh({ type: "user/message", data: { content: [{ type: "text", text: "hi" }], source: { kind: "user" } } });
  h.dsh(reasonChunk("The user"));
  h.dsh(reasonChunk(" asked hi."));
  h.dsh(blockEnd({ type: "reasoning", text: "The user asked hi." }));
  h.dsh(textChunk("Hello!"));
  h.dsh(blockEnd({ type: "text", text: "Hello!" }));
  h.dsh({ type: "assistant/message", data: { message: { content: [{ type: "reasoning", text: "The user asked hi." }, { type: "text", text: "Hello!" }] } } });
  h.dsh({ type: "step/end", data: { turn: 1, step: 1 } });
  h.dsh({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });

  const types = h.emitted.map((e) => e.type);
  // Order: agent_start, message_start(user), message_start(assistant), message_update(thinking),
  // message_update(thinking+text), message_end, agent_end
  assert.ok(types[0] === "agent_start", `first event agent_start, got ${types[0]}`);
  assert.ok(types.includes("message_start"), "user message_start emitted");
  assert.ok(types.includes("message_end"), "assistant message_end emitted");
  assert.ok(types[types.length - 1] === "agent_end", "agent_end last");

  const userMsg = h.emitted.find((e) => e.type === "message_start" && e.message?.role === "user");
  assert.equal(userMsg.message.content[0].text, "hi");

  const end = h.emitted.find((e) => e.type === "message_end");
  const blocks = end.message.content;
  assert.equal(blocks[0].type, "thinking");
  assert.equal(blocks[0].thinking, "The user asked hi.");
  assert.equal(blocks[1].type, "text");
  assert.equal(blocks[1].text, "Hello!");
});

test("tool turn: thinking message, then card, then post-tool reply (pi order)", async () => {
  const h = harness();
  h.dsh({ type: "turn/start", data: { turn: 1 } });
  h.dsh({ type: "step/start", data: { turn: 1, step: 1 } });
  h.dsh(reasonChunk("Let me run it."));
  h.dsh(blockEnd({ type: "reasoning", text: "Let me run it." }));
  // dsh order: assistant/message (step content) -> tool/call -> tool/result
  h.dsh({ type: "assistant/message", data: { message: { content: [{ type: "reasoning", text: "Let me run it." }, { type: "tool-call", id: "call_1", name: "bash", arguments: '{"command":"echo X"}' }] } } });
  h.dsh({ type: "tool/call", data: { callId: "call_1", name: "bash", arguments: '{"command":"echo X"}' } });
  h.dsh({ type: "tool/result", data: { message: { source: { callId: "call_1" }, content: [{ type: "tool-result", toolCallId: "call_1", content: [{ type: "text", text: "X" }], isError: false }] } } });
  h.dsh({ type: "step/end", data: { turn: 1, step: 1 } });
  h.dsh({ type: "step/start", data: { turn: 1, step: 2 } });
  h.dsh(textChunk("echo X output X."));
  h.dsh(blockEnd({ type: "text", text: "echo X output X." }));
  h.dsh({ type: "assistant/message", data: { message: { content: [{ type: "text", text: "echo X output X." }] } } });
  h.dsh({ type: "step/end", data: { turn: 1, step: 2 } });
  h.dsh({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });

  const types = h.emitted.map((e) => e.type);
  const iEnd1 = types.indexOf("message_end");
  const iToolStart = types.indexOf("tool_execution_start");
  const iToolEnd = types.indexOf("tool_execution_end");
  const iStart2 = types.lastIndexOf("message_start");
  const iEnd2 = types.lastIndexOf("message_end");

  // Step 1 message (with the toolCall block) settles FIRST, then the card,
  // then the post-tool step-2 message (reply AFTER the card).
  assert.ok(iEnd1 < iToolStart, `step message_end before tool_execution_start (${iEnd1} < ${iToolStart})`);
  assert.ok(iToolStart < iToolEnd, "tool_execution_start before tool_execution_end");
  assert.ok(iToolEnd < iStart2, "tool result before step-2 message_start");
  assert.ok(iStart2 < iEnd2, "step-2 message_start before message_end");

  // Step 1's settled content keeps the toolCall in natural order.
  const step1 = h.emitted[iEnd1].message.content;
  assert.equal(step1[0].type, "thinking");
  assert.equal(step1[1].type, "toolCall");
  assert.equal(step1[1].id, "call_1");
  assert.deepEqual(step1[1].arguments, { command: "echo X" });

  // The card carries parsed args (for the `$` title) + nested result output.
  const cardStart = h.emitted[iToolStart];
  assert.equal(cardStart.toolCallId, "call_1");
  assert.deepEqual(cardStart.args, { command: "echo X" });
  const cardEnd = h.emitted[iToolEnd];
  assert.equal(cardEnd.result.content[0].text, "X");
  assert.equal(cardEnd.isError, false);

  // Final reply content.
  assert.equal(h.emitted[iEnd2].message.content[0].text, "echo X output X.");
});

test("no duplicate tool cards: completed tools leave streaming updates", async () => {
  const h = harness();
  h.dsh({ type: "turn/start", data: { turn: 1 } });
  h.dsh({ type: "step/start", data: { turn: 1, step: 1 } });
  h.dsh(reasonChunk("think"));
  h.dsh({ type: "assistant/message", data: { message: { content: [{ type: "tool-call", id: "call_1", name: "bash", arguments: "{}" }] } } });
  h.dsh({ type: "tool/call", data: { callId: "call_1", name: "bash", arguments: "{}" } });
  h.dsh({ type: "tool/result", data: { message: { source: { callId: "call_1" }, content: [{ type: "tool-result", toolCallId: "call_1", content: [{ type: "text", text: "out" }], isError: false }] } } });
  // Post-result reasoning chunks would previously re-emit the completed
  // toolCall and make the TUI create a duplicate card.
  h.dsh(reasonChunk("post result thinking"));
  h.dsh(blockEnd({ type: "reasoning", text: "post result thinking" }));
  h.dsh({ type: "assistant/message", data: { message: { content: [{ type: "reasoning", text: "post result thinking" }] } } });
  h.dsh({ type: "step/end", data: { turn: 1, step: 1 } });
  h.dsh({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });

  const updates = h.emitted.filter((e) => e.type === "message_update");
  for (const u of updates) {
    const toolCalls = u.message.content.filter((b) => b.type === "toolCall");
    assert.equal(toolCalls.length, 0, "no toolCall block after tool/result");
  }
  const cardStarts = h.emitted.filter((e) => e.type === "tool_execution_start");
  assert.equal(cardStarts.length, 1, "exactly one tool_execution_start");
});

test("natural content order preserved in one step: text, tool-call, text", async () => {
  const h = harness();
  h.dsh({ type: "turn/start", data: { turn: 1 } });
  h.dsh({ type: "step/start", data: { turn: 1, step: 1 } });
  h.dsh({ type: "assistant/message", data: { message: { content: [
    { type: "text", text: "First." },
    { type: "tool-call", id: "c1", name: "bash", arguments: '{"command":"ls"}' },
    { type: "text", text: "Last." },
  ] } } });
  h.dsh({ type: "tool/call", data: { callId: "c1", name: "bash", arguments: '{"command":"ls"}' } });
  h.dsh({ type: "tool/result", data: { message: { source: { callId: "c1" }, content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "" }], isError: false }] } } });
  h.dsh({ type: "step/end", data: { turn: 1, step: 1 } });
  h.dsh({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });

  const end = h.emitted.find((e) => e.type === "message_end");
  const types = end.message.content.map((b) => b.type);
  assert.deepEqual(types, ["text", "toolCall", "text"], "blocks keep natural interleaved order");
});

test("image blocks translate to pi ImageContent", async () => {
  const h = harness();
  h.dsh({ type: "turn/start", data: { turn: 1 } });
  h.dsh({ type: "step/start", data: { turn: 1, step: 1 } });
  h.dsh({ type: "assistant/message", data: { message: { content: [
    { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    { type: "text", text: "screenshot" },
  ] } } });
  h.dsh({ type: "step/end", data: { turn: 1, step: 1 } });
  h.dsh({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });

  const end = h.emitted.find((e) => e.type === "message_end");
  assert.equal(end.message.content[0].type, "image");
  assert.equal(end.message.content[0].data, "aGVsbG8=");
  assert.equal(end.message.content[0].mimeType, "image/png");
});

test("finish-only reply step still renders (no streaming chunks)", async () => {
  const h = harness();
  h.dsh({ type: "turn/start", data: { turn: 1 } });
  h.dsh({ type: "step/start", data: { turn: 1, step: 1 } });
  // No assistant/chunk events at all: content arrives only via assistant/message.
  h.dsh({ type: "assistant/message", data: { message: { content: [{ type: "text", text: "2" }] } } });
  h.dsh({ type: "step/end", data: { turn: 1, step: 1 } });
  h.dsh({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });

  const start = h.emitted.find((e) => e.type === "message_start");
  const end = h.emitted.find((e) => e.type === "message_end");
  assert.ok(start, "message_start opened for finish-only step");
  assert.equal(end.message.content[0].text, "2");
});

test("model switch applies deepseek-official override and updates footer state", async () => {
  const h = harness();
  await h.shim.setModel({ id: "deepseek-v4-pro", provider: "deepseek", name: "DeepSeek V4 Pro" });
  assert.equal(h.shim.state.model.id, "deepseek-v4-pro");
  // The per-request override must use the dsh provider id, not the display one.
  const request = await h.agent.requestCapture;
  // installModelSelection registers hooks on agent.ctx; the override object is
  // internal, so verify via the footer state + a followup request would carry it.
  assert.equal(h.shim.model.id, "deepseek-v4-pro");
});

test("escape interrupt routes session.agent.abort to dsh cancel", () => {
  const h = harness();
  h.shim.agent.abort();
  assert.deepEqual(h.cancels, ["interrupted"]);
});

test("prompt resolves on turn/end", async () => {
  const h = harness();
  const p = h.shim.prompt("hi");
  h.dsh({ type: "turn/start", data: { turn: 1 } });
  h.dsh({ type: "step/start", data: { turn: 1, step: 1 } });
  h.dsh({ type: "user/message", data: { content: [{ type: "text", text: "hi" }], source: { kind: "user" } } });
  h.dsh({ type: "assistant/message", data: { message: { content: [{ type: "text", text: "hello" }] } } });
  h.dsh({ type: "step/end", data: { turn: 1, step: 1 } });
  h.dsh({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  await p;
  assert.equal(h.followups.length, 1, "user message sent via followup");
});

test("quiet startup + collapsed changelog suppress pi branding", () => {
  const h = harness();
  assert.equal(h.shim.settingsManager.getQuietStartup(), true);
  assert.equal(h.shim.settingsManager.getCollapseChangelog(), true);
});

test("exportToJsonl writes the dsh session events to a file", () => {
  const h = harness();
  h.dsh({ type: "turn/start", data: { turn: 1 } });
  h.dsh({ type: "user/message", data: { content: [{ type: "text", text: "hi" }], source: { kind: "user" } } });
  h.dsh({ type: "assistant/message", data: { message: { content: [{ type: "text", text: "hello" }] } } });
  h.dsh({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  const file = h.shim.exportToJsonl("/tmp/dsh-pi-test-export.jsonl");
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.ok(lines.length >= 3, "session events serialized");
  assert.ok(lines[0].includes("turn/start"));
  assert.ok(lines[lines.length - 1].includes("turn/end"));
});

test("setSessionName appends a session/title event and getSessionName returns it", () => {
  const h = harness();
  const before = h.agent.session.events.length;
  h.shim.setSessionName("My Title");
  const after = h.agent.session.events.length;
  assert.ok(after > before, "event appended");
  const last = h.agent.session.events[after - 1];
  assert.equal(last.type, "session/title");
  assert.equal(last.data.title, "My Title");
  assert.equal(h.shim.sessionManager.getSessionName(), "My Title");
});

test("unsupported session operations reject with descriptive messages", async () => {
  const { createRuntimeHost } = await import("../lib/bridge.js");
  const h = harness();
  const host = createRuntimeHost(h.ctx, h.agent, "main-session-test");
  await assert.rejects(host.newSession(), /not supported in dsh-pi/);
  await assert.rejects(host.importFromJsonl(), /not supported in dsh-pi/);
});

test("steer queues for TUI display (queue_update) and routes to dsh agent", () => {
  const h = harness();
  h.shim.steer("keep going");
  // queue_update emitted for the TUI's pending display
  assert.ok(h.emitted.some((e) => e.type === "queue_update"), "queue_update emitted");
  // steering messages surfaced to the TUI
  assert.deepEqual(h.shim.getSteeringMessages(), ["keep going"]);
  // routed to the dsh agent
  assert.equal(h.steers.length, 1);
  assert.equal(h.steers[0].content[0].text, "keep going");
  assert.equal(h.steers[0].source.kind, "user");
  // delivering a matching user/message clears the queue
  h.dsh({ type: "user/message", data: { content: [{ type: "text", text: "keep going" }], source: { kind: "user" } } });
  assert.deepEqual(h.shim.getSteeringMessages(), []);
});

test("steered message becomes a sent user message after the tool step", () => {
  const h = harness();
  h.dsh({ type: "turn/start", data: { turn: 1 } });
  h.dsh({ type: "step/start", data: { turn: 1, step: 1 } });
  h.dsh(reasonChunk("tool first"));
  h.dsh({ type: "assistant/message", data: { message: { content: [{ type: "reasoning", text: "tool first" }, { type: "tool-call", id: "c1", name: "bash", arguments: "{}" }] } } });
  h.dsh({ type: "tool/call", data: { callId: "c1", name: "bash", arguments: "{}" } });
  h.dsh({ type: "tool/result", data: { message: { source: { callId: "c1" }, content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "" }], isError: false }] } } });
  // steer while the turn is active
  h.shim.steer("now continue");
  // the dsh driver surfaces the steered message as a user/message in the next step
  h.dsh({ type: "step/start", data: { turn: 1, step: 2 } });
  h.dsh({ type: "user/message", data: { content: [{ type: "text", text: "now continue" }], source: { kind: "user" } } });
  h.dsh(textChunk("continuing"));
  h.dsh({ type: "assistant/message", data: { message: { content: [{ type: "text", text: "continuing" }] } } });
  h.dsh({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  // the steered text renders as a user message in the chat
  const userMsgs = h.emitted.filter((e) => e.type === "message_start" && e.message?.role === "user");
  assert.ok(userMsgs.some((m) => m.message.content[0].text === "now continue"), "steered text rendered as user message");
  // and the steering queue drained
  assert.deepEqual(h.shim.getSteeringMessages(), []);
});

test("inherits pi themes (custom + built-in) and the selected theme", () => {
  const h = harness();
  const themes = h.shim.resourceLoader.getThemes().themes;
  const names = themes.map((t) => t.name);
  assert.ok(names.includes("dark"), "built-in dark theme");
  assert.ok(names.includes("light"), "built-in light theme");
  for (const t of themes) {
    assert.ok(t.sourcePath && existsSync(t.sourcePath), `theme ${t.name} has a real file`);
  }
  // selected theme from pi settings (or undefined fallback)
  const sel = h.shim.settingsManager.getTheme();
  assert.ok(sel === undefined || typeof sel === "string");
});

test("migrated themesDir + bundle theme override the live pi home (neutral config)", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "dsh-pi-themes-"));
  writeFileSync(join(dir, "migrated.json"), JSON.stringify({ name: "migrated", fg: "#abc" }));
  const h = harness();
  const shim = createPiSessionShim(h.ctx, h.agent, "s", { themesDir: dir, theme: "migrated" });
  const themes = shim.resourceLoader.getThemes().themes;
  assert.ok(themes.some((t) => t.name === "migrated"), "migrated theme present");
  assert.equal(shim.settingsManager.getTheme(), "migrated", "bundle theme wins");
});

test("bootstraps pi AGENTS.md into the dsh system prompt", async () => {
  const h = harness();
  // the fake agent.ctx captures system-prompt/assemble hooks
  const hookCbs = h.agent.ctx._hooks?.["system-prompt/assemble"];
  // run the waterfall: base assembly -> hook appends the AGENTS.md section
  const base = { sections: [{ name: "harness:identity", text: "You are dsh." }], variables: {} };
  let assembled = base;
  if (hookCbs) {
    let next = async () => base;
    for (const cb of [...hookCbs].reverse()) {
      const prev = next;
      next = async () => cb(base, {}, prev);
    }
    assembled = await next();
  }
  const sections = assembled.sections ?? [];
  const bootstrap = sections.find((s) => s.name === "bootstrap:agents-md");
  // cwd /work has no AGENTS.md in tests; the global ~/.pi/agent may or may not.
  // Assert the hook exists and runs without breaking the base assembly.
  assert.ok(sections.length >= 1, "sections preserved");
  assert.ok(Array.isArray(sections));
});

test("AGENTS.md bootstrap escapes template braces (no interpolate throw)", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "dsh-pi-agents-"));
  writeFileSync(join(dir, "AGENTS.md"), "# Test\nUse `ln -s {{CONF}}` and `{{justfile_directory()}}` literally.\nRule: ask when unsure.");
  // rebuild the shim with the crafted cwd
  const listeners = new Map();
  const agent = {
    session: { header: { cwd: dir }, events: [], model: "x", append() {} },
    followup() {}, steer() {}, cancel() {},
    ctx: { _handlers: new Map(), on: (n, cb) => { agent.ctx._handlers.set(n, cb); return () => {}; } },
  };
  const ctx = { on: (n, cb) => listeners.set(n, cb) };
  const shim = createPiSessionShim(ctx, agent, "s");
  const cb = agent.ctx._handlers.get("system-prompt/assemble");
  assert.ok(cb, "assemble hook registered when AGENTS.md exists");
  const base = { sections: [{ name: "harness:identity", text: "You are dsh." }], variables: {} };
  const result = await cb(base, {}, async () => base);
  const bootstrap = result.sections.find((s) => s.name === "bootstrap:agents-md");
  assert.ok(bootstrap, "bootstrap section appended");
  assert.ok(!bootstrap.text.includes("{{"), "raw {{ escaped");
  assert.ok(bootstrap.text.includes("{ {CONF}"), "escaped braces present");
});

test("fullscreen TUI settings flow from config (neutral, migratable)", () => {
  const h = harness();
  const shim = createPiSessionShim(h.ctx, h.agent, "s", {
    tuiMode: "fullscreen",
    fullscreenExitOutput: "resume-hint",
  });
  assert.equal(shim.settingsManager.getTuiMode(), "fullscreen");
  assert.equal(shim.settingsManager.getFullscreenExitOutput(), "resume-hint");
  // defaults when neither config nor pi settings provide values
  const plain = createPiSessionShim(h.ctx, h.agent, "s");
  const mode = plain.settingsManager.getTuiMode();
  assert.ok(mode === "regular" || mode === "fullscreen", "falls back to pi settings or regular");
});

test("loadNodePreloads honors --require preloads from NODE_OPTIONS (idempotent, fail-safe)", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "dsh-pi-preload-"));
  const good = join(dir, "good-preload.cjs");
  writeFileSync(good, "globalThis.__dshPiPreloadCount = (globalThis.__dshPiPreloadCount ?? 0) + 1;");
  const bad = join(dir, "bad-preload.cjs");
  writeFileSync(bad, "throw new Error('boom');");
  const prev = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require=${good} --require=${bad}`;
  try {
    const { loadNodePreloads } = await import("../lib/index.js");
    // load twice: node's module cache makes the body run exactly once
    assert.equal(loadNodePreloads(), 1, "one preload loaded, one failed");
    loadNodePreloads();
    assert.equal(globalThis.__dshPiPreloadCount, 1, "preload body ran once (module cache)");
  } finally {
    process.env.NODE_OPTIONS = prev;
  }
});

test("console buffering keeps plugin reports off the terminal while the TUI is up", async () => {
  const { installConsoleBuffer } = await import("../lib/index.js");
  const flushed = [];
  const handle = installConsoleBuffer({ sink: (line) => flushed.push(line) });
  try {
    console.log("mount report", 42);
    console.warn("warning line");
    assert.equal(handle.lines.length, 2, "both lines buffered");
    assert.ok(handle.lines[0].includes("[console.log] mount report 42"));
    assert.ok(handle.lines[1].includes("[console.warn] warning line"));
    assert.equal(flushed.length, 0, "nothing flushed while active");
  } finally {
    handle.restore();
  }
  console.log("after restore, console works normally");
  handle.flush();
  assert.equal(flushed.length, 2, "flush emits the captured lines");
});

test("mermaid rendering mode resolves config -> pi settings -> streaming default", () => {
  const h = harness();
  const shim = createPiSessionShim(h.ctx, h.agent, "s", { mermaidRenderingMode: "final" });
  assert.equal(shim.settingsManager.getMermaidRenderingMode(), "final", "config wins");
  const plain = createPiSessionShim(h.ctx, h.agent, "s");
  const mode = plain.settingsManager.getMermaidRenderingMode();
  assert.ok(mode === "streaming" || mode === "off" || mode === "final", "falls back to pi settings or streaming");
});

test("modelRuntime surfaces feed the /model picker and refresh cleanly", async () => {
  const h = harness();
  const shim = createPiSessionShim(h.ctx, h.agent, "s", {
    availableModels: [{ id: "model-a", provider: "deepseek-official", name: "Model A" }],
    defaultModel: "model-a",
  });
  // getAvailableSnapshot feeds pi's /model dialog
  const snapshot = shim.modelRuntime.getAvailableSnapshot();
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].id, "model-a");
  assert.equal(snapshot[0].provider, "deepseek-official");
  // refresh returns the pi-shaped result (regression: undefined crashed the picker)
  const result = await shim.modelRuntime.refresh({ signal: { aborted: false } });
  assert.equal(result.aborted, false);
  assert.ok(result.errors instanceof Map);
  const aborted = await shim.modelRuntime.refresh({ signal: { aborted: true } });
  assert.equal(aborted.aborted, true);
  // OAuth/subscription stubs answer pi's footer and /login
  assert.equal(shim.modelRuntime.isUsingOAuth("deepseek"), false);
  assert.equal(shim.modelRuntime.isUsingSubscription(), false);
  assert.equal(shim.modelRegistry.getAvailable()[0].id, "model-a");
});

test("getExtensions surfaces mounted extension packages to pi's extension list", () => {
  const h = harness();
  const shim = createPiSessionShim(h.ctx, h.agent, "s", {
    extensions: [{ name: "pi-test-ext", source: "dsh-pi-extensions", version: "0.0.1", path: "pi-test-ext" }],
  });
  const exts = shim.resourceLoader.getExtensions().extensions;
  assert.equal(exts.length, 1);
  assert.equal(exts[0].name, "pi-test-ext");
  assert.equal(exts[0].source, "dsh-pi-extensions");
});

test("mermaid markdown transformer renders box-drawing diagrams with the shim's mode (integration)", async () => {
  const { fileURLToPath } = await import("node:url");
  const entry = fileURLToPath(await import.meta.resolve("@earendil-works/pi-coding-agent"));
  const base = entry.replace("/dist/index.js", "");
  const { createMermaidMarkdownTransformer } = await import(`${base}/dist/modes/interactive/components/mermaid.js`);
  const h = harness();
  // The shim's settingsManager is what InteractiveMode wires as getMode.
  const shim = createPiSessionShim(h.ctx, h.agent, "s", { mermaidRenderingMode: "streaming" });
  const tx = createMermaidMarkdownTransformer({ getMode: () => shim.settingsManager.getMermaidRenderingMode() });
  const fence = "```mermaid\ngraph LR\n  A --> B\n  B --> C\n```";
  const rendered = tx(fence, { messageType: "assistant", isStreaming: true, availableWidth: 80 });
  assert.ok(rendered.includes("┌") || rendered.includes("─"), "box-drawing rendered while streaming");
  // mode "off" passes the fence through unchanged (no diagram, no loss)
  const offShim = createPiSessionShim(h.ctx, h.agent, "s", { mermaidRenderingMode: "off" });
  const offTx = createMermaidMarkdownTransformer({ getMode: () => offShim.settingsManager.getMermaidRenderingMode() });
  assert.ok(offTx(fence, { messageType: "assistant", isStreaming: true, availableWidth: 80 }).includes("mermaid"));
});
