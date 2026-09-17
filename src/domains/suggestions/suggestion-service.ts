import { ButtonStyles, MessageComponentTypes } from "@discordeno/bot";
import type { MessageComponents } from "@discordeno/bot";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../../database/client.ts";
import { nextSequence } from "../../database/sequences.ts";
import { suggestions, suggestionVotes } from "../../database/schema/index.ts";
import type { DiscordApi, Embed } from "../../discord/adapters/discord-api.ts";
import { encodeCustomId } from "../../discord/interactions/custom-id.ts";
import { type DiscordLogService, LOG_COLORS } from "../../discord/logging/discord-log.ts";
import type { Logger } from "../../logging/logger.ts";
import type { ActorContext } from "../../permissions/actor.ts";
import type { PermissionService } from "../../permissions/service.ts";
import type { KeyValueStore } from "../../redis/client.ts";
import { CooldownActive, NotConfigured, NotFound, ValidationFailed } from "../../shared/errors.ts";
import { neutralizeMentions, truncate } from "../../shared/text.ts";
import type { AuditService } from "../audit/service.ts";
import type { GuildConfigService } from "../guild-config/service.ts";

export type Suggestion = typeof suggestions.$inferSelect;
export type SuggestionStatus = Suggestion["status"];
export type Vote = 1 | -1 | 0;

export interface SuggestionDeps {
	api: DiscordApi;
	db: Database;
	store: KeyValueStore;
	config: GuildConfigService;
	permissions: PermissionService;
	discordLog: DiscordLogService;
	audit: AuditService;
	logger: Logger;
}

const COOLDOWN_MS = 300_000;
const MIN_TITLE = 5;
const MAX_TITLE = 100;
const MIN_CONTENT = 20;
const MAX_CONTENT = 2000;
const MAX_RESPONSE = 1000;

export const SUGGESTION_STATUSES: SuggestionStatus[] = [
	"open",
	"under_review",
	"planned",
	"accepted",
	"declined",
	"implemented",
];

const TRANSITIONS: Record<SuggestionStatus, SuggestionStatus[]> = {
	open: ["under_review", "planned", "accepted", "declined"],
	under_review: ["planned", "accepted", "declined"],
	planned: ["implemented", "declined"],
	accepted: ["implemented"],
	declined: [],
	implemented: [],
};

const STATUS_LABEL: Record<SuggestionStatus, string> = {
	open: "Open",
	under_review: "Under review",
	planned: "Planned",
	accepted: "Accepted",
	declined: "Declined",
	implemented: "Implemented",
};

const STATUS_COLOR: Record<SuggestionStatus, number> = {
	open: LOG_COLORS.info,
	under_review: LOG_COLORS.warning,
	planned: 0x3498db,
	accepted: LOG_COLORS.success,
	declined: LOG_COLORS.danger,
	implemented: 0x2ecc71,
};

export function canTransition(from: SuggestionStatus, to: SuggestionStatus): boolean {
	return TRANSITIONS[from].includes(to);
}

export function votingClosed(status: SuggestionStatus): boolean {
	return status === "declined" || status === "implemented";
}

export function statusLabel(status: SuggestionStatus): string {
	return STATUS_LABEL[status];
}

export function renderEmbed(suggestion: Suggestion): Embed {
	const fields: NonNullable<Embed["fields"]> = [
		{ name: "Status", value: STATUS_LABEL[suggestion.status], inline: true },
		{
			name: "Votes",
			value: `👍 ${suggestion.upvotes} · 👎 ${suggestion.downvotes}`,
			inline: true,
		},
	];
	if (suggestion.officialResponse) {
		fields.push({
			name: "Response from staff",
			value: neutralizeMentions(truncate(suggestion.officialResponse, 1000)),
			inline: false,
		});
	}
	return {
		title: truncate(`#${suggestion.suggestionNumber} · ${suggestion.title}`, 250),
		description: neutralizeMentions(suggestion.content),
		color: STATUS_COLOR[suggestion.status],
		fields,
		footer: { text: `Suggested by ${suggestion.authorId}` },
		timestamp: suggestion.createdAt.toISOString(),
	};
}

export function suggestionComponents(suggestion: Suggestion): MessageComponents {
	const closed = votingClosed(suggestion.status);
	return [{
		type: MessageComponentTypes.ActionRow,
		components: [
			{
				type: MessageComponentTypes.Button,
				label: "Upvote",
				customId: encodeCustomId("suggest", "up", suggestion.id),
				style: ButtonStyles.Success,
				disabled: closed,
			},
			{
				type: MessageComponentTypes.Button,
				label: "Downvote",
				customId: encodeCustomId("suggest", "down", suggestion.id),
				style: ButtonStyles.Danger,
				disabled: closed,
			},
			{
				type: MessageComponentTypes.Button,
				label: "Retract vote",
				customId: encodeCustomId("suggest", "none", suggestion.id),
				style: ButtonStyles.Secondary,
				disabled: closed,
			},
		],
	}];
}

export class SuggestionService {
	constructor(private readonly deps: SuggestionDeps) {}

	async submit(
		guildId: bigint,
		authorId: bigint,
		title: string,
		content: string,
	): Promise<Suggestion> {
		const { db, store, config } = this.deps;
		const cleanTitle = title.trim();
		const cleanContent = content.trim();
		if (cleanTitle.length < MIN_TITLE || cleanTitle.length > MAX_TITLE) {
			throw new ValidationFailed(`Titles are ${MIN_TITLE} to ${MAX_TITLE} characters.`);
		}
		if (cleanContent.length < MIN_CONTENT || cleanContent.length > MAX_CONTENT) {
			throw new ValidationFailed(
				`Describe the idea in ${MIN_CONTENT} to ${MAX_CONTENT} characters.`,
			);
		}
		const channelId = (await config.get(guildId)).suggestionChannelId;
		if (!channelId) throw new NotConfigured("Suggestions channel");

		const used = await store.incrWithTtl(`suggestion:rate:${guildId}:${authorId}`, COOLDOWN_MS);
		if (used !== null && used > 1) throw new CooldownActive(COOLDOWN_MS / 1000);

		const suggestion = await db.transaction(async (tx) => {
			const suggestionNumber = await nextSequence(tx, guildId, "suggestion");
			const [row] = await tx
				.insert(suggestions)
				.values({
					guildId,
					suggestionNumber,
					authorId,
					channelId,
					title: cleanTitle,
					content: cleanContent,
				})
				.returning();
			return row!;
		});

		const posted = await this.#post(suggestion);
		return posted ? { ...suggestion, messageId: posted } : suggestion;
	}

	async vote(
		guildId: bigint,
		suggestionId: string,
		userId: bigint,
		vote: Vote,
	): Promise<Suggestion> {
		const suggestion = await this.#byId(suggestionId);
		if (suggestion.guildId !== guildId) throw new NotFound("That suggestion");
		if (suggestion.authorId === userId) {
			throw new ValidationFailed("You cannot vote on your own suggestion.");
		}
		if (votingClosed(suggestion.status)) {
			throw new ValidationFailed(
				`Voting is closed: this suggestion is ${STATUS_LABEL[suggestion.status].toLowerCase()}.`,
			);
		}
		const updated = await this.deps.db.transaction(async (tx) => {
			if (vote === 0) {
				await tx
					.delete(suggestionVotes)
					.where(
						and(
							eq(suggestionVotes.suggestionId, suggestionId),
							eq(suggestionVotes.userId, userId),
						),
					);
			} else {
				await tx
					.insert(suggestionVotes)
					.values({ suggestionId, userId, vote })
					.onConflictDoUpdate({
						target: [suggestionVotes.suggestionId, suggestionVotes.userId],
						set: { vote },
					});
			}
			const [totals] = await tx
				.select({
					up: sql<
						number
					>`coalesce(sum(case when ${suggestionVotes.vote} > 0 then 1 else 0 end), 0)::int`,
					down: sql<
						number
					>`coalesce(sum(case when ${suggestionVotes.vote} < 0 then 1 else 0 end), 0)::int`,
				})
				.from(suggestionVotes)
				.where(eq(suggestionVotes.suggestionId, suggestionId));
			const [row] = await tx
				.update(suggestions)
				.set({ upvotes: totals?.up ?? 0, downvotes: totals?.down ?? 0 })
				.where(eq(suggestions.id, suggestionId))
				.returning();
			return row!;
		});
		await this.#refresh(updated);
		return updated;
	}

	async setStatus(
		suggestionId: string,
		actor: ActorContext,
		status: SuggestionStatus,
		response?: string,
	): Promise<Suggestion> {
		const { db, permissions, discordLog, audit } = this.deps;
		await permissions.require(actor.actor, "suggestions.manage");
		const suggestion = await this.#byId(suggestionId);
		if (suggestion.guildId !== actor.actor.guildId) throw new NotFound("That suggestion");
		if (!canTransition(suggestion.status, status)) {
			throw new ValidationFailed(
				`A ${STATUS_LABEL[suggestion.status].toLowerCase()} suggestion cannot become ${
					STATUS_LABEL[status].toLowerCase()
				}.`,
			);
		}
		const officialResponse = response?.trim() || null;
		if (officialResponse && officialResponse.length > MAX_RESPONSE) {
			throw new ValidationFailed(`Responses must be ${MAX_RESPONSE} characters or fewer.`);
		}
		const [row] = await db
			.update(suggestions)
			.set({
				status,
				officialResponse: officialResponse ?? suggestion.officialResponse,
				respondedBy: actor.actor.userId,
				respondedAt: new Date(),
			})
			.where(eq(suggestions.id, suggestionId))
			.returning();
		const updated = row!;
		await this.#refresh(updated);
		await this.#notifyAuthor(updated);
		await discordLog.embed(updated.guildId, "suggestions", {
			title: `Suggestion #${updated.suggestionNumber} · ${STATUS_LABEL[status]}`,
			color: STATUS_COLOR[status],
			fields: [
				{ name: "Staff", value: `<@${actor.actor.userId}>`, inline: true },
				{ name: "Title", value: truncate(updated.title, 200), inline: false },
				...(officialResponse
					? [{ name: "Response", value: truncate(officialResponse, 1000), inline: false }]
					: []),
			],
		});
		await audit.record({
			guildId: updated.guildId,
			actorId: actor.actor.userId,
			action: "suggestion.status",
			target: String(updated.suggestionNumber),
			data: { from: suggestion.status, to: status },
		});
		return updated;
	}

	async get(guildId: bigint, suggestionNumber: number): Promise<Suggestion> {
		const [row] = await this.deps.db
			.select()
			.from(suggestions)
			.where(
				and(
					eq(suggestions.guildId, guildId),
					eq(suggestions.suggestionNumber, suggestionNumber),
				),
			);
		if (!row) throw new NotFound(`Suggestion #${suggestionNumber}`);
		return row;
	}

	async list(guildId: bigint, status?: SuggestionStatus, limit = 25): Promise<Suggestion[]> {
		return await this.deps.db
			.select()
			.from(suggestions)
			.where(
				status
					? and(eq(suggestions.guildId, guildId), eq(suggestions.status, status))
					: eq(suggestions.guildId, guildId),
			)
			.orderBy(desc(suggestions.suggestionNumber))
			.limit(limit);
	}

	async byMessage(messageId: bigint): Promise<Suggestion | null> {
		const [row] = await this.deps.db
			.select()
			.from(suggestions)
			.where(eq(suggestions.messageId, messageId));
		return row ?? null;
	}

	async #byId(suggestionId: string): Promise<Suggestion> {
		const [row] = await this.deps.db
			.select()
			.from(suggestions)
			.where(eq(suggestions.id, suggestionId));
		if (!row) throw new NotFound("That suggestion");
		return row;
	}

	async #post(suggestion: Suggestion): Promise<bigint | null> {
		try {
			const sent = await this.deps.api.sendMessage(suggestion.channelId, {
				embeds: [renderEmbed(suggestion)],
				components: suggestionComponents(suggestion),
			});
			if (!sent) return null;
			await this.deps.db
				.update(suggestions)
				.set({ messageId: sent.id })
				.where(eq(suggestions.id, suggestion.id));
			return sent.id;
		} catch (error) {
			this.deps.logger.warn("suggestion post failed", {
				guildId: suggestion.guildId,
				suggestionNumber: suggestion.suggestionNumber,
				error,
			});
			return null;
		}
	}

	async #refresh(suggestion: Suggestion): Promise<void> {
		if (!suggestion.messageId) return;
		try {
			await this.deps.api.editMessage(suggestion.channelId, suggestion.messageId, {
				embeds: [renderEmbed(suggestion)],
				components: suggestionComponents(suggestion),
			});
		} catch (error) {
			this.deps.logger.warn("suggestion message edit failed", {
				guildId: suggestion.guildId,
				suggestionNumber: suggestion.suggestionNumber,
				error,
			});
		}
	}

	async #notifyAuthor(suggestion: Suggestion): Promise<void> {
		const lines = [
			`Your suggestion #${suggestion.suggestionNumber} is now **${
				STATUS_LABEL[suggestion.status]
			}**.`,
		];
		if (suggestion.officialResponse) lines.push(suggestion.officialResponse);
		try {
			await this.deps.api.sendDirectMessage(suggestion.authorId, { content: lines.join("\n") });
		} catch (error) {
			this.deps.logger.debug("suggestion author dm failed", {
				authorId: suggestion.authorId,
				error,
			});
		}
	}
}
