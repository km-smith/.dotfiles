/**
 * Hierarchical notifications for pi.
 *
 * Notifies when an agent turn ends, using configurable priority levels.
 * Also registers an ask_user tool so the model can explicitly request blocking input.
 * Default levels:
 * - needs_input: high-priority notification when the assistant appears to ask for input
 * - review: lower-priority notification when the turn completes and should be reviewed
 *
 * Config file: ~/.pi/agent/notify-hierarchy.json
 * Commands:
 * - /notify-config       Edit the JSON config
 * - /notify-test [level] Send a test notification
 */

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface NotificationConfig {
	enabled: boolean;
	cooldownMs: number;
	defaultLevel: string;
	levels: NotificationLevel[];
}

interface NotificationLevel {
	/** Stable id, e.g. "needs_input" or "review". */
	id: string;
	/** Higher numbers win when multiple levels match. */
	priority: number;
	/** User-visible notification title. */
	title: string;
	/** Body template. Supported tokens: {cwd}, {model}, {summary}. */
	message: string;
	/** macOS notification. */
	native?: boolean;
	/** Bundle id to activate when the native notification is clicked. Requires terminal-notifier. */
	activateBundleId?: string;
	/** macOS notification sound name, e.g. Glass, Ping, Submarine. */
	sound?: string;
	/** Emit a terminal bell. */
	terminalBell?: boolean;
	/** Run a command after notification. Tokens are applied to args. */
	command?: string[];
	/** Matchers used against final assistant text. If omitted, only used as fallback/default. */
	match?: {
		containsAny?: string[];
		regexAny?: string[];
	};
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "notify-hierarchy.json");

const DEFAULT_CONFIG: NotificationConfig = {
	enabled: true,
	cooldownMs: 3000,
	defaultLevel: "review",
	levels: [
		{
			id: "needs_input",
			priority: 100,
			title: "pi needs input",
			message: "{summary}",
			native: true,
			activateBundleId: "com.mitchellh.ghostty",
			sound: "Glass",
			terminalBell: true,
			match: {
				containsAny: [
					"?",
					"please confirm",
					"please choose",
					"which would you prefer",
					"what would you like",
					"need your input",
					"need you to",
					"can you provide",
					"would you like me to",
				],
				regexAny: [
					"\\b(choose|confirm|provide|clarify|decide)\\b.*\\?",
					"\\b(which|what|should|would|do you want)\\b.*\\?",
				],
			},
		},
		{
			id: "review",
			priority: 10,
			title: "pi turn complete",
			message: "Ready for review: {summary}",
			native: true,
			activateBundleId: "com.mitchellh.ghostty",
		},
	],
};

export default function notifyHierarchyExtension(pi: ExtensionAPI) {
	let config: NotificationConfig = DEFAULT_CONFIG;
	let lastNotificationAt = 0;
	let ghosttyTarget: GhosttyTarget | undefined;

	pi.on("session_start", async () => {
		config = await loadConfig();
		ghosttyTarget = await captureGhosttyTarget(pi);
	});

	pi.on("agent_start", async () => {
		// Reload each turn so hand-edited config changes are picked up without /reload.
		config = await loadConfig();
		// Capture the tab/terminal that started this turn, so clicking the notification
		// can return to this pi session even if another Ghostty tab is selected later.
		ghosttyTarget = await captureGhosttyTarget(pi);
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!config.enabled) return;

		const now = Date.now();
		if (now - lastNotificationAt < config.cooldownMs) return;

		const finalText = extractFinalAssistantText(event.messages);
		const level = selectLevel(config, finalText);
		if (!level) return;

		lastNotificationAt = now;
		await notify(pi, level, {
			cwd: ctx.cwd,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown model",
			summary: summarize(finalText),
			ghosttyTarget,
		});
	});

	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description: "Ask the user for input when you cannot continue without a decision or clarification.",
		promptSnippet: "Ask the user a blocking question when work cannot continue without their input",
		promptGuidelines: [
			"Use ask_user when you need a decision, clarification, secret, credential, or other user-provided input before continuing.",
			"Do not use ask_user for routine progress updates or final summaries; ask directly in the assistant response instead.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "The question to ask the user" }),
			choices: Type.Optional(Type.Array(Type.String(), { description: "Optional fixed choices" })),
			multiline: Type.Optional(Type.Boolean({ description: "Use a multi-line editor for the answer" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			config = await loadConfig();
			if (!ctx.hasUI) throw new Error("ask_user requires an interactive or RPC UI");

			const level = getLevel(config, "needs_input") ?? highestPriorityLevel(config) ?? selectLevel(config, params.question);
			if (config.enabled && level) {
				lastNotificationAt = Date.now();
				await notify(pi, level, {
					cwd: ctx.cwd,
					model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown model",
					summary: summarize(params.question),
					ghosttyTarget,
				});
			}

			let answer: string | undefined;
			if (params.choices?.length) {
				answer = await ctx.ui.select(params.question, params.choices);
			} else if (params.multiline) {
				answer = await ctx.ui.editor(params.question, "");
			} else {
				answer = await ctx.ui.input(params.question, "Type your answer...");
			}

			if (answer === undefined) throw new Error("User cancelled the input request");

			return {
				content: [{ type: "text", text: `User answered: ${answer}` }],
				details: { question: params.question, answer },
			};
		},
	});

	pi.registerCommand("notify-config", {
		description: "Edit hierarchical notification config",
		handler: async (_args, ctx) => {
			const current = await readConfigText();
			if (!ctx.hasUI) {
				console.log(`Notification config: ${CONFIG_PATH}\n${current}`);
				return;
			}

			const edited = await ctx.ui.editor("Edit notification config JSON", current);
			if (edited === undefined) return;

			try {
				const parsed = normalizeConfig(JSON.parse(edited));
				await saveConfig(parsed);
				config = parsed;
				ctx.ui.notify(`Saved ${CONFIG_PATH}`, "info");
			} catch (error) {
				ctx.ui.notify(`Invalid config: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	registerExtensionSettings();

	pi.registerCommand("notify-test", {
		description: "Send a test notification. Usage: /notify-test [level]",
		getArgumentCompletions: (prefix) => {
			const completions = config.levels
				.filter((level) => level.id.startsWith(prefix))
				.map((level) => ({ value: level.id, label: level.id }));
			return completions.length > 0 ? completions : null;
		},
		handler: async (args, ctx) => {
			config = await loadConfig();
			const requested = args.trim() || config.defaultLevel;
			const level = config.levels.find((candidate) => candidate.id === requested);
			if (!level) {
				ctx.ui.notify(`Unknown level "${requested}". Try: ${config.levels.map((l) => l.id).join(", ")}`, "error");
				return;
			}

			await notify(pi, level, {
				cwd: ctx.cwd,
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown model",
				summary: "This is a test notification from pi.",
				ghosttyTarget,
			});
			ctx.ui.notify(`Sent ${level.id} notification`, "info");
		},
	});

	function registerExtensionSettings() {
		const registration = () => ({
			namespace: "notify-hierarchy",
			title: "Notifications",
			settings: [
				{
					id: "enabled",
					label: "Enabled",
					description: "Turn hierarchical notifications on or off.",
					values: ["on", "off"],
					get: async () => ((await loadConfig()).enabled ? "on" : "off"),
					set: async (value: string) => {
						config = await updateConfig((next) => {
							next.enabled = value === "on";
						});
					},
				},
				{
					id: "native",
					label: "Native notifications",
					description: "Use macOS Notification Center.",
					values: ["on", "off"],
					get: async () => ((await loadConfig()).levels.some((level) => level.native !== false) ? "on" : "off"),
					set: async (value: string) => {
						config = await updateConfig((next) => {
							for (const level of next.levels) level.native = value === "on";
						});
					},
				},
				{
					id: "click_focus_ghostty",
					label: "Click notification focuses Ghostty tab",
					description: "Return to the Ghostty tab/terminal that triggered the notification.",
					values: ["on", "off"],
					get: async () =>
						(await loadConfig()).levels.some((level) => level.activateBundleId === "com.mitchellh.ghostty")
							? "on"
							: "off",
					set: async (value: string) => {
						config = await updateConfig((next) => {
							for (const level of next.levels) {
								level.activateBundleId = value === "on" ? "com.mitchellh.ghostty" : "";
							}
						});
					},
				},
				{
					id: "needs_input_bell",
					label: "Needs-input terminal bell",
					description: "Emit a terminal bell for high-priority input requests.",
					values: ["on", "off"],
					get: async () => (getLevel(await loadConfig(), "needs_input")?.terminalBell ? "on" : "off"),
					set: async (value: string) => {
						config = await updateConfig((next) => {
							const needsInput = getLevel(next, "needs_input");
							if (needsInput) needsInput.terminalBell = value === "on";
						});
					},
				},
				{
					id: "needs_input_sound",
					label: "Needs-input sound",
					description: "macOS sound for high-priority input requests.",
					values: ["Glass", "Ping", "Submarine", "Hero", "off"],
					get: async () => getLevel(await loadConfig(), "needs_input")?.sound ?? "off",
					set: async (value: string) => {
						config = await updateConfig((next) => {
							const needsInput = getLevel(next, "needs_input");
							if (needsInput) needsInput.sound = value === "off" ? undefined : value;
						});
					},
				},
			],
		});

		pi.events.on("extension-settings:request", (event) => {
			(event as { register?: (registration: ReturnType<typeof registration>) => void }).register?.(registration());
		});
		pi.events.emit("extension-settings:register", registration());
	}
}

async function loadConfig(): Promise<NotificationConfig> {
	if (!existsSync(CONFIG_PATH)) {
		await saveConfig(DEFAULT_CONFIG);
		return DEFAULT_CONFIG;
	}

	try {
		const text = await readFile(CONFIG_PATH, "utf8");
		return normalizeConfig(JSON.parse(text));
	} catch {
		// Fail safe: keep notifications working if the file is malformed.
		return DEFAULT_CONFIG;
	}
}

async function readConfigText(): Promise<string> {
	if (!existsSync(CONFIG_PATH)) {
		await saveConfig(DEFAULT_CONFIG);
	}
	return readFile(CONFIG_PATH, "utf8");
}

async function saveConfig(next: NotificationConfig): Promise<void> {
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	await writeFile(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

async function updateConfig(mutator: (next: NotificationConfig) => void): Promise<NotificationConfig> {
	const next = await loadConfig();
	mutator(next);
	await saveConfig(next);
	return next;
}

function normalizeConfig(value: unknown): NotificationConfig {
	if (!value || typeof value !== "object") throw new Error("config must be an object");
	const input = value as Partial<NotificationConfig>;
	if (!Array.isArray(input.levels) || input.levels.length === 0) {
		throw new Error("config.levels must be a non-empty array");
	}

	const levels = input.levels.map((level) => {
		if (!level || typeof level !== "object") throw new Error("each level must be an object");
		const candidate = level as Partial<NotificationLevel>;
		if (!candidate.id) throw new Error("each level needs an id");
		const defaultLevel = DEFAULT_CONFIG.levels.find((defaultCandidate) => defaultCandidate.id === candidate.id);
		return {
			id: String(candidate.id),
			priority: Number.isFinite(Number(candidate.priority)) ? Number(candidate.priority) : 0,
			title: String(candidate.title ?? candidate.id),
			message: String(candidate.message ?? "{summary}"),
			native: candidate.native !== false,
			activateBundleId:
				typeof candidate.activateBundleId === "string"
					? candidate.activateBundleId
					: defaultLevel?.activateBundleId,
			sound: typeof candidate.sound === "string" ? candidate.sound : undefined,
			terminalBell: candidate.terminalBell === true,
			command: Array.isArray(candidate.command) ? candidate.command.map(String) : undefined,
			match: normalizeMatch(candidate.match),
		};
	});

	return {
		enabled: input.enabled !== false,
		cooldownMs: Number(input.cooldownMs ?? DEFAULT_CONFIG.cooldownMs),
		defaultLevel: String(input.defaultLevel ?? levels[0].id),
		levels,
	};
}

function selectLevel(config: NotificationConfig, text: string): NotificationLevel | undefined {
	const matching = config.levels
		.filter((level) => level.match && matches(level.match, text))
		.sort((a, b) => b.priority - a.priority);

	if (matching[0]) return matching[0];
	return getLevel(config, config.defaultLevel);
}

function getLevel(config: NotificationConfig, id: string): NotificationLevel | undefined {
	return config.levels.find((level) => level.id === id);
}

function highestPriorityLevel(config: NotificationConfig): NotificationLevel | undefined {
	return [...config.levels].sort((a, b) => b.priority - a.priority)[0];
}

function normalizeMatch(match: NotificationLevel["match"]): NotificationLevel["match"] {
	if (!match || typeof match !== "object") return undefined;
	return {
		containsAny: Array.isArray(match.containsAny) ? match.containsAny.map(String) : undefined,
		regexAny: Array.isArray(match.regexAny) ? match.regexAny.map(String) : undefined,
	};
}

function matches(match: NonNullable<NotificationLevel["match"]>, text: string): boolean {
	const haystack = text.toLowerCase();
	if (match.containsAny?.some((needle) => haystack.includes(needle.toLowerCase()))) return true;
	if (
		match.regexAny?.some((pattern) => {
			try {
				return new RegExp(pattern, "is").test(text);
			} catch {
				return false;
			}
		})
	) {
		return true;
	}
	return false;
}

interface NotifyTokens extends Record<string, string | GhosttyTarget | undefined> {
	cwd: string;
	model: string;
	summary: string;
	ghosttyTarget?: GhosttyTarget;
}

interface GhosttyTarget {
	terminalId?: string;
	tabId?: string;
}

async function notify(pi: ExtensionAPI, level: NotificationLevel, tokens: NotifyTokens): Promise<void> {
	const title = applyTokens(level.title, tokens);
	const message = applyTokens(level.message, tokens);

	if (level.terminalBell) process.stdout.write("\u0007");

	if (level.native) {
		if (level.activateBundleId && (await commandExists(pi, "terminal-notifier"))) {
			const args = ["-title", title, "-message", message, "-activate", level.activateBundleId];
			const clickCommand = buildGhosttyFocusCommand(level.activateBundleId, tokens.ghosttyTarget);
			if (clickCommand) args.push("-execute", clickCommand);
			if (level.sound) args.push("-sound", level.sound);
			await pi.exec("terminal-notifier", args).catch(() => undefined);
		} else {
			const script = level.sound
				? `display notification ${osascriptString(message)} with title ${osascriptString(title)} sound name ${osascriptString(level.sound)}`
				: `display notification ${osascriptString(message)} with title ${osascriptString(title)}`;
			await pi.exec("osascript", ["-e", script]).catch(() => undefined);
		}
	}

	if (level.command?.length) {
		const [command, ...args] = level.command.map((part) => applyTokens(part, tokens));
		if (command) await pi.exec(command, args).catch(() => undefined);
	}
}

async function captureGhosttyTarget(pi: ExtensionAPI): Promise<GhosttyTarget | undefined> {
	if (process.env.TERM_PROGRAM !== "ghostty") return undefined;

	const script = String.raw`
tell application "Ghostty"
	try
		set theTab to selected tab of front window
		set tabId to id of theTab
		set terminalId to id of focused terminal of theTab
		return terminalId & "|" & tabId
	on error
		return ""
	end try
end tell`;

	const result = await pi.exec("osascript", ["-e", script]).catch(() => undefined);
	const output = result?.stdout.trim();
	if (!output) return undefined;
	const [terminalId, tabId] = output.split("|");
	return { terminalId: terminalId || undefined, tabId: tabId || undefined };
}

function buildGhosttyFocusCommand(bundleId: string, target: GhosttyTarget | undefined): string | undefined {
	if (bundleId !== "com.mitchellh.ghostty" || (!target?.terminalId && !target?.tabId)) return undefined;

	const script = String.raw`
tell application "Ghostty"
	activate
	try
		repeat with theTerminal in terminals
			if id of theTerminal is ${osascriptString(target.terminalId ?? "")} then
				focus theTerminal
				return
			end if
		end repeat
	end try
	try
		repeat with theWindow in windows
			repeat with theTab in tabs of theWindow
				if id of theTab is ${osascriptString(target.tabId ?? "")} then
					select tab theTab
					activate window theWindow
					return
				end if
			end repeat
		end repeat
	end try
end tell`;

	return `osascript -e ${shellQuote(script)}`;
}

async function commandExists(pi: ExtensionAPI, command: string): Promise<boolean> {
	const result = await pi.exec("sh", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`]).catch(() => undefined);
	return result?.code === 0;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function applyTokens(template: string, tokens: NotifyTokens): string {
	return template.replace(/\{(cwd|model|summary)\}/g, (_match, key: "cwd" | "model" | "summary") => tokens[key] ?? "");
}

function osascriptString(value: string): string {
	return JSON.stringify(value);
}

function extractFinalAssistantText(messages: unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as { role?: string; content?: unknown } | undefined;
		if (message?.role === "assistant") return extractText(message.content);
	}
	return "";
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const candidate = part as { type?: string; text?: unknown };
			return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function summarize(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return "Turn complete.";
	return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}
