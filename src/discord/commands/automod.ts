import {
	type AutomodService,
	MAX_RULE_NAME_LENGTH,
	type RuleInput,
	type RulePatch,
} from "../../domains/automod/engine.ts";
import type { RaidService } from "../../domains/automod/raid-service.ts";
import {
	type AutomodMessage,
	type AutomodRule,
	describeRule,
	ESCALATION_LADDER,
	evaluateRule,
	isRuleType,
	parseRuleConfig,
	RULE_TYPES,
	type RuleType,
	windowKindOf,
} from "../../domains/automod/rules.ts";
import type { AuditService } from "../../domains/audit/service.ts";
import type { PermissionService } from "../../permissions/service.ts";
import { MAX_TIMEOUT_MS, parseDuration } from "../../shared/duration.ts";
import { ValidationFailed } from "../../shared/errors.ts";
import { snowflakeCreatedAt } from "../../shared/snowflake.ts";
import { escapeMarkdown, truncate } from "../../shared/text.ts";
import type { DiscordApi } from "../adapters/discord-api.ts";
import type { InteractionContext } from "../interactions/context.ts";
import { LOG_COLORS } from "../logging/discord-log.ts";
import {
	actorOf,
	bool,
	channel,
	group,
	int,
	requireSubcommand,
	role,
	slash,
	str,
	sub,
} from "./helpers.ts";
import type { CommandDefinition } from "./registry.ts";

export interface AutomodDeps {
	api: DiscordApi;
	automod: AutomodService;
	raid: RaidService;
	permissions: PermissionService;
	audit: AuditService;
}

const MAX_CONFIG_LENGTH = 1000;

const nameOption = str("name", "Rule name", {
	required: true,
	maxLength: MAX_RULE_NAME_LENGTH,
	autocomplete: true,
});

const settingOptions = [
	str("config", 'Rule settings as JSON, e.g. {"maxMentions": 8}', {
		maxLength: MAX_CONFIG_LENGTH,
	}),
	bool("delete", "Delete the offending message"),
	bool("warn", "DM the member a warning"),
	str("timeout", "Timeout length, e.g. 10m, 1h, or off", { maxLength: 20 }),
	bool("notify", "Ping the raid alert role in the automod log"),
	bool("case", "Record a moderation case"),
	int("cooldown", "Seconds before the same rule punishes the member again", {
		minValue: 0,
		maxValue: 86400,
	}),
	int("severity", "Higher severity wins when several rules match", { minValue: 1, maxValue: 10 }),
];

function parseConfigOption(raw: string | undefined, type: RuleType): unknown {
	if (raw === undefined) return undefined;
	const text = raw.trim();
	if (!text) return {};
	if (text.length > MAX_CONFIG_LENGTH) {
		throw new ValidationFailed(`Config must be ${MAX_CONFIG_LENGTH} characters or fewer.`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ValidationFailed('Config must be a JSON object, e.g. `{"maxMentions": 8}`.');
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ValidationFailed("Config must be a JSON object.");
	}
	return parseRuleConfig(type, parsed);
}

function parseTimeoutOption(raw: string | undefined): number | null | undefined {
	if (raw === undefined) return undefined;
	const text = raw.trim().toLowerCase();
	if (!text || text === "off" || text === "0") return null;
	const ms = parseDuration(text);
	if (!ms || ms > MAX_TIMEOUT_MS) {
		throw new ValidationFailed("Timeout must look like `10m`, `1h` or `1d`, up to 28 days.");
	}
	return ms;
}

function actionsFrom(ctx: InteractionContext): RuleInput["actions"] {
	const timeoutMs = parseTimeoutOption(ctx.string("timeout"));
	const actions: NonNullable<RuleInput["actions"]> = {};
	const remove = ctx.boolean("delete");
	if (remove !== undefined) actions.delete = remove;
	const warn = ctx.boolean("warn");
	if (warn !== undefined) actions.warn = warn;
	if (timeoutMs !== undefined) actions.timeoutMs = timeoutMs;
	const notify = ctx.boolean("notify");
	if (notify !== undefined) actions.notifyStaff = notify;
	const createCase = ctx.boolean("case");
	if (createCase !== undefined) actions.createCase = createCase;
	return Object.keys(actions).length ? actions : undefined;
}

function patchFrom(ctx: InteractionContext, type: RuleType): RulePatch {
	const patch: RulePatch = {};
	const config = parseConfigOption(ctx.string("config"), type);
	if (config !== undefined) patch.config = config;
	const actions = actionsFrom(ctx);
	if (actions) patch.actions = actions;
	const cooldown = ctx.integer("cooldown");
	if (cooldown !== undefined) patch.cooldownSeconds = cooldown;
	const severity = ctx.integer("severity");
	if (severity !== undefined) patch.severity = severity;
	return patch;
}

function ruleEmbed(rule: AutomodRule) {
	return {
		title: `Automod rule · ${rule.name}`,
		color: rule.enabled ? LOG_COLORS.info : LOG_COLORS.neutral,
		description: describeRule(rule),
	};
}

function syntheticMessage(ctx: InteractionContext, text: string): AutomodMessage {
	return {
		guildId: ctx.guildId,
		channelId: ctx.channelId ?? ctx.guildId,
		messageId: 0n,
		authorId: ctx.userId,
		authorRoleIds: [],
		authorIsBot: false,
		accountCreatedAt: snowflakeCreatedAt(ctx.userId),
		content: text,
		mentionedUserIds: [...text.matchAll(/<@!?(\d{17,20})>/g)].map(([, id]) => BigInt(id!)),
		mentionedRoleIds: [...text.matchAll(/<@&(\d{17,20})>/g)].map(([, id]) => BigInt(id!)),
		mentionsEveryone: /@(everyone|here)/.test(text),
		attachmentCount: 0,
		createdAt: new Date(),
	};
}

export function automodCommands(deps: AutomodDeps): CommandDefinition[] {
	const { api, automod, raid, permissions, audit } = deps;

	const authorize = async (ctx: InteractionContext) => {
		const actor = await actorOf(api, ctx);
		await permissions.require(actor.actor, "automod.manage");
	};

	const record = (ctx: InteractionContext, action: string, name: string, data?: object) =>
		audit.record({
			guildId: ctx.guildId,
			actorId: ctx.userId,
			action: `automod.${action}`,
			target: name,
			data: { ...data },
		});

	return [{
		name: "automod",
		definition: slash("automod", "Configure automatic moderation rules", [
			sub("list", "Show every automod rule"),
			sub("view", "Show one rule in detail", [nameOption]),
			sub("enable", "Turn a rule on", [nameOption]),
			sub("disable", "Turn a rule off", [nameOption]),
			sub("delete", "Remove a rule", [nameOption]),
			sub("create", "Add a rule", [
				str("name", "Rule name", { required: true, maxLength: MAX_RULE_NAME_LENGTH }),
				str("type", "What the rule looks for", {
					required: true,
					choices: RULE_TYPES.map((type) => ({ name: type, value: type })),
				}),
				...settingOptions,
			]),
			sub("edit", "Change a rule", [nameOption, ...settingOptions]),
			group("exempt", "Roles and channels a rule ignores", [
				sub("add", "Exempt a role or channel", [
					nameOption,
					role("role", "Role to exempt"),
					channel("channel", "Channel to exempt"),
				]),
				sub("remove", "Stop exempting a role or channel", [
					nameOption,
					role("role", "Role to stop exempting"),
					channel("channel", "Channel to stop exempting"),
				]),
			]),
			sub("test", "Check a rule against some text without enforcing it", [
				nameOption,
				str("text", "Text to test", { required: true, maxLength: 2000 }),
			]),
			sub("raid-status", "Show the current join-rate picture"),
		], { defaultMemberPermissions: ["MANAGE_GUILD"] }),

		autocomplete: async (ctx) => {
			const focused = (ctx.string("name") ?? "").toLowerCase();
			const rules = await automod.list(ctx.guildId).catch(() => []);
			await ctx.interaction.respond({
				choices: rules
					.filter((rule) => rule.name.toLowerCase().includes(focused))
					.slice(0, 25)
					.map((rule) => ({ name: rule.name, value: rule.name })),
			});
		},

		handle: async (ctx) => {
			await ctx.defer(true);
			await authorize(ctx);
			const command = requireSubcommand(ctx);

			switch (command) {
				case "list": {
					const rules = await automod.list(ctx.guildId);
					await ctx.reply({
						embeds: [{
							title: "Automod rules",
							color: LOG_COLORS.info,
							description: rules.length
								? rules.map((rule) =>
									`${rule.enabled ? "🟢" : "⚪"} **${
										escapeMarkdown(rule.name)
									}** · \`${rule.type}\` · severity ${rule.severity}`
								).join("\n")
								: "No rules yet. Add one with `/automod create`.",
							footer: { text: ESCALATION_LADDER },
						}],
					});
					return;
				}

				case "view": {
					const rule = await automod.get(ctx.guildId, ctx.requireString("name"));
					await ctx.reply({ embeds: [ruleEmbed(rule)] });
					return;
				}

				case "enable":
				case "disable": {
					const rule = await automod.toggle(
						ctx.guildId,
						ctx.requireString("name"),
						command === "enable",
					);
					await record(ctx, command, rule.name);
					await ctx.reply(`**${escapeMarkdown(rule.name)}** is now ${command}d.`);
					return;
				}

				case "delete": {
					const rule = await automod.delete(ctx.guildId, ctx.requireString("name"));
					await record(ctx, "delete", rule.name, { type: rule.type });
					await ctx.reply(`Deleted **${escapeMarkdown(rule.name)}**.`);
					return;
				}

				case "create": {
					const type = ctx.requireString("type");
					if (!isRuleType(type)) throw new ValidationFailed("Pick a rule type from the list.");
					const rule = await automod.create(ctx.guildId, {
						name: ctx.requireString("name"),
						type,
						config: parseConfigOption(ctx.string("config"), type),
						actions: actionsFrom(ctx),
						cooldownSeconds: ctx.integer("cooldown"),
						severity: ctx.integer("severity"),
					}, ctx.userId);
					await record(ctx, "create", rule.name, { type: rule.type });
					await ctx.reply({ content: "Rule created.", embeds: [ruleEmbed(rule)] });
					return;
				}

				case "edit": {
					const existing = await automod.get(ctx.guildId, ctx.requireString("name"));
					const patch = patchFrom(ctx, existing.type);
					if (!Object.keys(patch).length) {
						throw new ValidationFailed("Change at least one setting.");
					}
					const rule = await automod.update(ctx.guildId, existing.name, patch);
					await record(ctx, "edit", rule.name, { fields: Object.keys(patch) });
					await ctx.reply({ content: "Rule updated.", embeds: [ruleEmbed(rule)] });
					return;
				}

				case "add":
				case "remove": {
					const existing = await automod.get(ctx.guildId, ctx.requireString("name"));
					const roleId = ctx.roleOption("role");
					const channelId = ctx.channelOption("channel");
					if (!roleId && !channelId) {
						throw new ValidationFailed("Pick a role, a channel, or both.");
					}
					const apply = (current: bigint[], id: bigint | undefined): bigint[] => {
						if (!id) return current;
						return command === "add"
							? [...new Set([...current, id])]
							: current.filter((value) => value !== id);
					};
					const rule = await automod.update(ctx.guildId, existing.name, {
						exemptRoleIds: apply(existing.exemptRoleIds, roleId),
						exemptChannelIds: apply(existing.exemptChannelIds, channelId),
					});
					await record(ctx, `exempt.${command}`, rule.name, {
						roleId: roleId ? String(roleId) : null,
						channelId: channelId ? String(channelId) : null,
					});
					await ctx.reply({ content: "Exemptions updated.", embeds: [ruleEmbed(rule)] });
					return;
				}

				case "test": {
					const rule = await automod.get(ctx.guildId, ctx.requireString("name"));
					const text = ctx.requireString("text");
					const windowed = windowKindOf(rule.type) !== null;
					const found = evaluateRule(rule, syntheticMessage(ctx, text), null);
					await ctx.reply({
						embeds: [{
							title: `Test · ${rule.name}`,
							color: found ? LOG_COLORS.warning : LOG_COLORS.success,
							description: found
								? `**Match.** ${found.reason}`
								: windowed
								? "**No match.** This rule counts messages over time, so a single sample can never trigger it."
								: "**No match.** Nothing in that text breaks this rule.",
							fields: [{
								name: "Sample",
								value: `\`\`\`\n${truncate(text.replaceAll("```", "'''"), 500)}\n\`\`\``,
								inline: false,
							}],
							footer: { text: "Test runs the rule only. Nothing was deleted or recorded." },
						}],
					});
					return;
				}

				case "raid-status": {
					const status = await raid.status(ctx.guildId);
					await ctx.reply({
						embeds: [{
							title: "Raid watch",
							color: status.alerting ? LOG_COLORS.danger : LOG_COLORS.info,
							description: status.available
								? `${status.joins} joins counted in the last ${status.windowSeconds}s, ${status.youngAccounts} of them accounts under ${status.minAccountAgeHours}h.`
								: "Join tracking is unavailable right now (Redis is down). Loop keeps moderating; only raid counting pauses.",
							fields: [
								{ name: "Threshold", value: `${status.threshold} joins`, inline: true },
								{ name: "Window", value: `${status.windowSeconds}s`, inline: true },
								{
									name: "Alert active",
									value: status.alerting ? "Yes, staff were pinged" : "No",
									inline: true,
								},
							],
							footer: {
								text: "Loop reports raids. It never locks the server, kicks, or gates members.",
							},
						}],
					});
					return;
				}
			}
		},
	}];
}
