import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SUPPORTED_PROVIDER = "openai-codex";
const STATUS_KEY = "openai-usage-reset";
const AUTH_PATH = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "auth.json");
const USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";
const REQUEST_TIMEOUT_MS = 5_000;

function parseNumber(value) {
	if (value === undefined || value === null || value === "") return undefined;
	const num = Number(value);
	return Number.isFinite(num) ? num : undefined;
}

function getHeader(headers, name) {
	if (!headers || typeof headers !== "object") return undefined;

	const lowerName = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lowerName) return value;
	}
	return undefined;
}

function getObject(value) {
	return value && typeof value === "object" ? value : undefined;
}

function getPrimaryResetAtMsFromHeaders(headers) {
	const resetAt = parseNumber(getHeader(headers, "x-codex-primary-reset-at"));
	if (resetAt !== undefined) return resetAt * 1000;

	const resetAfterSeconds = parseNumber(getHeader(headers, "x-codex-primary-reset-after-seconds"));
	if (resetAfterSeconds !== undefined) return Date.now() + resetAfterSeconds * 1000;

	return undefined;
}

function formatResetTime(resetAtMs) {
	const isFarAway = resetAtMs - Date.now() >= 24 * 60 * 60 * 1000;
	return new Date(resetAtMs).toLocaleString(undefined, isFarAway
		? { weekday: "short", hour: "numeric", minute: "2-digit" }
		: { hour: "numeric", minute: "2-digit" });
}

function formatPercentLeft(usedPercent) {
	const leftPercent = Math.max(0, Math.min(100, 100 - usedPercent));
	const decimals = leftPercent >= 10 ? 0 : 1;
	return `${leftPercent.toFixed(decimals)}% left`;
}

function isSupportedModel(model) {
	return model?.provider === SUPPORTED_PROVIDER;
}

function readOpenAICodexAuth() {
	try {
		if (!existsSync(AUTH_PATH)) return undefined;

		const auth = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
		const entry = getObject(auth?.[SUPPORTED_PROVIDER]);
		if (!entry || entry.type !== "oauth") return undefined;
		if (typeof entry.access !== "string" || typeof entry.accountId !== "string") return undefined;

		return {
			access: entry.access,
			accountId: entry.accountId,
		};
	} catch {
		return undefined;
	}
}

async function fetchCodexUsage(signal) {
	const auth = readOpenAICodexAuth();
	if (!auth) return undefined;

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	const abortRequest = () => controller.abort();
	if (signal?.aborted) {
		controller.abort();
	} else if (signal) {
		signal.addEventListener("abort", abortRequest, { once: true });
	}

	try {
		const response = await fetch(USAGE_URL, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${auth.access}`,
				"chatgpt-account-id": auth.accountId,
				"OpenAI-Beta": "responses=experimental",
				"User-Agent": "openai-usage-reset",
			},
			signal: controller.signal,
		});

		if (!response.ok) return undefined;

		const payload = getObject(await response.json());
		const rateLimit = getObject(payload?.rate_limit);
		const primaryWindow = getObject(rateLimit?.primary_window);
		const secondaryWindow = getObject(rateLimit?.secondary_window);

		const primaryResetAt = parseNumber(primaryWindow?.reset_at);
		const secondaryUsedPercent = parseNumber(secondaryWindow?.used_percent);

		if (primaryResetAt === undefined && secondaryUsedPercent === undefined) {
			return undefined;
		}

		return {
			primaryResetAtMs: primaryResetAt !== undefined ? primaryResetAt * 1000 : undefined,
			secondaryUsedPercent,
		};
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeoutId);
		if (signal) signal.removeEventListener("abort", abortRequest);
	}
}

export default function openAIUsageResetExtension(pi) {
	let currentModel;
	let lastPrimaryResetAtMs;
	let lastSecondaryUsedPercent;
	let usageFetchState = "idle";
	let usageFetchPromise;

	function renderStatus(ctx) {
		if (!ctx.hasUI || !isSupportedModel(currentModel)) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		const parts = [
			lastPrimaryResetAtMs !== undefined ? `5h ${formatResetTime(lastPrimaryResetAtMs)}` : "5h [after first response]",
		];

		if (lastSecondaryUsedPercent !== undefined) {
			parts.push(`7d ${formatPercentLeft(lastSecondaryUsedPercent)}`);
		} else if (usageFetchState === "loading") {
			parts.push("7d [fetching…]");
		}

		const theme = ctx.ui.theme;
		const clock = theme.fg("accent", "◷");
		const text = theme.fg("dim", ` OpenAI Usage: ${parts.join(" · ")}`);
		ctx.ui.setStatus(STATUS_KEY, clock + text);
	}

	function refreshUsage(ctx) {
		if (!isSupportedModel(currentModel)) return;
		if (usageFetchPromise) return;

		usageFetchState = "loading";
		usageFetchPromise = fetchCodexUsage(ctx.signal)
			.then((usage) => {
				usageFetchState = usage ? "ready" : "unavailable";
				if (!usage) return;

				if (usage.primaryResetAtMs !== undefined && lastPrimaryResetAtMs === undefined) {
					lastPrimaryResetAtMs = usage.primaryResetAtMs;
				}
				if (usage.secondaryUsedPercent !== undefined) {
					lastSecondaryUsedPercent = usage.secondaryUsedPercent;
				}
			})
			.finally(() => {
				usageFetchPromise = undefined;
				renderStatus(ctx);
			});
	}

	pi.on("session_start", async (_event, ctx) => {
		currentModel = ctx.model;
		renderStatus(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		currentModel = event.model;
		renderStatus(ctx);
	});

	pi.on("after_provider_response", async (event, ctx) => {
		currentModel = ctx.model;

		if (isSupportedModel(currentModel)) {
			const primaryResetAtMs = getPrimaryResetAtMsFromHeaders(event.headers);
			if (primaryResetAtMs !== undefined) {
				lastPrimaryResetAtMs = primaryResetAtMs;
			}

			refreshUsage(ctx);
		}

		renderStatus(ctx);
	});
}
