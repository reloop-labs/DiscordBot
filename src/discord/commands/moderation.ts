import { BitwisePermissionFlags } from "@discordeno/bot";
import type { DiscordApi } from "../adapters/discord-api.ts";
import { LOG_COLORS } from "../logging/discord-log.ts";
import type { InteractionContext } from "../interactions/context.ts";
import type { CaseService, ModerationCase } from "../../domains/moderation/case-service.ts";
import type { ModerationService } from "../../domains/moderation/moderation-service.ts";
import type { AuditService } from "../../domains/audit/service.ts";
import {
	assertCanModerate,
	basePermissions,
	hasDiscordPermission,
} from "../../permissions/hierarchy.ts";
import type { PermissionService } from "../../permissions/service.ts";
import { BotMissingPermission, ValidationFailed } from "../../shared/errors.ts";
import { discordTimestamp, formatDuration, parseDuration } from "../../shared/duration.ts";
import { escapeMarkdown, truncate, userMention } from "../../shared/text.ts";
import type { CommandDefinition } from "./registry.ts";
import {
	actorOf,
	channel,
	int,
	requireSubcommand,
	slash,
	str,
	sub,
	targetOf,
	user,
} from "./helpers.ts";

export interface ModerationDeps {
	api: DiscordApi;
	moderation: ModerationService;
	cases: CaseService;
	permissions: PermissionService;
	audit: AuditService;
}

const reasonOption = str("reason", "Why this action is being taken", { maxLength: 512 });

function caseLine(c: ModerationCase): string {
	const status = c.status === "active" ? "" : ` (${c.status})`;
	const duration = c.durationMs ? ` · ${formatDuration(c.durationMs)}` : "";
	return `**#${c.caseNumber}** ${c.action}${status}${duration} · ${
		discordTimestamp(c.createdAt, "R")
	} · ${truncate(c.reason ?? "No reason", 80)}`;
}

function caseEmbed(
	c: ModerationCase,
	notes: { authorId: bigint; content: string; createdAt: Date }[],
) {
	return {
		title: `Case #${c.caseNumber} · ${c.action}`,
		color: c.status === "voided" ? LOG_COLORS.neutral : LOG_COLORS.info,
		fields: [
			{ name: "User", value: `${userMention(c.targetUserId)} (${c.targetUserId})`, inline: true },
			{ name: "Moderator", value: userMention(c.moderatorUserId), inline: true },
			{ name: "Status", value: c.status, inline: true },
			...(c.durationMs
				? [{ name: "Duration", value: formatDuration(c.durationMs), inline: true }]
				: []),
			{ name: "Created", value: discordTimestamp(c.createdAt), inline: true },
			{ name: "Reason", value: c.reason ?? "*No reason provided*", inline: false },
			...(c.status === "voided"
				? [{
					name: "Voided",
					value: `by ${userMention(c.voidedBy!)} ${discordTimestamp(c.voidedAt!, "R")}${
						c.voidReason ? ` · ${c.voidReason}` : ""
					}`,
					inline: false,
				}]
				: []),
			...(notes.length
				? [{
					name: "Notes",
					value: truncate(
						notes.map((n) =>
							`${userMention(n.authorId)} ${discordTimestamp(n.createdAt, "R")}: ${n.content}`
						).join("\n"),
						1000,
					),
					inline: false,
				}]
				: []),
		],
	};
}

export function moderationCommands(deps: ModerationDeps): CommandDefinition[] {
	const { api, moderation, cases, permissions, audit } = deps;

	const action = (
		name: string,
		description: string,
		options: Parameters<typeof slash>[2],
		run: (ctx: InteractionContext) => Promise<string>,
		defaultPermission: keyof typeof BitwisePermissionFlags,
	): CommandDefinition => ({
		name,
		definition: slash(name, description, options, {
			defaultMemberPermissions: [defaultPermission],
		}),
		handle: async (ctx) => {
			await ctx.defer(true);
			const message = await run(ctx);
			await ctx.reply({ content: message, ephemeral: true });
		},
	});

	const summary = (
		verb: string,
		result: { case: ModerationCase; dmDelivered: boolean },
		username: string,
	) =>
		`${verb} **${escapeMarkdown(username)}** · Case #${result.case.caseNumber}${
			result.dmDelivered ? "" : " · DM not delivered"
		}`;

	return [
		action("warn", "Warn a member and record a case", [
			user("user", "Member to warn", { required: true }),
			reasonOption,
		], async (ctx) => {
			const actor = await actorOf(api, ctx);
			const target = await targetOf(api, ctx);
			const result = await moderation.warn({ actor, target, reason: ctx.string("reason") ?? null });
			return summary("Warned", result, target.username);
		}, "MODERATE_MEMBERS"),

		action(
			"timeout",
			"Time out a member",
			[
				user("user", "Member to time out", { required: true }),
				str("duration", "How long, e.g. 10m, 2h, 1d (max 28d)", { required: true, maxLength: 20 }),
				reasonOption,
			],
			async (ctx) => {
				const durationMs = parseDuration(ctx.requireString("duration"));
				if (!durationMs) {
					throw new ValidationFailed("Duration must look like `10m`, `2h`, `1d` or `1h30m`.");
				}
				const actor = await actorOf(api, ctx);
				const target = await targetOf(api, ctx);
				const result = await moderation.timeout({
					actor,
					target,
					reason: ctx.string("reason") ?? null,
					durationMs,
				});
				return summary(`Timed out for ${formatDuration(durationMs)}:`, result, target.username);
			},
			"MODERATE_MEMBERS",
		),

		action("untimeout", "Remove a member's timeout", [
			user("user", "Member", { required: true }),
			reasonOption,
		], async (ctx) => {
			const actor = await actorOf(api, ctx);
			const target = await targetOf(api, ctx);
			const result = await moderation.untimeout({
				actor,
				target,
				reason: ctx.string("reason") ?? null,
			});
			return summary("Removed timeout for", result, target.username);
		}, "MODERATE_MEMBERS"),

		action("kick", "Kick a member", [
			user("user", "Member to kick", { required: true }),
			reasonOption,
		], async (ctx) => {
			const actor = await actorOf(api, ctx);
			const target = await targetOf(api, ctx);
			const result = await moderation.kick({ actor, target, reason: ctx.string("reason") ?? null });
			return summary("Kicked", result, target.username);
		}, "KICK_MEMBERS"),

		action(
			"ban",
			"Ban a user (works even if they already left)",
			[
				user("user", "User to ban", { required: true }),
				reasonOption,
				int("delete_days", "Delete their messages from the last N days (0-7)", {
					minValue: 0,
					maxValue: 7,
				}),
			],
			async (ctx) => {
				const actor = await actorOf(api, ctx);
				const target = await targetOf(api, ctx);
				const days = ctx.integer("delete_days") ?? 0;
				const result = await moderation.ban({
					actor,
					target,
					reason: ctx.string("reason") ?? null,
					deleteMessageSeconds: days * 86_400,
				});
				return summary("Banned", result, target.username);
			},
			"BAN_MEMBERS",
		),

		action("unban", "Remove a ban", [
			str("user", "User ID to unban", { required: true, maxLength: 20 }),
			reasonOption,
		], async (ctx) => {
			const actor = await actorOf(api, ctx);
			const target = await targetOf(api, ctx);
			const result = await moderation.unban({
				actor,
				target,
				reason: ctx.string("reason") ?? null,
			});
			return summary("Unbanned", result, target.username);
		}, "BAN_MEMBERS"),

		action(
			"purge",
			"Bulk delete recent messages in this channel",
			[
				int("amount", "How many messages to check (1-100)", {
					required: true,
					minValue: 1,
					maxValue: 100,
				}),
				user("user", "Only delete messages from this user"),
			],
			async (ctx) => {
				const actor = await actorOf(api, ctx);
				await permissions.require(actor.actor, "moderation.purge");
				if (
					!hasDiscordPermission(
						basePermissions(actor.guild, actor.botMember),
						BitwisePermissionFlags.MANAGE_MESSAGES,
					)
				) {
					throw new BotMissingPermission("Manage Messages");
				}
				if (!ctx.channelId) throw new ValidationFailed("Run this inside a channel.");
				const amount = ctx.integer("amount") ?? 10;
				const only = ctx.userOption("user")?.id;
				const twoWeeksAgo = Date.now() - 13 * 86_400_000;
				const messages = await api.getMessages(ctx.channelId, { limit: amount });
				const ids = messages
					.filter((m) =>
						m.createdAt.getTime() > twoWeeksAgo && (!only || m.authorId === only) && !m.pinned
					)
					.map((m) => m.id);
				await api.bulkDeleteMessages(ctx.channelId, ids, `${actor.member.username}: purge`);
				await audit.record({
					guildId: ctx.guildId,
					actorId: ctx.userId,
					action: "purge",
					target: String(ctx.channelId),
					data: { count: ids.length, only },
				});
				return `Deleted ${ids.length} message${ids.length === 1 ? "" : "s"}.`;
			},
			"MANAGE_MESSAGES",
		),

		action(
			"slowmode",
			"Set slowmode on a channel",
			[
				str("interval", "Delay between messages, e.g. 5s, 2m, or off", {
					required: true,
					maxLength: 10,
				}),
				channel("channel", "Channel (defaults to this one)"),
			],
			async (ctx) => {
				const actor = await actorOf(api, ctx);
				await permissions.require(actor.actor, "moderation.channels");
				const raw = ctx.requireString("interval").toLowerCase();
				const seconds = raw === "off" || raw === "0"
					? 0
					: Math.floor((parseDuration(raw) ?? -1) / 1000);
				if (seconds < 0 || seconds > 21_600) {
					throw new ValidationFailed("Interval must be between 0 and 6 hours.");
				}
				const channelId = ctx.channelOption("channel") ?? ctx.channelId;
				if (!channelId) throw new ValidationFailed("Pick a channel.");
				await api.editChannel(
					channelId,
					{ rateLimitPerUser: seconds },
					`${actor.member.username}: slowmode`,
				);
				await audit.record({
					guildId: ctx.guildId,
					actorId: ctx.userId,
					action: "slowmode",
					target: String(channelId),
					data: { seconds },
				});
				return seconds === 0
					? `Slowmode disabled in <#${channelId}>.`
					: `Slowmode set to ${formatDuration(seconds * 1000)} in <#${channelId}>.`;
			},
			"MANAGE_CHANNELS",
		),

		...(["lock", "unlock"] as const).map((verb) =>
			action(
				verb,
				verb === "lock"
					? "Stop @everyone from sending messages in a channel"
					: "Allow @everyone to send messages again",
				[channel("channel", "Channel (defaults to this one)"), reasonOption],
				async (ctx) => {
					const actor = await actorOf(api, ctx);
					await permissions.require(actor.actor, "moderation.channels");
					const channelId = ctx.channelOption("channel") ?? ctx.channelId;
					if (!channelId) throw new ValidationFailed("Pick a channel.");
					const sendMessages = BigInt(BitwisePermissionFlags.SEND_MESSAGES);
					await api.setChannelPermission(
						channelId,
						{ id: ctx.guildId, kind: "role", allow: 0n, deny: verb === "lock" ? sendMessages : 0n },
						`${actor.member.username}: ${verb}${
							ctx.string("reason") ? ` · ${ctx.string("reason")}` : ""
						}`,
					);
					if (verb === "unlock") {
						await api.deleteChannelPermission(
							channelId,
							ctx.guildId,
							`${actor.member.username}: unlock`,
						).catch(() => {});
					}
					await audit.record({
						guildId: ctx.guildId,
						actorId: ctx.userId,
						action: verb,
						target: String(channelId),
						data: { reason: ctx.string("reason") },
					});
					return `<#${channelId}> ${verb === "lock" ? "locked" : "unlocked"}.`;
				},
				"MANAGE_CHANNELS",
			)
		),

		action(
			"nickname",
			"Change or clear a member's nickname",
			[
				user("user", "Member", { required: true }),
				str("nickname", "New nickname (leave empty to clear)", { maxLength: 32 }),
			],
			async (ctx) => {
				const actor = await actorOf(api, ctx);
				await permissions.require(actor.actor, "moderation.nickname");
				const target = await targetOf(api, ctx);
				assertCanModerate({
					guild: actor.guild,
					actor: actor.member,
					bot: actor.botMember,
					target: target.member,
					targetUserId: target.userId,
					requiredBotPermission: BitwisePermissionFlags.MANAGE_NICKNAMES,
					requiredBotPermissionName: "Manage Nicknames",
				});
				const nickname = ctx.string("nickname")?.trim() || null;
				await api.setNickname(
					ctx.guildId,
					target.userId,
					nickname,
					`${actor.member.username}: nickname`,
				);
				await audit.record({
					guildId: ctx.guildId,
					actorId: ctx.userId,
					action: "nickname",
					target: String(target.userId),
					data: { nickname },
				});
				return nickname
					? `Nickname for **${escapeMarkdown(target.username)}** set to **${
						escapeMarkdown(nickname)
					}**.`
					: `Nickname for **${escapeMarkdown(target.username)}** cleared.`;
			},
			"MANAGE_NICKNAMES",
		),

		{
			name: "history",
			definition: slash("history", "Show a user's moderation history", [
				user("user", "User", { required: true }),
			], {
				defaultMemberPermissions: ["MODERATE_MEMBERS"],
			}),
			handle: async (ctx) => {
				await ctx.defer(true);
				const actor = await actorOf(api, ctx);
				await permissions.require(actor.actor, "moderation.history");
				const target = await targetOf(api, ctx);
				const history = await cases.historyFor(ctx.guildId, target.userId);
				const notes = await permissions.has(actor.actor, "moderation.notes")
					? await cases.staffNotes(ctx.guildId, target.userId)
					: [];
				const counts = history.reduce<Record<string, number>>((acc, c) => {
					if (c.status !== "voided") acc[c.action] = (acc[c.action] ?? 0) + 1;
					return acc;
				}, {});
				await ctx.reply({
					embeds: [{
						title: `History for ${escapeMarkdown(target.username)}`,
						color: LOG_COLORS.info,
						description: history.length
							? history.slice(0, 15).map(caseLine).join("\n")
							: "No cases on record.",
						fields: [
							{
								name: "Totals",
								value: Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(" · ") || "none",
								inline: false,
							},
							...(notes.length
								? [{
									name: `Staff notes (${notes.length})`,
									value: truncate(
										notes.slice(0, 5).map((n) => `• ${n.content} — ${userMention(n.authorId)}`)
											.join("\n"),
										1000,
									),
									inline: false,
								}]
								: []),
						],
						footer: {
							text: `${target.userId}${
								target.member
									? ` · joined ${target.member.joinedAt.toISOString().slice(0, 10)}`
									: " · not in server"
							}`,
						},
					}],
				});
			},
		},

		{
			name: "case",
			definition: slash("case", "Look up or manage a moderation case", [
				sub("view", "Show a case", [int("number", "Case number", { required: true, minValue: 1 })]),
				sub("edit", "Change a case's reason", [
					int("number", "Case number", { required: true, minValue: 1 }),
					str("reason", "New reason", { required: true, maxLength: 512 }),
				]),
				sub("void", "Void a case (kept for the record)", [
					int("number", "Case number", { required: true, minValue: 1 }),
					str("reason", "Why it is being voided", { maxLength: 512 }),
				]),
				sub("note", "Attach an internal note to a case", [
					int("number", "Case number", { required: true, minValue: 1 }),
					str("content", "Note", { required: true, maxLength: 1000 }),
				]),
			], { defaultMemberPermissions: ["MODERATE_MEMBERS"] }),
			handle: async (ctx) => {
				await ctx.defer(true);
				const actor = await actorOf(api, ctx);
				await permissions.require(actor.actor, "moderation.cases");
				const number = ctx.integer("number")!;
				switch (requireSubcommand(ctx)) {
					case "view": {
						const c = await cases.getByNumber(ctx.guildId, number);
						await ctx.reply({ embeds: [caseEmbed(c, await cases.caseNotes(c.id))] });
						return;
					}
					case "edit": {
						const c = await cases.updateReason(ctx.guildId, number, ctx.requireString("reason"));
						await audit.record({
							guildId: ctx.guildId,
							actorId: ctx.userId,
							action: "case.edit",
							target: String(number),
						});
						await ctx.reply(`Case #${c.caseNumber} updated.`);
						return;
					}
					case "void": {
						const c = await cases.void(
							ctx.guildId,
							number,
							ctx.userId,
							ctx.string("reason") ?? null,
						);
						await audit.record({
							guildId: ctx.guildId,
							actorId: ctx.userId,
							action: "case.void",
							target: String(number),
						});
						await ctx.reply(
							`Case #${c.caseNumber} voided. It stays in the user's history marked as voided.`,
						);
						return;
					}
					case "note": {
						const c = await cases.getByNumber(ctx.guildId, number);
						await cases.addCaseNote(c.id, ctx.userId, ctx.requireString("content"));
						await ctx.reply(`Note added to case #${c.caseNumber}.`);
						return;
					}
				}
			},
		},

		{
			name: "staffnote",
			definition: slash("staffnote", "Private staff notes about a user", [
				sub("add", "Add a note", [
					user("user", "User", { required: true }),
					str("content", "Note", { required: true, maxLength: 1000 }),
				]),
				sub("list", "List notes", [user("user", "User", { required: true })]),
				sub("remove", "Remove a note", [
					str("id", "Note ID (from the list)", { required: true, maxLength: 36 }),
				]),
			], { defaultMemberPermissions: ["MODERATE_MEMBERS"] }),
			handle: async (ctx) => {
				await ctx.defer(true);
				const actor = await actorOf(api, ctx);
				await permissions.require(actor.actor, "moderation.notes");
				switch (requireSubcommand(ctx)) {
					case "add": {
						const target = await targetOf(api, ctx);
						await cases.addStaffNote(
							ctx.guildId,
							target.userId,
							ctx.userId,
							ctx.requireString("content"),
						);
						await ctx.reply(`Note added for **${escapeMarkdown(target.username)}**.`);
						return;
					}
					case "list": {
						const target = await targetOf(api, ctx);
						const notes = await cases.staffNotes(ctx.guildId, target.userId);
						await ctx.reply({
							embeds: [{
								title: `Staff notes · ${escapeMarkdown(target.username)}`,
								color: LOG_COLORS.neutral,
								description: notes.length
									? notes.map((n) =>
										`\`${n.id.slice(0, 8)}\` ${discordTimestamp(n.createdAt, "R")} ${
											userMention(n.authorId)
										}: ${n.content}`
									).join("\n")
									: "No notes.",
							}],
						});
						return;
					}
					case "remove": {
						const prefix = ctx.requireString("id");
						const removed = await cases.deleteStaffNoteByPrefix(ctx.guildId, prefix, ctx.userId);
						await ctx.reply(removed ? "Note removed." : "No note with that ID.");
						return;
					}
				}
			},
		},
	];
}
