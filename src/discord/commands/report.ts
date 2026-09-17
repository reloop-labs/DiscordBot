import { MessageComponentTypes, TextStyles } from "@discordeno/bot";
import { z } from "zod";
import type { MessageComponents } from "@discordeno/bot";
import type { DiscordApi } from "../adapters/discord-api.ts";
import type { InteractionContext } from "../interactions/context.ts";
import { decodeCustomId, encodeCustomId } from "../interactions/custom-id.ts";
import { LOG_COLORS } from "../logging/discord-log.ts";
import type { ComponentModule } from "../interactions/router.ts";
import type { Report, ReportService } from "../../domains/reports/report-service.ts";
import { reportEmbed } from "../../domains/reports/report-service.ts";
import type { PermissionService } from "../../permissions/service.ts";
import type { KeyValueStore } from "../../redis/client.ts";
import { ValidationFailed } from "../../shared/errors.ts";
import { discordTimestamp } from "../../shared/duration.ts";
import { truncate, userMention } from "../../shared/text.ts";
import type { CommandDefinition } from "./registry.ts";
import {
	actorOf,
	CmdType,
	contextMenu,
	int,
	requireSubcommand,
	slash,
	str,
	sub,
	user,
} from "./helpers.ts";

export interface ReportCommandDeps {
	api: DiscordApi;
	reports: ReportService;
	permissions: PermissionService;
	store: KeyValueStore;
}

const DRAFT_TTL_MS = 600_000;

const draftSchema = z.object({ content: z.string(), authorId: z.string() });

const reasonOption = str("reason", "What happened?", {
	required: true,
	minLength: 10,
	maxLength: 1000,
});
const evidenceOption = str("evidence", "Links or extra context", { maxLength: 1000 });
const numberOption = int("number", "Report number", { required: true, minValue: 1 });

function modal(title: string, customId: string) {
	return {
		title,
		customId,
		components: [
			{
				type: MessageComponentTypes.ActionRow,
				components: [{
					type: MessageComponentTypes.InputText,
					customId: "reason",
					label: "What happened?",
					style: TextStyles.Paragraph,
					minLength: 10,
					maxLength: 1000,
					required: true,
				}],
			},
			{
				type: MessageComponentTypes.ActionRow,
				components: [{
					type: MessageComponentTypes.InputText,
					customId: "evidence",
					label: "Links or extra context (optional)",
					style: TextStyles.Paragraph,
					maxLength: 1000,
					required: false,
				}],
			},
		] as MessageComponents,
	};
}

function resolutionModal(customId: string, label: string) {
	return {
		title: label,
		customId,
		components: [
			{
				type: MessageComponentTypes.ActionRow,
				components: [{
					type: MessageComponentTypes.InputText,
					customId: "resolution",
					label: "What did you do?",
					style: TextStyles.Paragraph,
					minLength: 1,
					maxLength: 1000,
					required: true,
				}],
			},
		] as MessageComponents,
	};
}

function reportLine(report: Report): string {
	const target = report.targetUserId ? ` · ${userMention(report.targetUserId)}` : "";
	return `**#${report.reportNumber}** ${report.status}${target} · ${
		discordTimestamp(report.createdAt, "R")
	} · ${truncate(report.reason, 80)}`;
}

function draftKey(userId: bigint, messageId: string): string {
	return `report:draft:${userId}:${messageId}`;
}

async function readDraft(
	store: KeyValueStore,
	userId: bigint,
	messageId: string,
): Promise<{ content: string; authorId: string } | null> {
	const raw = await store.get(draftKey(userId, messageId));
	if (!raw) return null;
	try {
		const parsed = draftSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

export function reportCommands(deps: ReportCommandDeps): CommandDefinition[] {
	const { api, reports, permissions, store } = deps;

	const submitted = (report: Report) =>
		`Thanks. Report #${report.reportNumber} is with the staff team.`;

	const components: ComponentModule = {
		domain: "report",
		handle: async (ctx: InteractionContext) => {
			const decoded = decodeCustomId(ctx.customId);
			if (!decoded) throw new ValidationFailed("That button is no longer valid.");
			const [first, second] = decoded.args;
			switch (decoded.action) {
				case "claim": {
					await ctx.defer(true);
					const report = await reports.claim(first!, await actorOf(api, ctx));
					await ctx.reply(`Report #${report.reportNumber} is yours.`);
					return;
				}
				case "resolve":
					await ctx.showModal(
						resolutionModal(encodeCustomId("report", "resolvemodal", first!), "Resolve report"),
					);
					return;
				case "dismiss":
					await ctx.showModal(
						resolutionModal(encodeCustomId("report", "dismissmodal", first!), "Dismiss report"),
					);
					return;
				case "case":
					await ctx.reply(
						"Take the action with `/warn`, `/timeout`, `/kick` or `/ban`, then run `/reports link` to attach the case to this report.",
					);
					return;
				case "resolvemodal":
				case "dismissmodal": {
					await ctx.defer(true);
					const actor = await actorOf(api, ctx);
					const resolution = ctx.modalValue("resolution");
					const report = decoded.action === "resolvemodal"
						? await reports.resolve(first!, actor, resolution)
						: await reports.dismiss(first!, actor, resolution);
					await ctx.reply(`Report #${report.reportNumber} ${report.status}.`);
					return;
				}
				case "msgmodal": {
					await ctx.defer(true);
					const draft = await readDraft(store, ctx.userId, first!);
					const report = await reports.submit({
						guildId: ctx.guildId,
						reporterId: ctx.userId,
						type: "message",
						messageId: BigInt(first!),
						channelId: BigInt(second!),
						targetUserId: draft?.authorId ? BigInt(draft.authorId) : undefined,
						messageContent: draft?.content || undefined,
						reason: ctx.modalValue("reason"),
						evidence: ctx.modalValue("evidence") || undefined,
					});
					await store.del(draftKey(ctx.userId, first!));
					await ctx.reply(submitted(report));
					return;
				}
				case "usermodal": {
					await ctx.defer(true);
					const report = await reports.submit({
						guildId: ctx.guildId,
						reporterId: ctx.userId,
						type: "user",
						targetUserId: BigInt(first!),
						reason: ctx.modalValue("reason"),
						evidence: ctx.modalValue("evidence") || undefined,
					});
					await ctx.reply(submitted(report));
					return;
				}
				default:
					throw new ValidationFailed("That button is no longer valid.");
			}
		},
	};

	return [
		{
			name: "report",
			definition: slash("report", "Report a user or a problem to the staff team", [
				sub("user", "Report a member", [
					user("user", "Member to report", { required: true }),
					reasonOption,
					evidenceOption,
				]),
				sub("general", "Report something else", [reasonOption, evidenceOption]),
				sub("mine", "Show the reports you have filed"),
			]),
			handle: async (ctx) => {
				await ctx.defer(true);
				switch (requireSubcommand(ctx)) {
					case "user": {
						const target = ctx.userOption("user");
						if (!target) throw new ValidationFailed("Pick a member to report.");
						const report = await reports.submit({
							guildId: ctx.guildId,
							reporterId: ctx.userId,
							type: "user",
							targetUserId: target.id,
							reason: ctx.requireString("reason"),
							evidence: ctx.string("evidence"),
						});
						await ctx.reply(submitted(report));
						return;
					}
					case "general": {
						const report = await reports.submit({
							guildId: ctx.guildId,
							reporterId: ctx.userId,
							type: "general",
							reason: ctx.requireString("reason"),
							evidence: ctx.string("evidence"),
						});
						await ctx.reply(submitted(report));
						return;
					}
					case "mine": {
						const mine = await reports.mine(ctx.guildId, ctx.userId);
						await ctx.reply({
							embeds: [{
								title: "Your reports",
								color: LOG_COLORS.info,
								description: mine.length
									? mine.map(reportLine).join("\n")
									: "You have not filed any reports here.",
							}],
						});
						return;
					}
				}
			},
			components: [components],
		},

		{
			name: "Report Message",
			definition: contextMenu("Report Message", CmdType.Message),
			handle: async (ctx) => {
				const targetId = ctx.targetUserId;
				if (!targetId) throw new ValidationFailed("Pick a message to report.");
				const message = ctx.interaction.data?.resolved?.messages?.get(targetId);
				if (message) {
					await store.set(
						draftKey(ctx.userId, String(targetId)),
						JSON.stringify({
							content: truncate(message.content ?? "", 2000),
							authorId: String(message.author?.id ?? ""),
						}),
						DRAFT_TTL_MS,
					);
				}
				const channelId = message?.channelId ?? ctx.channelId;
				if (!channelId) throw new ValidationFailed("Report that message from its own channel.");
				await ctx.showModal(
					modal("Report message", encodeCustomId("report", "msgmodal", targetId, channelId)),
				);
			},
		},

		{
			name: "Report User",
			definition: contextMenu("Report User", CmdType.User),
			handle: async (ctx) => {
				const targetId = ctx.targetUserId;
				if (!targetId) throw new ValidationFailed("Pick a member to report.");
				await ctx.showModal(
					modal("Report user", encodeCustomId("report", "usermodal", targetId)),
				);
			},
		},

		{
			name: "reports",
			definition: slash("reports", "Work through the report queue", [
				sub("list", "Show open reports"),
				sub("view", "Show one report", [numberOption]),
				sub("claim", "Take ownership of a report", [numberOption]),
				sub("resolve", "Close a report as handled", [
					numberOption,
					str("resolution", "What you did", { required: true, maxLength: 1000 }),
				]),
				sub("dismiss", "Close a report with no action", [
					numberOption,
					str("resolution", "Why it was dismissed", { required: true, maxLength: 1000 }),
				]),
				sub("link", "Attach a moderation case to a report", [
					numberOption,
					int("case", "Case number", { required: true, minValue: 1 }),
				]),
			], { defaultMemberPermissions: ["MODERATE_MEMBERS"] }),
			handle: async (ctx) => {
				await ctx.defer(true);
				const actor = await actorOf(api, ctx);
				const action = requireSubcommand(ctx);
				if (action === "list" || action === "view") {
					await permissions.require(actor.actor, "reports.view");
				}
				switch (action) {
					case "list": {
						const open = await reports.listOpen(ctx.guildId);
						await ctx.reply({
							embeds: [{
								title: "Open reports",
								color: LOG_COLORS.warning,
								description: open.length
									? open.map(reportLine).join("\n")
									: "Nothing waiting. Good.",
							}],
						});
						return;
					}
					case "view": {
						const report = await reports.get(ctx.guildId, ctx.integer("number")!);
						await ctx.reply({ embeds: [reportEmbed(report)] });
						return;
					}
					case "claim": {
						const report = await reports.get(ctx.guildId, ctx.integer("number")!);
						const claimed = await reports.claim(report.id, actor);
						await ctx.reply(`Report #${claimed.reportNumber} is yours.`);
						return;
					}
					case "resolve": {
						const report = await reports.get(ctx.guildId, ctx.integer("number")!);
						const resolved = await reports.resolve(
							report.id,
							actor,
							ctx.requireString("resolution"),
						);
						await ctx.reply(`Report #${resolved.reportNumber} resolved.`);
						return;
					}
					case "dismiss": {
						const report = await reports.get(ctx.guildId, ctx.integer("number")!);
						const dismissed = await reports.dismiss(
							report.id,
							actor,
							ctx.requireString("resolution"),
						);
						await ctx.reply(`Report #${dismissed.reportNumber} dismissed.`);
						return;
					}
					case "link": {
						const report = await reports.get(ctx.guildId, ctx.integer("number")!);
						const linked = await reports.linkCase(report.id, actor, ctx.integer("case")!);
						await ctx.reply(
							`Report #${linked.reportNumber} is linked to case #${ctx.integer("case")}.`,
						);
						return;
					}
				}
			},
		},
	];
}
