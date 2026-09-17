import { and, asc, count, desc, eq, inArray, lt } from "drizzle-orm";
import { ButtonStyles, MessageComponentTypes } from "@discordeno/bot";
import type { ActionRow, MessageComponent } from "@discordeno/bot";
import type { Database } from "../../database/client.ts";
import { nextSequence } from "../../database/sequences.ts";
import {
	ticketCategories,
	ticketEvents,
	ticketNotes,
	ticketPanels,
	ticketParticipants,
	tickets,
} from "../../database/schema/index.ts";
import type {
	DiscordApi,
	OutboundMessage,
	PermissionOverwrite,
} from "../../discord/adapters/discord-api.ts";
import { DiscordLogService, LOG_COLORS } from "../../discord/logging/discord-log.ts";
import { encodeCustomId } from "../../discord/interactions/custom-id.ts";
import type { Logger } from "../../logging/logger.ts";
import type { ActorContext } from "../../permissions/actor.ts";
import type { PermissionService } from "../../permissions/service.ts";
import type { KeyValueStore } from "../../redis/client.ts";
import {
	NotFound,
	TicketAlreadyOpen,
	TicketNotFound,
	ValidationFailed,
} from "../../shared/errors.ts";
import { discordTimestamp } from "../../shared/duration.ts";
import {
	channelMention,
	escapeMarkdown,
	roleMention,
	truncate,
	userMention,
} from "../../shared/text.ts";
import type { AuditService } from "../audit/service.ts";
import type { GuildConfigService } from "../guild-config/service.ts";
import type { Ticket, TicketEvent } from "./transcript-service.ts";
import { TranscriptService } from "./transcript-service.ts";

export type { Ticket, TicketEvent };
export type TicketCategory = typeof ticketCategories.$inferSelect;
export type TicketPanel = typeof ticketPanels.$inferSelect;
export type TicketNote = typeof ticketNotes.$inferSelect;
export type PanelStyle = TicketPanel["style"];

export const VIEW_CHANNEL = 1n << 10n;
export const SEND_MESSAGES = 1n << 11n;
export const READ_MESSAGE_HISTORY = 1n << 16n;
export const ATTACH_FILES = 1n << 15n;
export const EMBED_LINKS = 1n << 14n;
export const MANAGE_CHANNELS = 1n << 4n;
export const MANAGE_MESSAGES = 1n << 13n;

const PARTICIPANT_ALLOW = VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY | ATTACH_FILES |
	EMBED_LINKS;
const STAFF_ALLOW = PARTICIPANT_ALLOW | MANAGE_MESSAGES;
const BOT_ALLOW = PARTICIPANT_ALLOW | MANAGE_CHANNELS | MANAGE_MESSAGES;

export const MAX_CATEGORIES = 25;
export const MAX_OPEN_PER_USER = 3;
const OPEN_LOCK_MS = 10_000;

export interface CategoryInput {
	name: string;
	description?: string | null;
	emoji?: string | null;
	parentChannelId?: bigint | null;
	staffRoleIds: bigint[];
	openingMessage?: string | null;
}

export interface PanelInput {
	channelId: bigint;
	title: string;
	body?: string | null;
	style: PanelStyle;
	categoryIds: string[];
}

export interface TicketDetail {
	ticket: Ticket;
	category: TicketCategory | null;
	participants: { userId: bigint; addedBy: bigint; addedAt: Date }[];
}

export interface TicketServiceDeps {
	api: DiscordApi;
	db: Database;
	store: KeyValueStore;
	config: GuildConfigService;
	permissions: PermissionService;
	audit: AuditService;
	discordLog: DiscordLogService;
	transcripts: TranscriptService;
	logger: Logger;
}

function isUniqueViolation(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
		if ((current as { code?: unknown }).code === "23505") return true;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

function sanitizeChannelName(username: string): string {
	const cleaned = username.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-+|-+$/g, "");
	return cleaned.slice(0, 60) || "member";
}

export function actionRow(components: Exclude<MessageComponent, ActionRow>[]): ActionRow {
	return {
		type: MessageComponentTypes.ActionRow,
		components: components as ActionRow["components"],
	};
}

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		out.push(items.slice(index, index + size));
	}
	return out;
}

function requireName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) throw new ValidationFailed("Give the category a name.");
	if (trimmed.length > 60) {
		throw new ValidationFailed("Category names must be 60 characters or fewer.");
	}
	return trimmed;
}

export class TicketService {
	#deps: TicketServiceDeps;

	constructor(deps: TicketServiceDeps) {
		this.#deps = deps;
	}

	listCategories(guildId: bigint): Promise<TicketCategory[]> {
		return this.#deps.db
			.select()
			.from(ticketCategories)
			.where(eq(ticketCategories.guildId, guildId))
			.orderBy(asc(ticketCategories.position), asc(ticketCategories.name));
	}

	async category(guildId: bigint, categoryId: string): Promise<TicketCategory> {
		const [found] = await this.#deps.db
			.select()
			.from(ticketCategories)
			.where(and(eq(ticketCategories.id, categoryId), eq(ticketCategories.guildId, guildId)));
		if (!found) throw new NotFound("That ticket category");
		return found;
	}

	async categoryByName(guildId: bigint, name: string): Promise<TicketCategory> {
		const wanted = name.trim().toLowerCase();
		const found = (await this.listCategories(guildId)).find((c) => c.name.toLowerCase() === wanted);
		if (!found) throw new NotFound(`Ticket category "${truncate(name, 40)}"`);
		return found;
	}

	async createCategory(
		guildId: bigint,
		input: CategoryInput,
		actorId: bigint,
	): Promise<TicketCategory> {
		const name = requireName(input.name);
		const existing = await this.listCategories(guildId);
		if (existing.length >= MAX_CATEGORIES) {
			throw new ValidationFailed(`A server can have at most ${MAX_CATEGORIES} ticket categories.`);
		}
		if (!input.staffRoleIds.length) {
			throw new ValidationFailed("Pick at least one staff role for this category.");
		}
		let created: TicketCategory;
		try {
			const [inserted] = await this.#deps.db
				.insert(ticketCategories)
				.values({
					guildId,
					name,
					description: input.description ?? null,
					emoji: input.emoji ?? null,
					parentChannelId: input.parentChannelId ?? null,
					staffRoleIds: input.staffRoleIds,
					openingMessage: input.openingMessage ?? null,
					position: existing.length,
				})
				.returning();
			created = inserted!;
		} catch (error) {
			if (isUniqueViolation(error)) {
				throw new ValidationFailed("A ticket category with that name already exists.");
			}
			throw error;
		}
		await this.#deps.audit.record({
			guildId,
			actorId,
			action: "tickets.category.create",
			target: created.id,
			data: { name },
		});
		return created;
	}

	async updateCategory(
		guildId: bigint,
		categoryId: string,
		patch: Partial<CategoryInput> & { enabled?: boolean },
		actorId: bigint,
	): Promise<TicketCategory> {
		await this.category(guildId, categoryId);
		const changes: Record<string, unknown> = {};
		if (patch.name !== undefined) changes.name = requireName(patch.name);
		if (patch.description !== undefined) changes.description = patch.description;
		if (patch.emoji !== undefined) changes.emoji = patch.emoji;
		if (patch.parentChannelId !== undefined) changes.parentChannelId = patch.parentChannelId;
		if (patch.openingMessage !== undefined) changes.openingMessage = patch.openingMessage;
		if (patch.enabled !== undefined) changes.enabled = patch.enabled;
		if (patch.staffRoleIds !== undefined) {
			if (!patch.staffRoleIds.length) {
				throw new ValidationFailed("Pick at least one staff role for this category.");
			}
			changes.staffRoleIds = patch.staffRoleIds;
		}
		if (!Object.keys(changes).length) throw new ValidationFailed("Change at least one setting.");
		let updated: TicketCategory;
		try {
			const [row] = await this.#deps.db
				.update(ticketCategories)
				.set(changes)
				.where(eq(ticketCategories.id, categoryId))
				.returning();
			updated = row!;
		} catch (error) {
			if (isUniqueViolation(error)) {
				throw new ValidationFailed("A ticket category with that name already exists.");
			}
			throw error;
		}
		await this.#deps.audit.record({
			guildId,
			actorId,
			action: "tickets.category.update",
			target: categoryId,
			data: { changes: Object.keys(changes) },
		});
		return updated;
	}

	async deleteCategory(
		guildId: bigint,
		categoryId: string,
		actorId: bigint,
	): Promise<{ disabled: boolean }> {
		await this.category(guildId, categoryId);
		const [used] = await this.#deps.db
			.select({ total: count() })
			.from(tickets)
			.where(eq(tickets.categoryId, categoryId));
		const disabled = (used?.total ?? 0) > 0;
		if (disabled) {
			await this.#deps.db
				.update(ticketCategories)
				.set({ enabled: false })
				.where(eq(ticketCategories.id, categoryId));
		} else {
			await this.#deps.db.delete(ticketCategories).where(eq(ticketCategories.id, categoryId));
		}
		await this.#deps.audit.record({
			guildId,
			actorId,
			action: "tickets.category.delete",
			target: categoryId,
			data: { disabled },
		});
		return { disabled };
	}

	async createPanel(guildId: bigint, input: PanelInput, actorId: bigint): Promise<TicketPanel> {
		if (!input.categoryIds.length) throw new ValidationFailed("Pick at least one category.");
		if (input.categoryIds.length > MAX_CATEGORIES) {
			throw new ValidationFailed(`A panel can offer at most ${MAX_CATEGORIES} categories.`);
		}
		const [panel] = await this.#deps.db
			.insert(ticketPanels)
			.values({
				guildId,
				channelId: input.channelId,
				title: input.title.trim() || "Open a ticket",
				body: input.body ?? null,
				style: input.style,
				categoryIds: input.categoryIds,
			})
			.returning();
		const stored = panel!;
		const categories = await this.#panelCategories(stored);
		const sent = await this.#deps.api.sendMessage(
			stored.channelId,
			this.#panelMessage(stored, categories),
		);
		const [withMessage] = await this.#deps.db
			.update(ticketPanels)
			.set({ messageId: sent?.id ?? null })
			.where(eq(ticketPanels.id, stored.id))
			.returning();
		await this.#deps.audit.record({
			guildId,
			actorId,
			action: "tickets.panel.create",
			target: stored.id,
			data: { channelId: input.channelId, style: input.style },
		});
		return withMessage!;
	}

	async refreshPanel(panelId: string, guildId?: bigint): Promise<TicketPanel> {
		const [panel] = await this.#deps.db
			.select()
			.from(ticketPanels)
			.where(eq(ticketPanels.id, panelId));
		if (!panel || (guildId !== undefined && panel.guildId !== guildId)) {
			throw new NotFound("That ticket panel");
		}
		const message = this.#panelMessage(panel, await this.#panelCategories(panel));
		if (!panel.messageId) {
			const sent = await this.#deps.api.sendMessage(panel.channelId, message);
			const [republished] = await this.#deps.db
				.update(ticketPanels)
				.set({ messageId: sent?.id ?? null })
				.where(eq(ticketPanels.id, panel.id))
				.returning();
			return republished!;
		}
		await this.#deps.api.editMessage(panel.channelId, panel.messageId, message);
		return panel;
	}

	listPanels(guildId: bigint): Promise<TicketPanel[]> {
		return this.#deps.db
			.select()
			.from(ticketPanels)
			.where(eq(ticketPanels.guildId, guildId))
			.orderBy(desc(ticketPanels.createdAt));
	}

	async open(guildId: bigint, openerId: bigint, categoryId: string): Promise<Ticket> {
		const lockKey = `ticket:open:${guildId}:${openerId}`;
		if (!(await this.#deps.store.acquireLock(lockKey, OPEN_LOCK_MS))) {
			throw new ValidationFailed("You already have a ticket being created.");
		}
		try {
			return await this.#open(guildId, openerId, categoryId);
		} finally {
			await this.#deps.store.releaseLock(lockKey);
		}
	}

	async #open(guildId: bigint, openerId: bigint, categoryId: string): Promise<Ticket> {
		const category = await this.category(guildId, categoryId);
		if (!category.enabled) throw new ValidationFailed("That ticket category is closed.");
		const member = await this.#deps.api.getMember(guildId, openerId);
		const username = member?.username ?? String(openerId);
		const created: { channelId: bigint | null } = { channelId: null };

		let ticket: Ticket;
		try {
			ticket = await this.#deps.db.transaction(async (tx) => {
				const [duplicate] = await tx
					.select()
					.from(tickets)
					.where(
						and(
							eq(tickets.guildId, guildId),
							eq(tickets.openerUserId, openerId),
							eq(tickets.categoryId, categoryId),
							eq(tickets.status, "open"),
						),
					);
				if (duplicate) throw new TicketAlreadyOpen(duplicate.channelId);
				const [open] = await tx
					.select({ total: count() })
					.from(tickets)
					.where(
						and(
							eq(tickets.guildId, guildId),
							eq(tickets.openerUserId, openerId),
							eq(tickets.status, "open"),
						),
					);
				if ((open?.total ?? 0) >= MAX_OPEN_PER_USER) {
					throw new ValidationFailed(
						`You already have ${MAX_OPEN_PER_USER} open tickets. Close one before opening another.`,
					);
				}
				const ticketNumber = await nextSequence(tx, guildId, "ticket");
				const channel = await this.#deps.api.createTextChannel(
					guildId,
					{
						name: `ticket-${ticketNumber}-${sanitizeChannelName(username)}`,
						...(category.parentChannelId ? { parentId: category.parentChannelId } : {}),
						topic:
							`Ticket #${ticketNumber} · ${category.name} · opened by ${username} (${openerId})`,
						overwrites: this.#overwrites(guildId, openerId, category.staffRoleIds),
					},
					`Ticket #${ticketNumber} opened by ${username}`,
				);
				created.channelId = channel.id;
				const [inserted] = await tx
					.insert(tickets)
					.values({
						guildId,
						ticketNumber,
						categoryId,
						openerUserId: openerId,
						channelId: channel.id,
					})
					.returning();
				const row = inserted!;
				await tx.insert(ticketParticipants).values({
					ticketId: row.id,
					userId: openerId,
					addedBy: openerId,
				});
				await tx.insert(ticketEvents).values({
					ticketId: row.id,
					type: "opened",
					actorId: openerId,
					data: { categoryId, categoryName: category.name },
				});
				return row;
			});
		} catch (error) {
			if (created.channelId !== null) {
				await this.#deps.api
					.deleteChannel(created.channelId, "Ticket creation failed")
					.catch(() => {});
			}
			if (isUniqueViolation(error)) {
				const [winner] = await this.#deps.db
					.select()
					.from(tickets)
					.where(
						and(
							eq(tickets.guildId, guildId),
							eq(tickets.openerUserId, openerId),
							eq(tickets.categoryId, categoryId),
							eq(tickets.status, "open"),
						),
					);
				throw new TicketAlreadyOpen(winner?.channelId ?? 0n);
			}
			throw error;
		}

		await this.#deps.api.sendMessage(ticket.channelId, {
			content: [userMention(openerId), ...category.staffRoleIds.map(roleMention)].join(" "),
			embeds: [{
				title: `Ticket #${ticket.ticketNumber} · ${category.name}`,
				color: LOG_COLORS.info,
				description: category.openingMessage ??
					"Thanks for reaching out. Describe your issue and a staff member will be with you shortly.",
				fields: [
					{ name: "Opened by", value: userMention(openerId), inline: true },
					{ name: "Opened", value: discordTimestamp(ticket.createdAt, "R"), inline: true },
				],
			}],
			components: [actionRow([
				{
					type: MessageComponentTypes.Button,
					style: ButtonStyles.Primary,
					label: "Claim",
					customId: encodeCustomId("ticket", "claim", ticket.id),
				},
				{
					type: MessageComponentTypes.Button,
					style: ButtonStyles.Danger,
					label: "Close",
					customId: encodeCustomId("ticket", "close", ticket.id),
				},
				{
					type: MessageComponentTypes.Button,
					style: ButtonStyles.Secondary,
					label: "Transcript",
					customId: encodeCustomId("ticket", "transcript", ticket.id),
				},
			])],
			allowedMentions: { users: [openerId], roles: category.staffRoleIds },
		});

		await this.#deps.discordLog.embed(guildId, "tickets", {
			title: `Ticket #${ticket.ticketNumber} opened`,
			color: LOG_COLORS.success,
			fields: [
				{ name: "Category", value: escapeMarkdown(category.name), inline: true },
				{ name: "Opened by", value: userMention(openerId), inline: true },
				{ name: "Channel", value: channelMention(ticket.channelId), inline: true },
			],
		});
		return ticket;
	}

	async get(ticketId: string): Promise<Ticket> {
		const [ticket] = await this.#deps.db.select().from(tickets).where(eq(tickets.id, ticketId));
		if (!ticket) throw new TicketNotFound();
		return ticket;
	}

	async byChannel(channelId: bigint): Promise<Ticket | null> {
		const [ticket] = await this.#deps.db
			.select()
			.from(tickets)
			.where(eq(tickets.channelId, channelId));
		return ticket ?? null;
	}

	listOpen(guildId: bigint): Promise<Ticket[]> {
		return this.#deps.db
			.select()
			.from(tickets)
			.where(and(eq(tickets.guildId, guildId), eq(tickets.status, "open")))
			.orderBy(asc(tickets.ticketNumber));
	}

	async staleHours(guildId: bigint): Promise<number> {
		return (await this.#deps.config.get(guildId)).ticketInactivityHours;
	}

	staleTickets(guildId: bigint, olderThanHours: number): Promise<Ticket[]> {
		const cutoff = new Date(Date.now() - olderThanHours * 3_600_000);
		return this.#deps.db
			.select()
			.from(tickets)
			.where(
				and(
					eq(tickets.guildId, guildId),
					eq(tickets.status, "open"),
					lt(tickets.lastActivityAt, cutoff),
				),
			)
			.orderBy(asc(tickets.lastActivityAt));
	}

	listEvents(ticketId: string): Promise<TicketEvent[]> {
		return this.#deps.db
			.select()
			.from(ticketEvents)
			.where(eq(ticketEvents.ticketId, ticketId))
			.orderBy(asc(ticketEvents.createdAt));
	}

	listNotes(ticketId: string): Promise<TicketNote[]> {
		return this.#deps.db
			.select()
			.from(ticketNotes)
			.where(eq(ticketNotes.ticketId, ticketId))
			.orderBy(asc(ticketNotes.createdAt));
	}

	listParticipants(ticketId: string) {
		return this.#deps.db
			.select()
			.from(ticketParticipants)
			.where(eq(ticketParticipants.ticketId, ticketId))
			.orderBy(asc(ticketParticipants.addedAt));
	}

	async detail(ticket: Ticket): Promise<TicketDetail> {
		const [category] = ticket.categoryId
			? await this.#deps.db
				.select()
				.from(ticketCategories)
				.where(eq(ticketCategories.id, ticket.categoryId))
			: [];
		return {
			ticket,
			category: category ?? null,
			participants: await this.listParticipants(ticket.id),
		};
	}

	async assertCanView(ticket: Ticket, actor: ActorContext): Promise<void> {
		if (ticket.guildId !== actor.actor.guildId) throw new TicketNotFound();
		if (ticket.openerUserId === actor.actor.userId) return;
		const [participant] = await this.#deps.db
			.select()
			.from(ticketParticipants)
			.where(
				and(
					eq(ticketParticipants.ticketId, ticket.id),
					eq(ticketParticipants.userId, actor.actor.userId),
				),
			);
		if (participant) return;
		await this.#deps.permissions.require(actor.actor, "tickets.view");
	}

	async claim(ticketId: string, actor: ActorContext): Promise<Ticket> {
		const ticket = await this.#requireOpen(ticketId);
		await this.#deps.permissions.require(actor.actor, "tickets.claim");
		const actorId = actor.actor.userId;
		if (ticket.claimedBy === actorId) {
			throw new ValidationFailed("You already claimed this ticket.");
		}
		if (ticket.claimedBy !== null) {
			await this.#deps.permissions.require(actor.actor, "tickets.manage");
		}
		const updated = await this.#update(ticket.id, { claimedBy: actorId });
		await this.#event(ticket.id, "claimed", actorId, {
			previous: ticket.claimedBy ? String(ticket.claimedBy) : null,
		});
		await this.#say(ticket, `${userMention(actorId)} claimed this ticket.`);
		return updated;
	}

	async unclaim(ticketId: string, actor: ActorContext): Promise<Ticket> {
		const ticket = await this.#requireOpen(ticketId);
		await this.#deps.permissions.require(actor.actor, "tickets.claim");
		if (ticket.claimedBy === null) throw new ValidationFailed("Nobody has claimed this ticket.");
		if (ticket.claimedBy !== actor.actor.userId) {
			await this.#deps.permissions.require(actor.actor, "tickets.manage");
		}
		const updated = await this.#update(ticket.id, { claimedBy: null });
		await this.#event(ticket.id, "unclaimed", actor.actor.userId, {});
		await this.#say(ticket, `${userMention(actor.actor.userId)} released this ticket.`);
		return updated;
	}

	async addParticipant(ticketId: string, actor: ActorContext, userId: bigint): Promise<void> {
		const ticket = await this.#requireOpen(ticketId);
		await this.#deps.permissions.require(actor.actor, "tickets.manage");
		const added = await this.#deps.db
			.insert(ticketParticipants)
			.values({ ticketId: ticket.id, userId, addedBy: actor.actor.userId })
			.onConflictDoNothing()
			.returning({ userId: ticketParticipants.userId });
		if (!added.length) throw new ValidationFailed("They are already in this ticket.");
		await this.#deps.api.setChannelPermission(
			ticket.channelId,
			{ id: userId, kind: "member", allow: PARTICIPANT_ALLOW, deny: 0n },
			`Ticket #${ticket.ticketNumber}: participant added`,
		);
		await this.#update(ticket.id, {});
		await this.#event(ticket.id, "participant_added", actor.actor.userId, {
			userId: String(userId),
		});
		await this.#say(
			ticket,
			`${userMention(actor.actor.userId)} added ${userMention(userId)} to this ticket.`,
		);
	}

	async removeParticipant(ticketId: string, actor: ActorContext, userId: bigint): Promise<void> {
		const ticket = await this.#requireOpen(ticketId);
		await this.#deps.permissions.require(actor.actor, "tickets.manage");
		if (userId === ticket.openerUserId) {
			throw new ValidationFailed("The person who opened the ticket cannot be removed.");
		}
		const removed = await this.#deps.db
			.delete(ticketParticipants)
			.where(
				and(eq(ticketParticipants.ticketId, ticket.id), eq(ticketParticipants.userId, userId)),
			)
			.returning({ userId: ticketParticipants.userId });
		if (!removed.length) throw new ValidationFailed("They are not in this ticket.");
		await this.#deps.api.deleteChannelPermission(
			ticket.channelId,
			userId,
			`Ticket #${ticket.ticketNumber}: participant removed`,
		);
		await this.#update(ticket.id, {});
		await this.#event(ticket.id, "participant_removed", actor.actor.userId, {
			userId: String(userId),
		});
		await this.#say(
			ticket,
			`${userMention(actor.actor.userId)} removed ${userMention(userId)} from this ticket.`,
		);
	}

	async transfer(ticketId: string, actor: ActorContext, categoryId: string): Promise<Ticket> {
		const ticket = await this.#requireOpen(ticketId);
		await this.#deps.permissions.require(actor.actor, "tickets.manage");
		if (ticket.categoryId === categoryId) {
			throw new ValidationFailed("This ticket is already in that category.");
		}
		const target = await this.category(ticket.guildId, categoryId);
		if (!target.enabled) throw new ValidationFailed("That ticket category is closed.");
		const previous = ticket.categoryId
			? await this.category(ticket.guildId, ticket.categoryId)
			: null;
		const reason = `Ticket #${ticket.ticketNumber}: transferred to ${target.name}`;

		let updated: Ticket;
		try {
			updated = await this.#update(ticket.id, { categoryId });
		} catch (error) {
			if (isUniqueViolation(error)) {
				throw new ValidationFailed("That member already has an open ticket in that category.");
			}
			throw error;
		}
		await this.#deps.api.editChannel(
			ticket.channelId,
			{ parentId: target.parentChannelId ?? null },
			reason,
		);
		for (const roleId of previous?.staffRoleIds ?? []) {
			if (target.staffRoleIds.includes(roleId)) continue;
			await this.#deps.api.deleteChannelPermission(ticket.channelId, roleId, reason);
		}
		for (const roleId of target.staffRoleIds) {
			await this.#deps.api.setChannelPermission(
				ticket.channelId,
				{ id: roleId, kind: "role", allow: STAFF_ALLOW, deny: 0n },
				reason,
			);
		}
		await this.#event(ticket.id, "transferred", actor.actor.userId, {
			categoryId,
			categoryName: target.name,
		});
		await this.#say(
			ticket,
			`${userMention(actor.actor.userId)} transferred this ticket to **${
				escapeMarkdown(target.name)
			}**.`,
		);
		return updated;
	}

	async addNote(ticketId: string, actor: ActorContext, content: string): Promise<TicketNote> {
		const ticket = await this.get(ticketId);
		await this.#deps.permissions.require(actor.actor, "tickets.manage");
		const trimmed = content.trim();
		if (!trimmed) throw new ValidationFailed("Note content cannot be empty.");
		if (trimmed.length > 1000) {
			throw new ValidationFailed("Notes must be 1000 characters or fewer.");
		}
		const [note] = await this.#deps.db
			.insert(ticketNotes)
			.values({ ticketId: ticket.id, authorId: actor.actor.userId, content: trimmed })
			.returning();
		await this.#update(ticket.id, {});
		await this.#event(ticket.id, "note_added", actor.actor.userId, {});
		return note!;
	}

	async close(ticketId: string, actor: ActorContext, reason: string | null): Promise<Ticket> {
		const ticket = await this.#requireOpen(ticketId);
		const actorId = actor.actor.userId;
		if (ticket.openerUserId !== actorId) {
			await this.#deps.permissions.require(actor.actor, "tickets.manage");
		}
		const closeReason = reason?.trim() || null;
		const events = [
			...(await this.listEvents(ticket.id)),
			{
				id: "pending",
				ticketId: ticket.id,
				type: "closed",
				actorId,
				data: closeReason ? { reason: closeReason } : {},
				createdAt: new Date(),
			},
		];
		const closedShape: Ticket = {
			...ticket,
			status: "closed",
			closedBy: actorId,
			closedAt: new Date(),
			closeReason,
		};
		const transcript = await this.#deps.transcripts.generate(closedShape, events, true);

		const updated = await this.#update(ticket.id, {
			status: "closed",
			closedBy: actorId,
			closedAt: closedShape.closedAt,
			closeReason,
		});
		await this.#event(ticket.id, "closed", actorId, closeReason ? { reason: closeReason } : {});

		const settings = await this.#deps.config.get(ticket.guildId);
		const participants = await this.listParticipants(ticket.id);
		const auditReason = `Ticket #${ticket.ticketNumber} closed`;
		if (settings.ticketArchiveCategoryId) {
			await this.#deps.api.editChannel(
				ticket.channelId,
				{ parentId: settings.ticketArchiveCategoryId },
				auditReason,
			);
			for (const participant of participants) {
				await this.#deps.api
					.deleteChannelPermission(ticket.channelId, participant.userId, auditReason)
					.catch((error: unknown) =>
						this.#deps.logger.warn("ticket overwrite cleanup failed", {
							ticketId: ticket.id,
							error,
						})
					);
			}
		} else {
			await this.#deps.api.deleteChannel(ticket.channelId, auditReason);
		}

		const name = `ticket-${ticket.ticketNumber}.html`;
		const notes = await this.listNotes(ticket.id);
		await this.#deps.discordLog.post(ticket.guildId, "tickets", {
			embeds: [{
				title: `Ticket #${ticket.ticketNumber} closed`,
				color: LOG_COLORS.neutral,
				timestamp: new Date().toISOString(),
				fields: [
					{ name: "Opened by", value: userMention(ticket.openerUserId), inline: true },
					{ name: "Closed by", value: userMention(actorId), inline: true },
					{ name: "Messages", value: String(transcript.messageCount), inline: true },
					{ name: "Reason", value: closeReason ? escapeMarkdown(closeReason) : "*None given*" },
				],
			}],
			files: [{ blob: new Blob([transcript.html], { type: "text/html" }), name }],
		});

		await this.#deps.api
			.sendDirectMessage(ticket.openerUserId, {
				content: `Your ticket #${ticket.ticketNumber} was closed.${
					closeReason ? ` Reason: ${escapeMarkdown(closeReason)}` : ""
				}${notes.length ? " Ask staff if you need a copy of the transcript." : ""}`,
				...(notes.length
					? {}
					: { files: [{ blob: new Blob([transcript.html], { type: "text/html" }), name }] }),
			})
			.catch(() => false);
		return updated;
	}

	async reopen(ticketId: string, actor: ActorContext): Promise<Ticket> {
		const ticket = await this.get(ticketId);
		await this.#deps.permissions.require(actor.actor, "tickets.manage");
		if (ticket.status === "open") throw new ValidationFailed("That ticket is already open.");
		const channel = await this.#deps.api.getChannel(ticket.channelId);
		if (!channel) {
			throw new ValidationFailed("That ticket channel no longer exists, so it cannot be reopened.");
		}
		const category = ticket.categoryId
			? await this.category(ticket.guildId, ticket.categoryId).catch(() => null)
			: null;
		const reason = `Ticket #${ticket.ticketNumber} reopened`;
		for (
			const overwrite of this.#overwrites(
				ticket.guildId,
				ticket.openerUserId,
				category?.staffRoleIds ?? [],
			)
		) {
			await this.#deps.api.setChannelPermission(ticket.channelId, overwrite, reason);
		}
		for (const participant of await this.listParticipants(ticket.id)) {
			if (participant.userId === ticket.openerUserId) continue;
			await this.#deps.api.setChannelPermission(
				ticket.channelId,
				{ id: participant.userId, kind: "member", allow: PARTICIPANT_ALLOW, deny: 0n },
				reason,
			);
		}
		let updated: Ticket;
		try {
			updated = await this.#update(ticket.id, {
				status: "open",
				closedBy: null,
				closedAt: null,
				closeReason: null,
			});
		} catch (error) {
			if (isUniqueViolation(error)) {
				throw new ValidationFailed("That member already has an open ticket in this category.");
			}
			throw error;
		}
		await this.#event(ticket.id, "reopened", actor.actor.userId, {});
		await this.#say(ticket, `${userMention(actor.actor.userId)} reopened this ticket.`);
		return updated;
	}

	#overwrites(guildId: bigint, openerId: bigint, staffRoleIds: bigint[]): PermissionOverwrite[] {
		return [
			{ id: guildId, kind: "role", allow: 0n, deny: VIEW_CHANNEL },
			{ id: openerId, kind: "member", allow: PARTICIPANT_ALLOW, deny: 0n },
			...staffRoleIds.map((id): PermissionOverwrite => ({
				id,
				kind: "role",
				allow: STAFF_ALLOW,
				deny: 0n,
			})),
			{ id: this.#deps.api.botUserId(), kind: "member", allow: BOT_ALLOW, deny: 0n },
		];
	}

	async #requireOpen(ticketId: string): Promise<Ticket> {
		const ticket = await this.get(ticketId);
		if (ticket.status !== "open") throw new ValidationFailed("That ticket is already closed.");
		return ticket;
	}

	async #update(ticketId: string, changes: Partial<Ticket>): Promise<Ticket> {
		const [updated] = await this.#deps.db
			.update(tickets)
			.set({ ...changes, lastActivityAt: new Date() })
			.where(eq(tickets.id, ticketId))
			.returning();
		return updated!;
	}

	async #event(
		ticketId: string,
		type: string,
		actorId: bigint | null,
		data: Record<string, unknown>,
	): Promise<void> {
		await this.#deps.db.insert(ticketEvents).values({ ticketId, type, actorId, data });
	}

	async #say(ticket: Ticket, content: string): Promise<void> {
		await this.#deps.api.sendMessage(ticket.channelId, { content }).catch((error: unknown) =>
			this.#deps.logger.warn("ticket channel notice failed", { ticketId: ticket.id, error })
		);
	}

	async #panelCategories(panel: TicketPanel): Promise<TicketCategory[]> {
		if (!panel.categoryIds.length) return [];
		const rows = await this.#deps.db
			.select()
			.from(ticketCategories)
			.where(
				and(
					eq(ticketCategories.guildId, panel.guildId),
					inArray(ticketCategories.id, panel.categoryIds),
					eq(ticketCategories.enabled, true),
				),
			);
		const order = new Map(panel.categoryIds.map((id, index) => [id, index]));
		return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
	}

	#panelMessage(panel: TicketPanel, categories: TicketCategory[]): OutboundMessage {
		const embed = {
			title: panel.title,
			color: LOG_COLORS.info,
			description: panel.body ??
				"Pick a category below and a private ticket channel opens for you.",
		};
		if (!categories.length) {
			return { embeds: [embed], components: [] };
		}
		if (panel.style === "select") {
			return {
				embeds: [embed],
				components: [actionRow([{
					type: MessageComponentTypes.SelectMenu,
					customId: encodeCustomId("ticket", "openselect", panel.id),
					placeholder: "Choose a category",
					options: categories.map((category) => ({
						label: truncate(category.name, 25),
						value: category.id,
						...(category.description ? { description: truncate(category.description, 50) } : {}),
						...(category.emoji ? { emoji: { name: category.emoji } } : {}),
					})),
				}])],
			};
		}
		return {
			embeds: [embed],
			components: chunk(categories, 5).map((group) =>
				actionRow(group.map((category) => ({
					type: MessageComponentTypes.Button,
					style: ButtonStyles.Secondary,
					label: truncate(category.name, 80),
					customId: encodeCustomId("ticket", "open", category.id),
					...(category.emoji ? { emoji: { name: category.emoji } } : {}),
				})))
			),
		};
	}
}
