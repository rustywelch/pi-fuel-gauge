import test from "node:test";
import assert from "node:assert/strict";
import contextAwareness from "../extensions/context-awareness.ts";

function harness() {
	const events = new Map();
	const tools = new Map();
	const history = [];
	const deliveries = [];
	let tokens = 10_000;
	const ctx = {
		cwd: "/tmp",
		model: { provider: "test", id: "test", contextWindow: 100_000 },
		getContextUsage: () => ({ tokens, contextWindow: 100_000, percent: tokens / 1000 }),
		ui: { notify() {} },
	};
	contextAwareness({
		on(name, handler) { events.set(name, handler); },
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand() {},
		sendMessage(message, options) {
			history.push({ role: "custom", ...message, timestamp: history.length });
			deliveries.push(options);
		},
	});
	return {
		events, tools, history, deliveries, ctx,
		setTokens(value) { tokens = value; },
		async emit(name, event = {}) { return events.get(name)?.(event, ctx); },
		async request() {
			const messages = structuredClone(history);
			return (await events.get("context")?.({ messages }, ctx))?.messages ?? messages;
		},
	};
}

test("context notes are saved before the first request, with no request-local additions", async () => {
	const h = harness();
	await h.emit("session_start");
	await h.emit("before_agent_start");
	assert.equal(h.history.length, 1);
	assert.equal(h.history[0].customType, "context-awareness");
	assert.equal(h.history[0].display, false);
	assert.match(h.history[0].content, /10,000 \/ 100,000/);
	assert.deepEqual(await h.request(), h.history);
});

test("tool steps append new usage without replacing any part of the previous prompt", async () => {
	const h = harness();
	await h.emit("before_agent_start");
	const first = await h.request();
	h.history.push({ role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }] });
	const result = { role: "toolResult", toolCallId: "read-1", content: [{ type: "text", text: "file contents" }] };
	h.history.push(result);
	h.setTokens(76_000);
	await h.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" }, toolResults: [result] });
	const second = await h.request();
	assert.deepEqual(second.slice(0, first.length), first);
	assert.equal(second.at(-2).role, "toolResult");
	assert.match(second.at(-1).content, /76,000 \/ 100,000/);
	assert.match(second.at(-1).content, /Context is getting full/);
	assert.ok(h.deliveries.every(options => options?.triggerTurn === false));
});

test("unchanged usage does not accumulate duplicate notes", async () => {
	const h = harness();
	await h.emit("before_agent_start");
	await h.emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" }, toolResults: [{}] });
	await h.emit("before_agent_start");
	assert.equal(h.history.length, 1);
});

test("final replies, errors, and aborted turns do not queue context continuations", async () => {
	for (const stopReason of ["stop", "error", "aborted"]) {
		const h = harness();
		await h.emit("before_agent_start");
		h.setTokens(90_000);
		await h.emit("turn_end", { message: { role: "assistant", stopReason }, toolResults: stopReason === "stop" ? [] : [{}] });
		assert.equal(h.history.length, 1, stopReason);
	}
});

test("session changes and compaction restore a note even when the previous content matches", async () => {
	for (const event of ["session_start", "session_tree", "session_compact", "model_select"]) {
		const h = harness();
		await h.emit("before_agent_start");
		h.history.length = 0;
		await h.emit(event);
		await h.emit("before_agent_start");
		assert.equal(h.history.length, 1, event);
	}
});

test("hard-limit compaction guidance and on-demand context status stay available", async () => {
	const h = harness();
	h.setTokens(85_000);
	await h.emit("before_agent_start");
	assert.match(h.history.at(-1).content, /Call compact_now now/);
	const status = await h.tools.get("context_status").execute("status", {}, undefined, undefined, h.ctx);
	assert.match(status.content[0].text, /85,000 \/ 100,000/);
	assert.ok(h.tools.has("compact_now"));
});

test("models without a known context window do not save an unusable note", async () => {
	const h = harness();
	h.ctx.model = undefined;
	h.ctx.getContextUsage = () => undefined;
	await h.emit("before_agent_start");
	assert.deepEqual(h.history, []);
	assert.deepEqual(await h.request(), []);
});
