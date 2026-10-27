/**
 * Gemini Rate Limiter
 * 
 * Injects an automatic delay between tool calls when a Gemini model is active 
 * to prevent hitting Google AI Studio Tier 2 rate limits (e.g., 429 Too Many Requests).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setTimeout } from "node:timers/promises";

export default function geminiRateLimiter(pi: ExtensionAPI): void {
	pi.on("tool_result", async (event, ctx) => {
		// Only apply delay if the active model is from Google (Gemini)
		if (ctx.model?.provider === "google" || ctx.model?.id?.includes("gemini")) {
            // A 6-second delay ensures we stay under ~10 Requests Per Minute (RPM),
            // which helps prevent TPM/RPM spikes on Tier 2 accounts.
            const delayMs = 6000;
            
            ctx.ui.notify(`Gemini active: Enforcing a ${delayMs/1000}s rate-limit delay before next request...`, "info");
			await setTimeout(delayMs);
		}
		
        // Pass the event through unmodified
		return event;
	});
}
