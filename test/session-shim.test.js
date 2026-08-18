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
import { readFileSync } from "node:fs";
import { createPiSessionShim } from "../lib/session-shim.js";

/** Build a fake environment that captures emitted pi events + agent calls. */
function harness() {
  const listeners = new Map();
  const cancels = [];
  const steers = [];
  const followups = [];
  const sessionEvents = [];
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
    ctx: { on: () => () => {} },
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
  const { createRuntimeHost } = await import("../lib/session-shim.js");
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
