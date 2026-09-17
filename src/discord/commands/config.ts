import type { DiscordApi } from "../adapters/discord-api.ts";
import { LOG_COLORS } from "../logging/discord-log.ts";
import type {
	GuildConfigService,
	GuildSettings,
	LogKind,
} from "../../domains/guild-config/service.ts";
import type { AuditService } from "../../domains/audit/service.ts";
import { assertCanManageRole } from "../../permissions/hierarchy.ts";
import { isPermission, PERMISSION_GROUPS, PERMISSIONS } from "../../permissions/keys.ts";
import type { PermissionService } from "../../permissions/service.ts";
import { ValidationFailed } from "../../shared/errors.ts";
import { channelMention, roleMention, truncate } from "../../shared/text.ts";
import type { CommandDefinition } from "./registry.ts";
import {
	actorOf,
	bool,
	channel,
	int,
	requireSubcommand,
	role,
	slash,
	str,
	sub,
} from "./helpers.ts";

export interface ConfigDeps {
	api: DiscordApi;
	config: GuildConfigService;
	permissions: PermissionService;
	audit: AuditService;
}

const LOG_KINDS: LogKind[] = [
	"moderation",
	"automod",
	"joins",
	"leaves",
	"messages",
	"members",
	"tickets",
	"reports",
	"suggestions",
	"config",
];

const PLACEHOLDERS = "{user} {username} {server} {membercount}";

function overview(settings: GuildSettings, logs: Partial<Record<LogKind, bigint>>) {
	const c = (id: bigint | null | undefined) => (id ? channelMention(id) : "*not set*");
	const r = (id: bigint | null | undefined) => (id ? roleMention(id) : "*not set*");
	return {
		title: "Loop configuration",
		color: LOG_COLORS.info,
		fields: [
			{ name: "Member role", value: r(settings.memberRoleId), inline: true },
			{
				name: "Persist roles on rejoin",
				value: settings.persistRoles ? "on" : "off",
				inline: true,
			},
			{ name: "DM on moderation", value: settings.dmOnModeration ? "on" : "off", inline: true },
			{
				name: "Welcome",
				value: `${c(settings.welcomeChannelId)}\n${
					truncate(settings.welcomeMessage ?? "*default message*", 120)
				}`,
				inline: false,
			},
			{
				name: "Leave",
				value: `${c(settings.leaveChannelId)}\n${
					truncate(settings.leaveMessage ?? "*default message*", 120)
				}`,
				inline: false,
			},
			{ name: "Suggestions channel", value: c(settings.suggestionChannelId), inline: true },
			{ name: "Reports channel", value: c(settings.reportChannelId), inline: true },
			{ name: "Ticket archive category", value: c(settings.ticketArchiveCategoryId), inline: true },
			{ name: "Ticket inactivity", value: `${settings.ticketInactivityHours}h`, inline: true },
			{
				name: "Raid signals",
				value:
					`${settings.raidJoinThreshold} joins / ${settings.raidJoinWindowSeconds}s · accounts under ${settings.raidMinAccountAgeHours}h flagged · alert ${
						r(settings.raidAlertRoleId)
					}`,
				inline: false,
			},
			{
				name: "Log channels",
				value: LOG_KINDS.map((kind) => `${kind}: ${c(logs[kind])}`).join("\n"),
				inline: false,
			},
		],
	};
}

export function configCommands(deps: ConfigDeps): CommandDefinition[] {
	const { api, config, permissions, audit } = deps;

	return [
		{
			name: "config",
			definition: slash("config", "Configure Loop for this server", [
				sub("view", "Show the current configuration"),
				sub("member-role", "Role given to every member on join", [
					role("role", "Role (omit to clear)"),
				]),
				sub("welcome", "Welcome message settings", [
					channel("channel", "Channel (omit to disable)"),
					str("message", `Message. Placeholders: ${PLACEHOLDERS}`, { maxLength: 1000 }),
				]),
				sub("leave", "Leave message settings", [
					channel("channel", "Channel (omit to disable)"),
					str("message", `Message. Placeholders: ${PLACEHOLDERS}`, { maxLength: 1000 }),
				]),
				sub("logs", "Set a log channel", [
					str("kind", "What to log", {
						required: true,
						choices: LOG_KINDS.map((k) => ({ name: k, value: k })),
					}),
					channel("channel", "Channel (omit to disable)"),
				]),
				sub("toggles", "Behaviour toggles", [
					bool("dm_on_moderation", "DM users when they are moderated"),
					bool("persist_roles", "Restore roles when a member rejoins"),
				]),
				sub("channels", "Feature channels", [
					channel("suggestions", "Suggestions channel"),
					channel("reports", "Where reports are posted for staff"),
					channel("ticket_archive", "Category closed tickets move to"),
				]),
				sub("raid", "Raid detection thresholds", [
					int("join_threshold", "Joins within the window that trigger an alert", {
						minValue: 2,
						maxValue: 500,
					}),
					int("join_window", "Window in seconds", { minValue: 10, maxValue: 3600 }),
					int("min_account_age", "Flag accounts younger than this many hours", {
						minValue: 0,
						maxValue: 720,
					}),
					role("alert_role", "Role to mention on a raid alert"),
					int("ticket_inactivity", "Hours before an inactive ticket is flagged", {
						minValue: 1,
						maxValue: 720,
					}),
				]),
			], { defaultMemberPermissions: ["MANAGE_GUILD"] }),
			handle: async (ctx) => {
				await ctx.defer(true);
				const actor = await actorOf(api, ctx);
				await permissions.require(actor.actor, "config.manage");
				const command = requireSubcommand(ctx);
				const record = (data: Record<string, unknown>) =>
					audit.record({
						guildId: ctx.guildId,
						actorId: ctx.userId,
						action: `config.${command}`,
						data,
					});

				switch (command) {
					case "view": {
						await ctx.reply({
							embeds: [
								overview(await config.get(ctx.guildId), await config.logChannels(ctx.guildId)),
							],
						});
						return;
					}
					case "member-role": {
						const roleId = ctx.roleOption("role") ?? null;
						if (roleId) assertCanManageRole(actor.guild, actor.botMember, roleId);
						await config.update(ctx.guildId, { memberRoleId: roleId });
						await record({ roleId });
						await ctx.reply(
							roleId
								? `New members will receive ${roleMention(roleId)}.`
								: "Automatic member role disabled.",
						);
						return;
					}
					case "welcome":
					case "leave": {
						const channelId = ctx.channelOption("channel") ?? null;
						const message = ctx.string("message")?.trim() || null;
						await config.update(
							ctx.guildId,
							command === "welcome"
								? {
									welcomeChannelId: channelId,
									...(message !== null ? { welcomeMessage: message } : {}),
								}
								: {
									leaveChannelId: channelId,
									...(message !== null ? { leaveMessage: message } : {}),
								},
						);
						await record({ channelId, message });
						await ctx.reply(
							channelId
								? `${command} messages go to ${channelMention(channelId)}.`
								: `${command} messages disabled.`,
						);
						return;
					}
					case "logs": {
						const kind = ctx.requireString("kind") as LogKind;
						if (!LOG_KINDS.includes(kind)) throw new ValidationFailed("Unknown log kind.");
						const channelId = ctx.channelOption("channel") ?? null;
						await config.setLogChannel(ctx.guildId, kind, channelId);
						await record({ kind, channelId });
						await ctx.reply(
							channelId
								? `${kind} logs go to ${channelMention(channelId)}.`
								: `${kind} logs disabled.`,
						);
						return;
					}
					case "toggles": {
						const patch: Record<string, boolean> = {};
						const dm = ctx.boolean("dm_on_moderation");
						const persist = ctx.boolean("persist_roles");
						if (dm !== undefined) patch.dmOnModeration = dm;
						if (persist !== undefined) patch.persistRoles = persist;
						if (!Object.keys(patch).length) throw new ValidationFailed("Pick at least one toggle.");
						await config.update(ctx.guildId, patch);
						await record(patch);
						await ctx.reply(
							`Updated: ${
								Object.entries(patch).map(([k, v]) => `${k}=${v ? "on" : "off"}`).join(", ")
							}.`,
						);
						return;
					}
					case "channels": {
						const patch: Record<string, bigint> = {};
						const s = ctx.channelOption("suggestions");
						const r = ctx.channelOption("reports");
						const t = ctx.channelOption("ticket_archive");
						if (s) patch.suggestionChannelId = s;
						if (r) patch.reportChannelId = r;
						if (t) patch.ticketArchiveCategoryId = t;
						if (!Object.keys(patch).length) {
							throw new ValidationFailed("Pick at least one channel.");
						}
						await config.update(ctx.guildId, patch);
						await record(patch);
						await ctx.reply("Feature channels updated.");
						return;
					}
					case "raid": {
						const patch: Record<string, number | bigint> = {};
						const map: [string, number | bigint | undefined][] = [
							["raidJoinThreshold", ctx.integer("join_threshold")],
							["raidJoinWindowSeconds", ctx.integer("join_window")],
							["raidMinAccountAgeHours", ctx.integer("min_account_age")],
							["raidAlertRoleId", ctx.roleOption("alert_role")],
							["ticketInactivityHours", ctx.integer("ticket_inactivity")],
						];
						for (const [key, value] of map) if (value !== undefined) patch[key] = value;
						if (!Object.keys(patch).length) {
							throw new ValidationFailed("Pick at least one setting.");
						}
						await config.update(ctx.guildId, patch);
						await record(patch);
						await ctx.reply("Raid settings updated.");
						return;
					}
				}
			},
		},

		{
			name: "permissions",
			definition: slash("permissions", "Map Discord roles to Loop permissions", [
				sub("grant", "Grant a permission or group to a role", [
					role("role", "Role", { required: true }),
					str("permission", "Permission key or group (moderator, senior-moderator, admin)", {
						required: true,
						autocomplete: true,
					}),
				]),
				sub("revoke", "Revoke a permission or group from a role", [
					role("role", "Role", { required: true }),
					str("permission", "Permission key or group", { required: true, autocomplete: true }),
				]),
				sub("list", "Show all grants"),
				sub("keys", "List every permission key"),
			], { defaultMemberPermissions: ["MANAGE_GUILD"] }),
			autocomplete: async (ctx) => {
				const focused = (ctx.options().permission as string | undefined ?? "").toLowerCase();
				const candidates = [...Object.keys(PERMISSION_GROUPS), ...PERMISSIONS].filter((k) =>
					k.includes(focused)
				).slice(0, 25);
				await ctx.interaction.respond({ choices: candidates.map((k) => ({ name: k, value: k })) });
			},
			handle: async (ctx) => {
				await ctx.defer(true);
				const actor = await actorOf(api, ctx);
				await permissions.require(actor.actor, "config.manage");
				const command = requireSubcommand(ctx);
				if (command === "keys") {
					await ctx.reply({
						embeds: [{
							title: "Permission keys",
							color: LOG_COLORS.neutral,
							description: PERMISSIONS.map((k) => `\`${k}\``).join("\n"),
							fields: Object.entries(PERMISSION_GROUPS).map(([name, keys]) => ({
								name: `group: ${name}`,
								value: keys.length === PERMISSIONS.length
									? "everything"
									: keys.map((k) => `\`${k}\``).join(" "),
								inline: false,
							})),
						}],
					});
					return;
				}
				if (command === "list") {
					const grants = await permissions.listGrants(ctx.guildId);
					const byRole = new Map<string, string[]>();
					for (const g of grants) {
						byRole.set(String(g.roleId), [...(byRole.get(String(g.roleId)) ?? []), g.permission]);
					}
					await ctx.reply({
						embeds: [{
							title: "Permission grants",
							color: LOG_COLORS.neutral,
							description: byRole.size
								? [...byRole].map(([roleId, keys]) =>
									`${roleMention(BigInt(roleId))}\n${
										keys.sort().map((k) => `  \`${k}\``).join("\n")
									}`
								).join("\n")
								: "No grants yet. Server owner and Discord administrators always have every permission.",
						}],
					});
					return;
				}
				const roleId = ctx.roleOption("role")!;
				const key = ctx.requireString("permission").toLowerCase();
				const keys = PERMISSION_GROUPS[key] ?? (isPermission(key) ? [key] : null);
				if (!keys) {
					throw new ValidationFailed(
						"Unknown permission. Use `/permissions keys` to see valid keys.",
					);
				}
				if (roleId === ctx.guildId) {
					throw new ValidationFailed("Granting Loop permissions to @everyone is not allowed.");
				}
				let changed = 0;
				for (const permission of keys) {
					changed += (command === "grant"
							? await permissions.grant(ctx.guildId, roleId, permission, ctx.userId)
							: await permissions.revoke(ctx.guildId, roleId, permission))
						? 1
						: 0;
				}
				await audit.record({
					guildId: ctx.guildId,
					actorId: ctx.userId,
					action: `permissions.${command}`,
					target: String(roleId),
					data: { keys },
				});
				await ctx.reply(
					`${command === "grant" ? "Granted" : "Revoked"} ${changed} permission${
						changed === 1 ? "" : "s"
					} ${command === "grant" ? "to" : "from"} ${roleMention(roleId)}.`,
				);
			},
		},
	];
}
