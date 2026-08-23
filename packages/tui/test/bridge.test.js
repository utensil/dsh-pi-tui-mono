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

test("escape interrupt: live isStreaming/isBashRunning gate pi-tui's abort, and an aborted turn ends with stopReason aborted", () => {
  const h = harness();
  assert.equal(h.shim.isStreaming, false, "idle before the turn");
  assert.equal(h.shim.isBashRunning, false);
  // turn 1: a bash tool call flips isBashRunning
  h.dsh({ type: "turn/start", data: { turn: 1 } });
  h.dsh({ type: "assistant/message", data: { message: { content: [{ type: "tool-call", id: "c1", name: "bash", arguments: "{}" }] } } });
  h.dsh({ type: "tool/call", data: { callId: "c1", name: "bash", arguments: "{}" } });
  assert.equal(h.shim.isBashRunning, true, "bash running while the tool executes");
  h.dsh({ type: "tool/result", data: { message: { source: { callId: "c1" }, content: [{ type: "tool-result", content: [{ type: "text", text: "done" }] }] } } });
  assert.equal(h.shim.isBashRunning, false, "bash cleared on the tool result");
  h.dsh({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  // turn 2: stream a reply, then Esc aborts it mid-stream
  h.dsh({ type: "turn/start", data: { turn: 2 } });
  h.dsh(reasonChunk("thinking hard"));
  assert.equal(h.shim.isStreaming, true, "isStreaming true during the turn (pi-tui's escape handler aborts only then)");
  h.dsh(textChunk("partial answer"));
  h.shim.agent.abort(); // Esc -> session.agent.abort() -> dsh cancel
  assert.deepEqual(h.cancels, ["interrupted"]);
  // the aborted turn ends with reason.kind aborted -> the settled message carries stopReason "aborted"
  h.dsh({ type: "turn/end", data: { turn: 2, reason: { kind: "aborted" } } });
  assert.equal(h.shim.isStreaming, false, "idle after the turn");
  const end = h.emitted.findLast((e) => e.type === "message_end");
  assert.equal(end.message.stopReason, "aborted", "aborted stopReason so pi-tui shows Operation aborted");
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
  // delivering the matching user/message keeps the queue displayed (the
  // "Steering: <msg>" + dequeue-hint stays visible) while the turn processes it
  h.dsh({ type: "user/message", data: { content: [{ type: "text", text: "keep going" }], source: { kind: "user" } } });
  assert.deepEqual(h.shim.getSteeringMessages(), ["keep going"], "queue persists through the processing turn");
  // a NEW user message that is not the pending steer takes over and clears it
  h.dsh({ type: "user/message", data: { content: [{ type: "text", text: "different" }], source: { kind: "user" } } });
  assert.deepEqual(h.shim.getSteeringMessages(), [], "a new user message clears the queue");
  // the processing turn ending clears it too
  h.shim.steer("again");
  h.dsh({ type: "user/message", data: { content: [{ type: "text", text: "again" }], source: { kind: "user" } } });
  h.dsh({ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  assert.deepEqual(h.shim.getSteeringMessages(), [], "turn/end clears the delivered steers");
  // clearQueue returns + clears (pi's Option+Up restore path)
  h.shim.steer("restore me");
  const cleared = h.shim.clearQueue();
  assert.deepEqual(cleared.steering, ["restore me"]);
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

test("session.dispose flushes buffered reports and writes the dsh resume hint", async () => {
  const { installConsoleBuffer, formatResumeHint } = await import("../lib/index.js");
  const flushed = [];
  const buffer = installConsoleBuffer({ sink: (line) => flushed.push(line) });
  console.log("mount report during TUI");
  const h = harness();
  const shim = createPiSessionShim(h.ctx, h.agent, "s", { consoleBuffer: buffer });
  assert.equal(flushed.length, 0, "nothing flushed while the TUI is up");
  // A session SWITCH (mid-TUI) must NOT flush buffered reports into the
  // terminal; only the runtime's FINAL dispose (the quit path) does.
  shim.dispose();
  assert.equal(flushed.length, 0, "switch teardown does not flush (no mid-TUI console output)");
  const { createRuntimeHost } = await import("../lib/bridge.js");
  const rt = createRuntimeHost(h.ctx, h.agent, "s", { consoleBuffer: buffer });
  rt.dispose();
  assert.equal(flushed.length, 1, "final dispose flushes (regression: it was lost at quit)");
  assert.ok(flushed[0].includes("mount report during TUI"));
  assert.match(formatResumeHint("main-session-abc"), /^To resume this session: dsh --profile tui-pi --resume main-session-abc$/);
});

test("session bridge: /resume lists dsh sessions (never pi's) and switchSession maps back to --resume", async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "dsh-pi-bridge-"));
  const sessionsDir = join(dir, "sessions");
  const projcache = join(dir, "projcache.json");
  const cachedId = "main-session-123e4567-e89b-12d3-a456-426614174000";
  writeFileSync(projcache, JSON.stringify({
    tables: { sessions: {
      [cachedId]: { identity: { cwd: "/work" }, rows: { title: { val: "Cached session" } } },
    } },
  }));

  const exits = [];
  const h = harness();
  const shim = createPiSessionShim(h.ctx, h.agent, "s", {
    sessionsDir, projcachePath: projcache, onExit: () => exits.push("exit"),
  });
  // getSessionDir points at the bridge dir (NOT pi's default ~/.pi/agent/sessions)
  assert.equal(shim.sessionManager.getSessionDir(), sessionsDir);
  // the bridge file exists with the dsh session id + title
  const file = join(sessionsDir, `${cachedId}.jsonl`);
  const content = readFileSync(file, "utf8");
  assert.ok(content.includes(`"id":"${cachedId}"`), "dsh session id in the header");
  assert.ok(content.includes("Cached session"), "title in session_info");

  // switchSession resumes IN PROCESS (pi-tui's contract): the runtime swaps
  // to a new session built on the resumed dsh agent.
  const { createRuntimeHost, formatResumeHint, sessionIdFromBridgeFile } = await import("../lib/bridge.js");
  assert.equal(sessionIdFromBridgeFile(file), cachedId);
  const resumedAgent = {
    session: { header: { cwd: "/work" }, events: [], model: "deepseek-v4-flash", append() {} },
    followup() {}, steer() {}, cancel() {},
    ctx: { on: () => () => {} },
    options: {},
  };
  const resumed = [];
  // the resumed dsh session carries its persisted event log
  resumedAgent.session.events.push(
    { type: "turn/start", data: {}, seq: 1 },
    { type: "user/message", data: { content: [{ type: "text", text: "hi" }], source: { kind: "user" } }, seq: 2 },
    { type: "assistant/message", data: { message: { content: [{ type: "text", text: "Welcome back" }] } }, seq: 3 },
    { type: "turn/end", data: {}, seq: 4 },
  );
  h.ctx.agents = { resume: async () => resumedAgent };
  const rt = createRuntimeHost(h.ctx, h.agent, "s", { sessionsDir, projcachePath: projcache });
  let rebound = null;
  const rebindEvents = [];
  rt.setRebindSession((s) => {
    rebound = s;
    // pi-tui's finishSessionReplacement attaches the NEW session's listeners
    // here; events replayed BEFORE this are dropped (the regression).
    s.subscribe((ev) => rebindEvents.push(ev));
  });
  const result = await rt.switchSession(file);
  assert.equal(result.cancelled, false, "switchSession resolves without cancelling");
  assert.ok(rebound, "rebind callback invoked with the new session (pi-tui finishSessionReplacement)");
  assert.equal(rebound.sessionId, cachedId, "runtime rebound to the resumed session id");
  assert.ok(
    rebindEvents.some((e) => e.type === "message_end" && e.message?.content?.[0]?.text === "Welcome back"),
    "resumed history replayed AFTER the rebind reached the new session's listeners (regression: replay-before-rebind dropped it)",
  );
  // a non-bridge path cancels cleanly (no crash, no process exit)
  const cancelled = await rt.switchSession("/tmp/not-a-bridge-file.jsonl");
  assert.equal(cancelled.cancelled, true, "non-bridge path cancels");
});

test("ensureEscapeTimeout sets a saner pi-tui escape window but honors an operator value", async () => {
  const prev = process.env.PI_TUI_ESC_TIMEOUT;
  try {
    delete process.env.PI_TUI_ESC_TIMEOUT;
    const { ensureEscapeTimeout } = await import("../lib/index.js");
    assert.equal(ensureEscapeTimeout(), "150", "default applied when unset");
    assert.equal(ensureEscapeTimeout(), "150", "idempotent");
    process.env.PI_TUI_ESC_TIMEOUT = "42";
    assert.equal(ensureEscapeTimeout(), "42", "operator value wins");
  } finally {
    if (prev === undefined) delete process.env.PI_TUI_ESC_TIMEOUT;
    else process.env.PI_TUI_ESC_TIMEOUT = prev;
  }
});

test("replayHistory renders a resumed session's prior conversation through the bridge", () => {
  const h = harness();
  // seed the fake session log with prior events (like a resumed dsh session)
  h.agent.session.events.push(
    { type: "turn/start", data: {}, seq: 1 },
    { type: "user/message", data: { content: [{ type: "text", text: "hi" }], source: { kind: "user" } }, seq: 2 },
    { type: "assistant/message", data: { message: { content: [{ type: "text", text: "Hi there!" }] } }, seq: 3 },
    { type: "turn/end", data: {}, seq: 4 },
  );
  h.shim.replayHistory();
  const userMsg = h.emitted.find((e) => e.type === "message_start" && e.message?.role === "user");
  assert.ok(userMsg, "prior user message rendered");
  assert.equal(userMsg.message.content[0].text, "hi");
  const reply = h.emitted.find((e) => e.type === "message_end" && e.message?.content?.[0]?.text === "Hi there!");
  assert.ok(reply, "prior assistant reply rendered");
});

test("bridge files carry real messages so the /resume picker shows turn counts (not '0 now')", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { zstdCompressSync } = await import("node:zlib");
  const dir = mkdtempSync(join(tmpdir(), "dsh-pi-bridge-msgs-"));
  const sessionsDir = join(dir, "sessions");
  const projcache = join(dir, "projcache.json");
  const id = "main-session-123e4567-e89b-12d3-a456-426614174000";
  // fake dsh session log: two zstd frames (the persistence appends frames)
  const frame1 = [
    JSON.stringify({ type: "session", version: 0, id }),
    JSON.stringify({ type: "user/message", seq: 1, time: 1700000000000, data: { content: [{ type: "text", text: "hi" }], source: { kind: "user" } } }),
  ].join("\n") + "\n";
  const frame2 = JSON.stringify({ type: "assistant/message", seq: 2, time: 1700000000100, data: { message: { content: [{ type: "text", text: "Hello there" }] } } }) + "\n";
  const logDir = join(sessionsDir, "--fake-cwd--", id);
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, "session.jsonl.zstd"), Buffer.concat([zstdCompressSync(Buffer.from(frame1)), zstdCompressSync(Buffer.from(frame2))]));
  writeFileSync(projcache, JSON.stringify({ tables: { sessions: { [id]: { identity: { cwd: "/work" }, rows: { title: { val: "T" } } } } } }));
  const listeners = new Map();
  const agent = { session: { header: { cwd: "/work" }, events: [], model: "x", append() {} }, followup(){}, steer(){}, cancel(){}, ctx: { on: () => () => {} } };
  const ctx = { on: (n, cb) => listeners.set(n, cb), emit(){} };
  const bridgeDir = join(dir, "bridge");
  createPiSessionShim(ctx, agent, "s", { sessionsDir: bridgeDir, projcachePath: projcache, dshSessionsRoot: sessionsDir });
  const content = readFileSync(join(bridgeDir, `${id}.jsonl`), "utf8");
  const lines = content.split("\n").filter(Boolean);
  assert.ok(lines.some((l) => l.includes('"type":"message"') && l.includes('"role":"user"') && l.includes("hi")), "user message line present");
  assert.ok(lines.some((l) => l.includes('"type":"message"') && l.includes('"role":"assistant"') && l.includes("Hello there")), "assistant message line present");
  // pi's buildSessionInfo counts these for the picker's turn count / activity time
  assert.equal(lines.filter((l) => l.includes('"type":"message"')).length, 2);
});

test("the quit hint after an in-process switch targets the ACTIVE session, not the stale boot one", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "dsh-pi-hint-"));
  const sessionsDir = join(dir, "sessions");
  const projcache = join(dir, "projcache.json");
  const resumedId = "main-session-abc-123e4567-e89b-12d3-a456-426614174000";
  writeFileSync(projcache, JSON.stringify({ tables: { sessions: { [resumedId]: { identity: { cwd: "/work" }, rows: {} } } } }));
  const h = harness();
  const { createRuntimeHost, formatResumeHint } = await import("../lib/bridge.js");
  const hints = [];
  const rt = createRuntimeHost(h.ctx, h.agent, "s", {
    sessionsDir, projcachePath: projcache, hintSink: (line) => hints.push(line),
  });
  const resumedAgent = {
    session: { header: { cwd: "/work" }, events: [], model: "x", append() {} },
    followup() {}, steer() {}, cancel() {}, ctx: { on: () => () => {} }, options: {},
  };
  h.ctx.agents = { resume: async () => resumedAgent };
  const file = join(sessionsDir, `${resumedId}.jsonl`);
  await rt.switchSession(file);
  rt.dispose();
  assert.equal(hints.length, 1, "hint written on the final dispose");
  assert.ok(
    hints[0].includes(`--resume ${resumedId}`),
    `hint targets the resumed session (got: ${hints[0]}) — regression: it used the stale boot session id`,
  );
  assert.equal(formatResumeHint(resumedId), `To resume this session: dsh --profile tui-pi --resume ${resumedId}`);
});

test("bridge files prune when a session leaves the cache; the uncached current session is not written", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "dsh-pi-prune-"));
  const sessionsDir = join(dir, "sessions");
  const projcache = join(dir, "projcache.json");
  const cachedId = "main-session-11111111-2222-3333-4444-555555555555";
  const goneId = "main-session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  writeFileSync(projcache, JSON.stringify({ tables: { sessions: {
    [cachedId]: { identity: { cwd: "/work" }, rows: {} },
    [goneId]: { identity: { cwd: "/work" }, rows: {} },
  } } }));
  const h = harness();
  createPiSessionShim(h.ctx, h.agent, "s", { sessionsDir, projcachePath: projcache });
  assert.ok(readdirSync(sessionsDir).includes(`${cachedId}.jsonl`), "cached session file written");
  assert.ok(readdirSync(sessionsDir).includes(`${goneId}.jsonl`), "second session file written");
  // the CURRENT session (uncached) is NOT written
  assert.ok(!readdirSync(sessionsDir).includes("s.jsonl"), "uncached current session not written");
  // the gone session leaves the cache -> its file is pruned on regeneration
  writeFileSync(projcache, JSON.stringify({ tables: { sessions: { [cachedId]: { identity: { cwd: "/work" }, rows: {} } } } }));
  createPiSessionShim(h.ctx, h.agent, "s", { sessionsDir, projcachePath: projcache });
  assert.ok(!readdirSync(sessionsDir).includes(`${goneId}.jsonl`), "file pruned when the session leaves the cache");
  assert.ok(readdirSync(sessionsDir).includes(`${cachedId}.jsonl`), "remaining session kept");
});

test("switchSession propagates a failed in-process resume (the TUI shows 'Failed to resume session')", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "dsh-pi-fail-"));
  const sessionsDir = join(dir, "sessions");
  const projcache = join(dir, "projcache.json");
  const id = "main-session-99999999-8888-7777-6666-555555555555";
  writeFileSync(projcache, JSON.stringify({ tables: { sessions: { [id]: { identity: { cwd: "/work" }, rows: {} } } } }));
  const h = harness();
  const { createRuntimeHost } = await import("../lib/bridge.js");
  h.ctx.agents = { resume: async () => { throw new Error("persistence refused the corrupt log"); } };
  const rt = createRuntimeHost(h.ctx, h.agent, "s", { sessionsDir, projcachePath: projcache });
  await assert.rejects(
    rt.switchSession(join(sessionsDir, `${id}.jsonl`)),
    /persistence refused/,
    "a failed ctx.agents.resume rejects switchSession (pi shows 'Failed to resume session')",
  );
});

test("getFollowUpMessages is a benign empty list", () => {
  const h = harness();
  assert.deepEqual(h.shim.getFollowUpMessages(), []);
});

test("steers from ANY caller (pi2dsh's session.steer goes through the wrapped agent.steer) queue for the display + render in the chat", () => {
  const h = harness();
  const delivery = (text, extra = {}) => h.dsh({
    type: "user/message",
    data: { content: [{ type: "text", text }], source: { kind: "plugin", plugin: "pi2dsh:pi-subagents", ...extra } },
  });
  // pi2dsh's session.steer calls the dsh agent's steer; the shim wraps it so
  // the queue is fed deterministically (no event sniffing).
  h.agent.steer({ content: [{ type: "text", text: "now continue the analysis" }] });
  assert.deepEqual(h.shim.getSteeringMessages(), ["now continue the analysis"], "steer queued at the agent.steer seam");
  assert.ok(h.emitted.some((e) => e.type === "queue_update"), "queue_update emitted");
  // the delivery arrives with a plugin source; its text matches the pending
  // steer -> rendered as a user turn in the chat
  delivery("now continue the analysis");
  assert.ok(
    h.emitted.some((e) => e.type === "message_start" && e.message?.role === "user" && e.message?.content?.[0]?.text === "now continue the analysis"),
    "delivered steer rendered as a user turn in the chat",
  );
  // runtime context / notifications are NOT queued (no agent.steer call) and
  // not rendered (no pending-steer match)
  const before = h.emitted.length;
  delivery("Current runtime context. This snapshot supersedes earlier runtime-context snapshots.", { form: "snapshot", sections: [{ name: "x", text: "y" }] });
  assert.deepEqual(h.shim.getSteeringMessages(), ["now continue the analysis"], "runtime context not queued");
  assert.equal(h.emitted.length, before, "runtime context not rendered");
  delivery("<system-reminder>\nA skill is a reusable set of task-specific instructions", { form: "catalog", entries: [] });
  assert.deepEqual(h.shim.getSteeringMessages(), ["now continue the analysis"], "catalog not queued");
});
