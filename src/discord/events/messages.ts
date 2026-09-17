import type { AutomodService } from "../../domains/automod/engine.ts";
import { contentExcerpt } from "../../domains/automod/rules.ts";
import type { Logger } from "../../logging/logger.ts";
import { channelMention, escapeMarkdown, truncate, userMention } from "../../shared/text.ts";
import { snowflakeCreatedAt } from "../../shared/snowflake.ts";
import type { LoopBot, LoopMessage } from "../bot.ts";
import { LOG_COLORS } from "../logging/discord-log.ts";
import type { DiscordLogService } from "../logging/discord-log.ts";

const CACHE_LIMIT = 2000;

interface CachedMessage {
	authorId: bigint;
	channelId: bigint;
	content: string;
	attachments: string[];
}

export interface MessageEventDeps {
	automod: AutomodService;
	discordLog: DiscordLogService;
	logger: Logger;
}

function attachmentNames(message: LoopMessage): string[] {
	return (message.attachments ?? []).map((attachment) => attachment.filename);
}

function snapshotOf(message: LoopMessage): CachedMessage {
	return {
		authorId: message.author.id,
		channelId: message.channelId,
		content: message.content ?? "",
		attachments: attachmentNames(message),
	};
}

export function attachMessageEvents(bot: LoopBot, deps: MessageEventDeps): void {
	const { automod, discordLog, logger } = deps;
	const recent = new Map<string, CachedMessage>();

	const remember = (messageId: bigint, snapshot: CachedMessage): void => {
		recent.set(String(messageId), snapshot);
		while (recent.size > CACHE_LIMIT) {
			const oldest = recent.keys().next().value;
			if (oldest === undefined) break;
			recent.delete(oldest);
		}
	};

	const logMessage = async (
		guildId: bigint,
		title: string,
		color: number,
		snapshot: CachedMessage,
		fields: { name: string; value: string; inline?: boolean }[],
	): Promise<void> => {
		await discordLog.embed(guildId, "messages", {
			title,
			color,
			fields: [
				{
					name: "Author",
					value: `${userMention(snapshot.authorId)} (${snapshot.authorId})`,
					inline: true,
				},
				{ name: "Channel", value: channelMention(snapshot.channelId), inline: true },
				...fields,
				...(snapshot.attachments.length
					? [{
						name: "Attachments",
						value: truncate(
							snapshot.attachments.map((name) => escapeMarkdown(name)).join(", "),
							1000,
						),
						inline: false,
					}]
					: []),
			],
		}).catch((error) => logger.warn("message log failed", { guildId, error }));
	};

	bot.events.messageCreate = async (message) => {
		if (!message.guildId || message.author.bot) return;
		remember(message.id, snapshotOf(message));
		await automod.handle({
			guildId: message.guildId,
			channelId: message.channelId,
			messageId: message.id,
			authorId: message.author.id,
			authorRoleIds: message.member?.roles ?? [],
			authorIsBot: false,
			accountCreatedAt: snowflakeCreatedAt(message.author.id),
			content: message.content ?? "",
			mentionedUserIds: message.mentionedUserIds ?? [],
			mentionedRoleIds: message.mentionedRoleIds ?? [],
			mentionsEveryone: message.mentionEveryone === true,
			attachmentCount: (message.attachments ?? []).length,
			createdAt: new Date(message.timestamp),
		});
	};

	bot.events.messageDelete = async (payload, message) => {
		if (!payload.guildId) return;
		const cached = recent.get(String(payload.id));
		recent.delete(String(payload.id));
		if (message?.author.bot) return;
		const snapshot = message ? snapshotOf(message) : cached;
		if (!snapshot) return;
		await logMessage(payload.guildId, "Message deleted", LOG_COLORS.danger, snapshot, [{
			name: "Content",
			value: contentExcerpt(snapshot.content || cached?.content || "", 1000),
			inline: false,
		}]);
	};

	bot.events.messageUpdate = async (message) => {
		if (!message.guildId || message.author.bot) return;
		if (typeof message.content !== "string" || !message.content) return;
		const before = recent.get(String(message.id));
		const snapshot = snapshotOf(message);
		remember(message.id, snapshot);
		await logMessage(message.guildId, "Message edited", LOG_COLORS.warning, snapshot, [
			...(before && before.content !== snapshot.content
				? [{ name: "Before", value: contentExcerpt(before.content, 1000), inline: false }]
				: []),
			{ name: "After", value: contentExcerpt(snapshot.content, 1000), inline: false },
		]);
	};
}
