/**
 * Context footer colors for pi.
 *
 * Replaces the built-in footer with an equivalent renderer, but colors the
 * context usage text at configurable yellow/red percentage thresholds.
 *
 * Config file: ~/.pi/agent/context-footer-colors.json
 * Settings: /extension-settings
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

interface ContextFooterColorsConfig {
	enabled: boolean;
	yellowPercent: number;
	redPercent: number;
}

interface ExtensionSettingDefinition {
	id: string;
	label: string;
	description?: string;
	values: string[];
	get: () => string | Promise<string>;
	set: (value: string, ctx: ExtensionCommandContext) => void | Promise<void>;
}

interface ExtensionSettingsRegistration {
	namespace: string;
	title?: string;
	settings: ExtensionSettingDefinition[];
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "context-footer-colors.json");
const DEFAULT_CONFIG: ContextFooterColorsConfig = {
	enabled: true,
	yellowPercent: 40,
	redPercent: 50,
};

const PERCENT_VALUES = Array.from({ length: 101 }, (_unused, index) => String(index));

export default function contextFooterColors(pi: ExtensionAPI) {
	let config: ContextFooterColorsConfig = DEFAULT_CONFIG;
	let requestRender: (() => void) | undefined;

	pi.on("session_start", async (_event, ctx) => {
		config = await loadConfig();
		applyFooter(ctx);
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		requestRender = undefined;
	});

	pi.on("model_select", async () => requestRender?.());
	pi.on("thinking_level_select", async () => requestRender?.());
	pi.on("session_compact", async () => requestRender?.());
	pi.on("turn_end", async () => requestRender?.());

	registerExtensionSettings();

	function applyFooter(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;

		if (!config.enabled) {
			ctx.ui.setFooter(undefined);
			requestRender = undefined;
			return;
		}

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() {
					unsubscribeBranch();
					if (requestRender) requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const currentConfig = config;

					let totalInput = 0;
					let totalOutput = 0;
					let totalCacheRead = 0;
					let totalCacheWrite = 0;
					let totalCost = 0;

					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type !== "message" || entry.message.role !== "assistant") continue;
						const usage = entry.message.usage;
						if (!usage) continue;
						totalInput += usage.input ?? 0;
						totalOutput += usage.output ?? 0;
						totalCacheRead += usage.cacheRead ?? 0;
						totalCacheWrite += usage.cacheWrite ?? 0;
						totalCost += usage.cost?.total ?? 0;
					}

					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

					let pwd = formatCwdForFooter(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
					const branch = footerData.getGitBranch();
					if (branch) pwd = `${pwd} (${branch})`;

					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) pwd = `${pwd} • ${sessionName}`;

					const statsParts: string[] = [];
					if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
					if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
					if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
					if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);

					const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
					if (totalCost || usingSubscription) {
						statsParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
					}

					const autoIndicator = " (auto)";
					const contextPercentDisplay =
						contextPercent === "?"
							? `?/${formatTokens(contextWindow)}${autoIndicator}`
							: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;

					let contextPercentStr = contextPercentDisplay;
					if (contextUsage?.percent != null) {
						if (contextPercentValue > currentConfig.redPercent) {
							contextPercentStr = theme.fg("error", contextPercentDisplay);
						} else if (contextPercentValue >= currentConfig.yellowPercent) {
							contextPercentStr = theme.fg("warning", contextPercentDisplay);
						}
					}
					statsParts.push(contextPercentStr);

					let statsLeft = statsParts.join(" ");
					let statsLeftWidth = visibleWidth(statsLeft);
					if (statsLeftWidth > width) {
						statsLeft = truncateToWidth(statsLeft, width, "...");
						statsLeftWidth = visibleWidth(statsLeft);
					}

					const modelName = ctx.model?.id || "no-model";
					let rightSideWithoutProvider = modelName;
					if (ctx.model?.reasoning) {
						const thinkingLevel = pi.getThinkingLevel?.() || "off";
						rightSideWithoutProvider =
							thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
					}

					let rightSide = rightSideWithoutProvider;
					if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
						rightSide = `(${ctx.model.provider}) ${rightSideWithoutProvider}`;
						if (statsLeftWidth + 2 + visibleWidth(rightSide) > width) {
							rightSide = rightSideWithoutProvider;
						}
					}

					const rightSideWidth = visibleWidth(rightSide);
					const totalNeeded = statsLeftWidth + 2 + rightSideWidth;
					let statsLine: string;
					if (totalNeeded <= width) {
						const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
						statsLine = statsLeft + padding + rightSide;
					} else {
						const availableForRight = width - statsLeftWidth - 2;
						if (availableForRight > 0) {
							const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
							const truncatedRightWidth = visibleWidth(truncatedRight);
							const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
							statsLine = statsLeft + padding + truncatedRight;
						} else {
							statsLine = statsLeft;
						}
					}

					const dimStatsLeft = theme.fg("dim", statsLeft);
					const remainder = statsLine.slice(statsLeft.length);
					const dimRemainder = theme.fg("dim", remainder);
					const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
					const lines = [pwdLine, dimStatsLeft + dimRemainder];

					const extensionStatuses = footerData.getExtensionStatuses();
					if (extensionStatuses.size > 0) {
						const statusLine = Array.from(extensionStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatusText(text))
							.join(" ");
						lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});
	}

	function registerExtensionSettings() {
		const registration = (): ExtensionSettingsRegistration => ({
			namespace: "context-footer-colors",
			title: "Context Footer Colors",
			settings: [
				{
					id: "enabled",
					label: "Enabled",
					description: "Color the footer context usage at the configured thresholds.",
					values: ["on", "off"],
					get: async () => ((await loadConfig()).enabled ? "on" : "off"),
					set: async (value: string, ctx: ExtensionCommandContext) => {
						config = await updateConfig((next) => {
							next.enabled = value === "on";
						});
						applyFooter(ctx);
					},
				},
				{
					id: "yellow_percent",
					label: "Yellow percent",
					description: "Context usage percentage where the footer turns yellow.",
					values: PERCENT_VALUES,
					get: async () => String((await loadConfig()).yellowPercent),
					set: async (value: string) => {
						config = await updateConfig((next) => {
							next.yellowPercent = clampPercent(Number(value), DEFAULT_CONFIG.yellowPercent);
							if (next.yellowPercent > next.redPercent) next.redPercent = next.yellowPercent;
						});
						requestRender?.();
					},
				},
				{
					id: "red_percent",
					label: "Red percent",
					description: "Context usage percentage where the footer turns red.",
					values: PERCENT_VALUES,
					get: async () => String((await loadConfig()).redPercent),
					set: async (value: string) => {
						config = await updateConfig((next) => {
							next.redPercent = clampPercent(Number(value), DEFAULT_CONFIG.redPercent);
							if (next.redPercent < next.yellowPercent) next.yellowPercent = next.redPercent;
						});
						requestRender?.();
					},
				},
			],
		});

		pi.events.on("extension-settings:request", (event) => {
			(event as { register?: (registration: ExtensionSettingsRegistration) => void }).register?.(registration());
		});
		pi.events.emit("extension-settings:register", registration());
	}
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

async function loadConfig(): Promise<ContextFooterColorsConfig> {
	if (!existsSync(CONFIG_PATH)) {
		await saveConfig(DEFAULT_CONFIG);
		return { ...DEFAULT_CONFIG };
	}

	try {
		const raw = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
		return normalizeConfig(raw);
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

async function saveConfig(next: ContextFooterColorsConfig): Promise<void> {
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	await writeFile(CONFIG_PATH, `${JSON.stringify(normalizeConfig(next), null, 2)}\n`, "utf8");
}

async function updateConfig(mutator: (next: ContextFooterColorsConfig) => void): Promise<ContextFooterColorsConfig> {
	const next = await loadConfig();
	mutator(next);
	const normalized = normalizeConfig(next);
	await saveConfig(normalized);
	return normalized;
}

function normalizeConfig(value: unknown): ContextFooterColorsConfig {
	const source = typeof value === "object" && value !== null ? (value as Partial<ContextFooterColorsConfig>) : {};
	let yellowPercent = clampPercent(Number(source.yellowPercent), DEFAULT_CONFIG.yellowPercent);
	let redPercent = clampPercent(Number(source.redPercent), DEFAULT_CONFIG.redPercent);
	if (yellowPercent > redPercent) {
		redPercent = yellowPercent;
	}

	return {
		enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_CONFIG.enabled,
		yellowPercent,
		redPercent,
	};
}

function clampPercent(value: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(0, Math.min(100, Math.round(value)));
}
