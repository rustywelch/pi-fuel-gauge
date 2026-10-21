import test from "node:test";
import assert from "node:assert/strict";

import {
	HARD_COMPACT_PERCENT,
	PREPARE_PERCENT,
	contextPolicy,
} from "../lib/context-policy.mjs";

test("keeps normal work below the preparation threshold", () => {
	assert.deepEqual(contextPolicy(PREPARE_PERCENT - 0.1), {
		phase: "normal",
		compactionRequired: false,
		requireCleanBoundary: false,
	});
});

test("prepares for compaction from 75 percent", () => {
	assert.deepEqual(contextPolicy(PREPARE_PERCENT), {
		phase: "prepare",
		compactionRequired: false,
		requireCleanBoundary: true,
	});
});

test("requires immediate compaction at 80 percent", () => {
	assert.deepEqual(contextPolicy(HARD_COMPACT_PERCENT), {
		phase: "hard",
		compactionRequired: true,
		requireCleanBoundary: false,
	});
});

test("continues to require immediate compaction above 80 percent", () => {
	assert.equal(contextPolicy(92).compactionRequired, true);
});
