import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "token-rate";
const SAMPLE_INTERVAL_MS = 500;
const EWMA_WEIGHT = 0.65;

type Measurement = {
	streamStartedAt: number;
	firstTokenAt: number | undefined;
	sampledAt: number;
	sampledChars: number;
	generatedChars: number;
	smoothedRate: number | undefined;
};

let measurement: Measurement | undefined;

function formatRate(tokensPerSecond: number): string {
	if (!Number.isFinite(tokensPerSecond) || tokensPerSecond < 0) return "—";
	if (tokensPerSecond < 10) return tokensPerSecond.toFixed(1);
	return String(Math.round(tokensPerSecond));
}

function smoothRate(previous: number | undefined, current: number): number {
	if (previous === undefined) return current;
	return previous * (1 - EWMA_WEIGHT) + current * EWMA_WEIGHT;
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		measurement = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("agent_start", async (_event, ctx) => {
		measurement = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("turn_start", async (_event, ctx) => {
		measurement = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("message_update", async (event, ctx) => {
		const streamEvent = event.assistantMessageEvent;

		if (streamEvent.type === "start") {
			const now = Date.now();
			measurement = {
				streamStartedAt: now,
				firstTokenAt: undefined,
				sampledAt: now,
				sampledChars: 0,
				generatedChars: 0,
				smoothedRate: undefined,
			};
			return;
		}

		if (
			streamEvent.type !== "text_delta" &&
			streamEvent.type !== "thinking_delta" &&
			streamEvent.type !== "toolcall_delta"
		) {
			return;
		}

		const now = Date.now();
		if (!measurement) {
			measurement = {
				streamStartedAt: now,
				firstTokenAt: now,
				sampledAt: now,
				sampledChars: 0,
				generatedChars: 0,
				smoothedRate: undefined,
			};
		}

		measurement.generatedChars += streamEvent.delta.length;
		if (measurement.firstTokenAt === undefined) {
			measurement.firstTokenAt = now;
			measurement.sampledAt = now;
			measurement.sampledChars = measurement.generatedChars;
			return;
		}

		const elapsedSinceSample = now - measurement.sampledAt;
		if (elapsedSinceSample < SAMPLE_INTERVAL_MS) return;

		const sampledTokens = (measurement.generatedChars - measurement.sampledChars) / 4;
		const instantaneousRate = sampledTokens / (elapsedSinceSample / 1000);
		const smoothedRate = smoothRate(measurement.smoothedRate, instantaneousRate);
		measurement.smoothedRate = smoothedRate;
		measurement.sampledAt = now;
		measurement.sampledChars = measurement.generatedChars;

		const label = ctx.ui.theme.fg("dim", "⚡ ");
		const value = ctx.ui.theme.fg("accent", `≈ ${formatRate(smoothedRate)} tok/s`);
		ctx.ui.setStatus(STATUS_KEY, label + value);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;

		const currentMeasurement = measurement;
		measurement = undefined;

		const outputTokens = event.message.usage.output;
		if (
			!currentMeasurement ||
			outputTokens <= 0 ||
			event.message.stopReason === "error" ||
			event.message.stopReason === "aborted"
		) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		const generationStartedAt = currentMeasurement.firstTokenAt ?? currentMeasurement.streamStartedAt;
		const elapsedSeconds = (Date.now() - generationStartedAt) / 1000;
		if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		const averageRate = outputTokens / elapsedSeconds;
		const label = ctx.ui.theme.fg("dim", "✓ ");
		const value = ctx.ui.theme.fg("success", `${formatRate(averageRate)} tok/s média`);
		ctx.ui.setStatus(STATUS_KEY, label + value);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		measurement = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
