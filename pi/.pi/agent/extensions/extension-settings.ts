/**
 * Extension Settings registry for pi.
 *
 * Provides /extension-settings, a shared settings UI that other extensions can
 * register items with via pi.events.
 *
 * Registration protocol:
 *
 * pi.events.on("extension-settings:request", ({ register }) => {
 *   register({
 *     namespace: "my-extension",
 *     title: "My Extension",
 *     settings: [{
 *       id: "enabled",
 *       label: "Enabled",
 *       values: ["on", "off"],
 *       get: async () => enabled ? "on" : "off",
 *       set: async (value, ctx) => { enabled = value === "on"; },
 *     }],
 *   });
 * });
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";

export interface ExtensionSettingDefinition {
	id: string;
	label: string;
	description?: string;
	values: string[];
	get: () => string | Promise<string>;
	set: (value: string, ctx: ExtensionCommandContext) => void | Promise<void>;
}

export interface ExtensionSettingsRegistration {
	namespace: string;
	title?: string;
	settings: ExtensionSettingDefinition[];
}

interface ExtensionSettingsRequest {
	register: (registration: ExtensionSettingsRegistration) => void;
}

interface RegisteredSetting extends ExtensionSettingDefinition {
	namespace: string;
	title: string;
	fullId: string;
}

export default function extensionSettings(pi: ExtensionAPI) {
	const registrations = new Map<string, ExtensionSettingsRegistration>();

	function register(registration: ExtensionSettingsRegistration) {
		if (!registration.namespace || !Array.isArray(registration.settings)) return;
		registrations.set(registration.namespace, registration);
	}

	function collectRegistrations() {
		pi.events.emit("extension-settings:request", { register } satisfies ExtensionSettingsRequest);
	}

	pi.events.on("extension-settings:register", (registration) => {
		register(registration as ExtensionSettingsRegistration);
	});

	pi.on("session_start", async () => {
		collectRegistrations();
	});

	pi.registerCommand("extension-settings", {
		description: "Configure settings registered by extensions",
		handler: async (_args, ctx) => {
			collectRegistrations();

			const settings = flattenSettings();
			if (settings.length === 0) {
				ctx.ui.notify("No extension settings registered", "info");
				return;
			}

			const items: SettingItem[] = [];
			for (const setting of settings) {
				const currentValue = await setting.get().catch(() => setting.values[0] ?? "");
				items.push({
					id: setting.fullId,
					label: `${setting.title} › ${setting.label}`,
					description: setting.description,
					currentValue,
					values: setting.values,
				});
			}

			const byId = new Map(settings.map((setting) => [setting.fullId, setting]));

			await ctx.ui.custom((tui, theme, _keybindings, done) => {
				const container = new Container();
				container.addChild(new Text(theme.fg("accent", theme.bold("Extension Settings")), 1, 1));

				const settingsList = new SettingsList(
					items,
					Math.min(items.length + 2, 18),
					getSettingsListTheme(),
					(id, newValue) => {
						const setting = byId.get(id);
						if (!setting) return;
						void Promise.resolve(setting.set(newValue, ctx)).catch((error) => {
							ctx.ui.notify(
								`Failed to update ${setting.label}: ${error instanceof Error ? error.message : String(error)}`,
								"error",
							);
						});
					},
					() => done(undefined),
					{ enableSearch: true },
				);
				container.addChild(settingsList);

				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput(data: string) {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};
			});
		},
	});

	function flattenSettings(): RegisteredSetting[] {
		return [...registrations.values()]
			.sort((a, b) => (a.title ?? a.namespace).localeCompare(b.title ?? b.namespace))
			.flatMap((registration) => {
				const title = registration.title ?? registration.namespace;
				return registration.settings.map((setting) => ({
					...setting,
					namespace: registration.namespace,
					title,
					fullId: `${registration.namespace}.${setting.id}`,
				}));
			});
	}
}
