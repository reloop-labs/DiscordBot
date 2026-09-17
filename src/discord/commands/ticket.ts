import { MessageComponentTypes, TextStyles } from "@discordeno/bot";
import type { DiscordApi } from "../adapters/discord-api.ts";
import { LOG_COLORS } from "../logging/discord-log.ts";
import type { InteractionContext } from "../interactions/context.ts";
import { decodeCustomId, encodeCustomId } from "../interactions/custom-id.ts";
import type { ComponentModule } from "../interactions/router.ts";
import {
	actionRow,
	type PanelStyle,
	type Ticket,
	type TicketCategory,
	type TicketService,
} from "../../domains/tickets/ticket-service.ts";
import type { TranscriptService } from "../../domains/tickets/transcript-service.ts";
import type { PermissionService } from "../../permissions/service.ts";
import { NotFound, ValidationFailed } from "../../shared/errors.ts";
import { discordTimestamp } from "../../shared/duration.ts";
import {
	channelMention,
	escapeMarkdown,
	roleMention,
	truncate,
	userMention,
} from "../../shared/text.ts";
import type { CommandDefinition } from "./registry.ts";
import {
	actorOf,
	bool,
	channel,
	group,
	requireSubcommand,
	role,
	slash,
	str,
	sub,
	user,
} from "./helpers.ts";

export interface TicketDeps {
	api: DiscordApi;
	tickets: TicketService;
	transcripts: TranscriptService;
	permissions: PermissionService;
}

const NOT_A_TICKET = "Run this inside a ticket channel.";

const categoryOption = str("category", "Ticket category", { required: true, autocomplete: true });

function transcriptFile(ticketNumber: number, html: string) {
	return {
		blob: new Blob([html], { type: "text/html" }),
		name: `ticket-${ticketNumber}.html`,
	};
}

function categoryLine(category: TicketCategory): string {
	const roles = category.staffRoleIds.map(roleMention).join(" ") || "*no staff roles*";
	return `${category.emoji ? `${category.emoji} ` : ""}**${escapeMarkdown(category.name)}**${
		category.enabled ? "" : " *(disabled)*"
	}\n${roles}${category.description ? `\n${truncate(category.description, 100)}` : ""}`;
}

function ticketEmbed(
	ticket: Ticket,
	category: TicketCategory | null,
	participants: { userId: bigint }[],
) {
	return {
		title: `Ticket #${ticket.ticketNumber}`,
		color: ticket.status === "open" ? LOG_COLORS.info : LOG_COLORS.neutral,
		fields: [
			{ name: "Status", value: ticket.status, inline: true },
			{
				name: "Category",
				value: category ? escapeMarkdown(category.name) : "*none*",
				inline: true,
			},
			{
				name: "Claimed by",
				value: ticket.claimedBy ? userMention(ticket.claimedBy) : "*unclaimed*",
				inline: true,
			},
			{ name: "Opened by", value: userMention(ticket.openerUserId), inline: true },
			{ name: "Opened", value: discordTimestamp(ticket.createdAt, "R"), inline: true },
			{ name: "Last activity", value: discordTimestamp(ticket.lastActivityAt, "R"), inline: true },
			{
				name: "Participants",
				value: participants.map((p) => userMention(p.userId)).join(" ") || "*none*",
			},
			...(ticket.closeReason
				? [{ name: "Close reason", value: escapeMarkdown(ticket.closeReason) }]
				: []),
		],
	};
}

export function ticketCommands(deps: TicketDeps): CommandDefinition[] {
	const { api, tickets, transcripts, permissions } = deps;

	const ticketOf = async (ctx: InteractionContext): Promise<Ticket> => {
		if (!ctx.channelId) throw new ValidationFailed(NOT_A_TICKET);
		const ticket = await tickets.byChannel(ctx.channelId);
		if (!ticket) throw new ValidationFailed(NOT_A_TICKET);
		return ticket;
	};

	const sendTranscript = async (ctx: InteractionContext, ticket: Ticket): Promise<void> => {
		const actor = await actorOf(api, ctx);
		await tickets.assertCanView(ticket, actor);
		const generated = await transcripts.generate(
			ticket,
			await tickets.listEvents(ticket.id),
			await permissions.has(actor.actor, "tickets.manage"),
		);
		await ctx.reply({
			content:
				`Transcript for ticket #${ticket.ticketNumber} · ${generated.messageCount} messages.`,
			files: [transcriptFile(ticket.ticketNumber, generated.html)],
		});
	};

	const openAndTell = async (ctx: InteractionContext, categoryId: string): Promise<void> => {
		const ticket = await tickets.open(ctx.guildId, ctx.userId, categoryId);
		await ctx.reply(`Your ticket: ${channelMention(ticket.channelId)}`);
	};

	const categoryChoices = async (ctx: InteractionContext, focused: string) => {
		const all = await tickets.listCategories(ctx.guildId);
		const needle = focused.toLowerCase();
		return all
			.filter((category) => category.name.toLowerCase().includes(needle))
			.slice(0, 25)
			.map((category) => ({ name: truncate(category.name, 100), value: category.id }));
	};

	const components: ComponentModule[] = [{
		domain: "ticket",
		handle: async (ctx) => {
			const decoded = decodeCustomId(ctx.customId);
			if (!decoded) return;
			const argument = decoded.args[0];
			if (decoded.action === "close") {
				await ctx.showModal({
					title: "Close ticket",
					customId: encodeCustomId("ticket", "closemodal", argument ?? ""),
					components: [actionRow([{
						type: MessageComponentTypes.InputText,
						style: TextStyles.Paragraph,
						customId: "reason",
						label: "Reason",
						placeholder: "Optional",
						required: false,
						maxLength: 512,
					}])],
				});
				return;
			}
			await ctx.defer(true);
			switch (decoded.action) {
				case "open": {
					if (!argument) throw new ValidationFailed("Pick a category.");
					await openAndTell(ctx, argument);
					return;
				}
				case "openselect": {
					const selected = ctx.selectedValues[0];
					if (!selected) throw new ValidationFailed("Pick a category.");
					await openAndTell(ctx, selected);
					return;
				}
				case "claim": {
					if (!argument) throw new NotFound("This ticket");
					const ticket = await tickets.claim(argument, await actorOf(api, ctx));
					await ctx.reply(`Ticket #${ticket.ticketNumber} is yours.`);
					return;
				}
				case "closemodal": {
					if (!argument) throw new NotFound("This ticket");
					const ticket = await tickets.close(
						argument,
						await actorOf(api, ctx),
						ctx.modalValue("reason") || null,
					);
					await ctx.reply(`Ticket #${ticket.ticketNumber} closed.`).catch(() => {});
					return;
				}
				case "transcript": {
					if (!argument) throw new NotFound("This ticket");
					await sendTranscript(ctx, await tickets.get(argument));
					return;
				}
			}
		},
	}];

	return [
		{
			name: "ticket",
			definition: slash("ticket", "Work with the ticket you are in", [
				sub("close", "Close this ticket", [str("reason", "Why it is being closed", {
					maxLength: 512,
				})]),
				sub("claim", "Claim this ticket"),
				sub("unclaim", "Release this ticket"),
				sub("add", "Add someone to this ticket", [user("user", "Member to add", {
					required: true,
				})]),
				sub("remove", "Remove someone from this ticket", [user("user", "Member to remove", {
					required: true,
				})]),
				sub("transfer", "Move this ticket to another category", [categoryOption]),
				sub("note", "Add a staff-only note", [str("content", "Note content", {
					required: true,
					maxLength: 1000,
				})]),
				sub("notes", "Show the staff-only notes"),
				sub("transcript", "Generate a transcript of this ticket"),
				sub("info", "Show this ticket's details"),
				sub("reopen", "Reopen this ticket"),
			]),
			autocomplete: async (ctx) => {
				const focused = ctx.string("category") ?? "";
				await ctx.interaction.respond({ choices: await categoryChoices(ctx, focused) });
			},
			components,
			handle: async (ctx) => {
				await ctx.defer(true);
				const ticket = await ticketOf(ctx);
				const command = requireSubcommand(ctx);
				switch (command) {
					case "close": {
						const closed = await tickets.close(
							ticket.id,
							await actorOf(api, ctx),
							ctx.string("reason") ?? null,
						);
						await ctx.reply(`Ticket #${closed.ticketNumber} closed.`).catch(() => {});
						return;
					}
					case "claim": {
						await tickets.claim(ticket.id, await actorOf(api, ctx));
						await ctx.reply("Claimed.");
						return;
					}
					case "unclaim": {
						await tickets.unclaim(ticket.id, await actorOf(api, ctx));
						await ctx.reply("Released.");
						return;
					}
					case "add": {
						const target = ctx.userOption("user");
						if (!target) throw new ValidationFailed("Pick a member.");
						await tickets.addParticipant(ticket.id, await actorOf(api, ctx), target.id);
						await ctx.reply(`Added ${userMention(target.id)}.`);
						return;
					}
					case "remove": {
						const target = ctx.userOption("user");
						if (!target) throw new ValidationFailed("Pick a member.");
						await tickets.removeParticipant(ticket.id, await actorOf(api, ctx), target.id);
						await ctx.reply(`Removed ${userMention(target.id)}.`);
						return;
					}
					case "transfer": {
						const moved = await tickets.transfer(
							ticket.id,
							await actorOf(api, ctx),
							ctx.requireString("category"),
						);
						const category = moved.categoryId
							? await tickets.category(ctx.guildId, moved.categoryId)
							: null;
						await ctx.reply(`Transferred to **${escapeMarkdown(category?.name ?? "unknown")}**.`);
						return;
					}
					case "note": {
						await tickets.addNote(
							ticket.id,
							await actorOf(api, ctx),
							ctx.requireString("content"),
						);
						await ctx.reply("Note saved. Only staff can see it.");
						return;
					}
					case "notes": {
						await permissions.require((await actorOf(api, ctx)).actor, "tickets.manage");
						const notes = await tickets.listNotes(ticket.id);
						await ctx.reply({
							embeds: [{
								title: `Ticket #${ticket.ticketNumber} · staff notes`,
								color: LOG_COLORS.neutral,
								description: notes.length
									? truncate(
										notes.map((note) =>
											`${userMention(note.authorId)} ${discordTimestamp(note.createdAt, "R")}\n${
												escapeMarkdown(note.content)
											}`
										).join("\n\n"),
										3800,
									)
									: "No notes yet.",
							}],
						});
						return;
					}
					case "transcript": {
						await sendTranscript(ctx, ticket);
						return;
					}
					case "info": {
						await tickets.assertCanView(ticket, await actorOf(api, ctx));
						const detail = await tickets.detail(ticket);
						await ctx.reply({
							embeds: [ticketEmbed(detail.ticket, detail.category, detail.participants)],
						});
						return;
					}
					case "reopen": {
						const reopened = await tickets.reopen(ticket.id, await actorOf(api, ctx));
						await ctx.reply(`Ticket #${reopened.ticketNumber} reopened.`);
						return;
					}
				}
			},
		},

		{
			name: "ticket-admin",
			definition: slash("ticket-admin", "Set up tickets for this server", [
				group("category", "Manage ticket categories", [
					sub("create", "Create a ticket category", [
						str("name", "Category name", { required: true, maxLength: 60 }),
						role("staff_role", "Role that handles these tickets", { required: true }),
						role("staff_role_2", "Another staff role"),
						role("staff_role_3", "Another staff role"),
						str("description", "Shown on the panel", { maxLength: 100 }),
						str("emoji", "Emoji shown on the panel button", { maxLength: 8 }),
						channel("parent", "Category channel new tickets are created under"),
						str("opening_message", "Message posted when a ticket opens", { maxLength: 1000 }),
					]),
					sub("edit", "Change a ticket category", [
						categoryOption,
						str("name", "New name", { maxLength: 60 }),
						role("staff_role", "Replace the staff roles with this role"),
						role("staff_role_2", "Another staff role"),
						role("staff_role_3", "Another staff role"),
						str("description", "Shown on the panel", { maxLength: 100 }),
						str("emoji", "Emoji shown on the panel button", { maxLength: 8 }),
						channel("parent", "Category channel new tickets are created under"),
						str("opening_message", "Message posted when a ticket opens", { maxLength: 1000 }),
						bool("enabled", "Whether members can open this category"),
					]),
					sub("delete", "Delete a ticket category", [categoryOption]),
					sub("list", "List every ticket category"),
				]),
				group("panel", "Manage ticket panels", [
					sub("create", "Post a ticket panel", [
						channel("channel", "Where the panel is posted", { required: true }),
						str("title", "Panel title", { required: true, maxLength: 100 }),
						str("categories", "Category names, comma separated", { required: true }),
						str("body", "Panel body text", { maxLength: 1000 }),
						str("style", "How members pick a category", {
							choices: [
								{ name: "buttons", value: "buttons" },
								{ name: "select", value: "select" },
							],
						}),
					]),
					sub("refresh", "Repost or update a panel", [
						str("panel", "Panel to refresh", { required: true, autocomplete: true }),
					]),
				]),
				sub("open-for", "Open a ticket on behalf of a member", [
					user("user", "Member the ticket is for", { required: true }),
					categoryOption,
				]),
				sub("stale", "List tickets with no recent activity"),
			], { defaultMemberPermissions: ["MANAGE_GUILD"] }),
			autocomplete: async (ctx) => {
				if (ctx.subcommandPath.includes("panel")) {
					const panels = await tickets.listPanels(ctx.guildId);
					await ctx.interaction.respond({
						choices: panels.slice(0, 25).map((panel) => ({
							name: truncate(`${panel.title} · #${panel.channelId}`, 100),
							value: panel.id,
						})),
					});
					return;
				}
				await ctx.interaction.respond({
					choices: await categoryChoices(ctx, ctx.string("category") ?? ""),
				});
			},
			handle: async (ctx) => {
				await ctx.defer(true);
				const actor = await actorOf(api, ctx);
				await permissions.require(actor.actor, "tickets.admin");
				const path = ctx.subcommandPath;
				const command = requireSubcommand(ctx);
				const staffRoleIds = [
					ctx.roleOption("staff_role"),
					ctx.roleOption("staff_role_2"),
					ctx.roleOption("staff_role_3"),
				].filter((id): id is bigint => id !== undefined);

				if (path[0] === "category") {
					switch (command) {
						case "create": {
							const category = await tickets.createCategory(ctx.guildId, {
								name: ctx.requireString("name"),
								description: ctx.string("description") ?? null,
								emoji: ctx.string("emoji") ?? null,
								parentChannelId: ctx.channelOption("parent") ?? null,
								staffRoleIds,
								openingMessage: ctx.string("opening_message") ?? null,
							}, ctx.userId);
							await ctx.reply(`Created **${escapeMarkdown(category.name)}**.`);
							return;
						}
						case "edit": {
							const enabled = ctx.boolean("enabled");
							await tickets.updateCategory(ctx.guildId, ctx.requireString("category"), {
								...(ctx.string("name") !== undefined ? { name: ctx.requireString("name") } : {}),
								...(ctx.string("description") !== undefined
									? { description: ctx.string("description") }
									: {}),
								...(ctx.string("emoji") !== undefined ? { emoji: ctx.string("emoji") } : {}),
								...(ctx.channelOption("parent") !== undefined
									? { parentChannelId: ctx.channelOption("parent") }
									: {}),
								...(ctx.string("opening_message") !== undefined
									? { openingMessage: ctx.string("opening_message") }
									: {}),
								...(staffRoleIds.length ? { staffRoleIds } : {}),
								...(enabled !== undefined ? { enabled } : {}),
							}, ctx.userId);
							await ctx.reply("Category updated.");
							return;
						}
						case "delete": {
							const result = await tickets.deleteCategory(
								ctx.guildId,
								ctx.requireString("category"),
								ctx.userId,
							);
							await ctx.reply(
								result.disabled
									? "Existing tickets use that category, so it was disabled instead of deleted."
									: "Category deleted.",
							);
							return;
						}
						case "list": {
							const categories = await tickets.listCategories(ctx.guildId);
							await ctx.reply({
								embeds: [{
									title: "Ticket categories",
									color: LOG_COLORS.neutral,
									description: categories.length
										? truncate(categories.map(categoryLine).join("\n\n"), 3800)
										: "No categories yet. Create one with `/ticket-admin category create`.",
								}],
							});
							return;
						}
					}
				}

				if (path[0] === "panel") {
					if (command === "create") {
						const names = ctx.requireString("categories").split(",").map((name) => name.trim())
							.filter(Boolean);
						if (!names.length) throw new ValidationFailed("Name at least one category.");
						const resolved: TicketCategory[] = [];
						for (const name of names) {
							resolved.push(await tickets.categoryByName(ctx.guildId, name));
						}
						const panel = await tickets.createPanel(ctx.guildId, {
							channelId: ctx.channelOption("channel")!,
							title: ctx.requireString("title"),
							body: ctx.string("body") ?? null,
							style: (ctx.string("style") ?? "buttons") as PanelStyle,
							categoryIds: resolved.map((category) => category.id),
						}, ctx.userId);
						await ctx.reply(`Panel posted in ${channelMention(panel.channelId)}.`);
						return;
					}
					await tickets.refreshPanel(ctx.requireString("panel"), ctx.guildId);
					await ctx.reply("Panel refreshed.");
					return;
				}

				if (command === "open-for") {
					const target = ctx.userOption("user");
					if (!target) throw new ValidationFailed("Pick a member.");
					const ticket = await tickets.open(
						ctx.guildId,
						target.id,
						ctx.requireString("category"),
					);
					await ctx.reply(
						`Opened ticket #${ticket.ticketNumber} for ${userMention(target.id)}: ${
							channelMention(ticket.channelId)
						}`,
					);
					return;
				}

				const hours = await tickets.staleHours(ctx.guildId);
				const stale = await tickets.staleTickets(ctx.guildId, hours);
				await ctx.reply({
					embeds: [{
						title: `Tickets quiet for over ${hours}h`,
						color: LOG_COLORS.warning,
						description: stale.length
							? truncate(
								stale.map((ticket) =>
									`**#${ticket.ticketNumber}** ${channelMention(ticket.channelId)} · ${
										discordTimestamp(ticket.lastActivityAt, "R")
									}`
								).join("\n"),
								3800,
							)
							: "Nothing is going stale.",
					}],
				});
			},
		},
	];
}
