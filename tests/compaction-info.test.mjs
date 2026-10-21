import test from "node:test";
import assert from "node:assert/strict";

import {
	defaultCompactionInfo,
	resolveCompactionInfo,
} from "../lib/compaction-info.mjs";

test("disables default auto-compaction when the reserve fills the context window", () => {
	assert.deepEqual(defaultCompactionInfo(16_384), {
		enabled: false,
		reserveTokens: 16_384,
	});
});

test("keeps default auto-compaction enabled when the context window exceeds the reserve", () => {
	assert.deepEqual(defaultCompactionInfo(32_768), {
		enabled: true,
		reserveTokens: 16_384,
	});
});

test("honors an explicitly disabled compaction setting", () => {
	assert.deepEqual(resolveCompactionInfo({ compaction: { enabled: false, reserveTokens: 4_096 } }, null, 32_768), {
		enabled: false,
		reserveTokens: 4_096,
	});
});

test("treats a configured reserve equal to the window as effectively disabled", () => {
	assert.deepEqual(resolveCompactionInfo({ compaction: { reserveTokens: 8_192 } }, null, 8_192), {
		enabled: false,
		reserveTokens: 8_192,
	});
});

test("prefers a safe model override over the ordinary reserve", () => {
	const settings = {
		compaction: {
			reserveTokens: 4_096,
			modelOverrides: {
				"provider/model": { reserveTokens: 2_048 },
			},
		},
	};

	assert.deepEqual(resolveCompactionInfo(settings, "provider/model", 32_768), {
		enabled: true,
		reserveTokens: 2_048,
	});
});
