import {
	avatarUrl,
	BitwisePermissionFlags,
	ChannelTypes,
	OverwriteTypes,
	type PermissionStrings,
} from "@discordeno/bot";
import type { LoopBot, LoopMember, LoopMessage } from "../bot.ts";
import type {
	ChannelSnapshot,
	DiscordApi,
	GuildSnapshot,
	MemberSnapshot,
	MessageSnapshot,
	OutboundMessage,
	UserSnapshot,
} from "./discord-api.ts";
import { NO_MENTIONS } from "../../shared/text.ts";

const isNotFound = (error: unknown) =>
	typeof error === "object" && error !== null && "status" in error &&
	((error as { status: number }).status === 404 || (error as { status: number }).status === 403);

async function orNull<T>(operation: () => Promise<T>): Promise<T | null> {
	try {
		return await operation();
	} catch (error) {
		if (isNotFound(error)) return null;
		throw error;
	}
}

export function toMemberSnapshot(member: LoopMember): MemberSnapshot {
	const user = member.user;
	return {
		userId: member.id,
		guildId: member.guildId,
		username: user?.username ?? "unknown",
		displayName: member.nick ?? user?.globalName ?? user?.username ?? "unknown",
		nick: member.nick ?? null,
		roleIds: [...(member.roles ?? [])],
		joinedAt: new Date(member.joinedAt),
		communicationDisabledUntil: member.communicationDisabledUntil
			? new Date(member.communicationDisabledUntil)
			: null,
		isBot: user?.bot ?? false,
		avatarUrl: user ? avatarUrl(user.id, user.discriminator, { avatar: user.avatar }) : null,
	};
}

export function toMessageSnapshot(message: LoopMessage): MessageSnapshot {
	return {
		id: message.id,
		channelId: message.channelId,
		authorId: message.author.id,
		authorUsername: message.author.username,
		authorIsBot: message.author.bot,
		content: message.content ?? "",
		createdAt: new Date(message.timestamp),
		editedAt: message.editedTimestamp ? new Date(message.editedTimestamp) : null,
		attachments: (message.attachments ?? []).map((a) => ({
			name: a.filename,
			url: a.url,
			size: a.size,
			contentType: a.contentType ?? null,
		})),
		embeds: (message.embeds ?? []).map((embed) => ({
			...embed,
			timestamp: embed.timestamp ? new Date(embed.timestamp).toISOString() : undefined,
		})),
		referencedMessageId: message.messageReference?.messageId ?? null,
		pinned: message.pinned,
	};
}

const withMentions = (message: OutboundMessage) => ({
	...message,
	allowedMentions: message.allowedMentions ?? NO_MENTIONS,
});

export function createDiscordenoApi(bot: LoopBot): DiscordApi {
	const h = bot.helpers;
	return {
		botUserId: () => bot.id,

		getGuild: (guildId) =>
			orNull(async (): Promise<GuildSnapshot> => {
				const guild = await h.getGuild(guildId, { counts: true });
				return {
					id: guild.id,
					name: guild.name,
					ownerId: guild.ownerId,
					memberCount: guild.approximateMemberCount ?? null,
					roles: [...guild.roles.values()].map((role) => ({
						id: role.id,
						name: role.name,
						position: role.position,
						permissions: role.permissions.bitfield,
						managed: role.managed,
					})),
				};
			}),

		getMember: (guildId, userId) =>
			orNull(async () => toMemberSnapshot(await h.getMember(guildId, userId))),

		getUser: (userId) =>
			orNull(async (): Promise<UserSnapshot> => {
				const user = await h.getUser(userId);
				return { id: user.id, username: user.username, isBot: user.bot };
			}),

		getChannel: (channelId) =>
			orNull(async (): Promise<ChannelSnapshot> => {
				const channel = await h.getChannel(channelId);
				return {
					id: channel.id,
					guildId: channel.guildId ?? null,
					name: channel.name ?? "",
					type: channel.type,
					parentId: channel.parentId ?? null,
					rateLimitPerUser: channel.rateLimitPerUser ?? 0,
				};
			}),

		getInviteGuildId: async (code) => {
			if (!/^[A-Za-z0-9-]{2,32}$/.test(code)) return null;
			const invite = await orNull(() => h.getInvite(code));
			return invite?.guildId ?? null;
		},

		banMember: (guildId, userId, { deleteMessageSeconds, reason }) =>
			h.banMember(guildId, userId, { deleteMessageSeconds }, reason),
		unbanMember: (guildId, userId, reason) => h.unbanMember(guildId, userId, reason),
		kickMember: (guildId, userId, reason) => h.kickMember(guildId, userId, reason),
		timeoutMember: async (guildId, userId, until, reason) => {
			await h.editMember(guildId, userId, {
				communicationDisabledUntil: until?.toISOString() ?? null,
			}, reason);
		},
		setNickname: async (guildId, userId, nickname, reason) => {
			await h.editMember(guildId, userId, { nick: nickname }, reason);
		},
		addRole: (guildId, userId, roleId, reason) => h.addRole(guildId, userId, roleId, reason),
		removeRole: (guildId, userId, roleId, reason) => h.removeRole(guildId, userId, roleId, reason),
		setRoles: async (guildId, userId, roleIds, reason) => {
			await h.editMember(guildId, userId, { roles: roleIds }, reason);
		},

		sendMessage: async (channelId, message) => {
			const sent = await orNull(() => h.sendMessage(channelId, withMentions(message)));
			return sent ? { id: sent.id } : null;
		},
		editMessage: async (channelId, messageId, message) => {
			await h.editMessage(channelId, messageId, withMentions(message));
		},
		sendDirectMessage: async (userId, message) => {
			try {
				const channel = await h.getDmChannel(userId);
				await h.sendMessage(channel.id, withMentions(message));
				return true;
			} catch {
				return false;
			}
		},
		deleteMessage: async (channelId, messageId, reason) => {
			await orNull(() => h.deleteMessage(channelId, messageId, reason));
		},
		bulkDeleteMessages: async (channelId, messageIds, reason) => {
			if (messageIds.length === 0) return;
			if (messageIds.length === 1) {
				await orNull(() => h.deleteMessage(channelId, messageIds[0]!, reason));
				return;
			}
			await h.deleteMessages(channelId, messageIds, reason);
		},
		getMessages: async (channelId, { limit, before }) => {
			const messages = await h.getMessages(channelId, { limit, before });
			return messages.map(toMessageSnapshot);
		},

		editChannel: async (channelId, changes, reason) => {
			await h.editChannel(channelId, changes, reason);
		},
		setChannelPermission: (channelId, overwrite, reason) =>
			h.editChannelPermissionOverrides(
				channelId,
				{
					id: overwrite.id,
					type: overwrite.kind === "role" ? OverwriteTypes.Role : OverwriteTypes.Member,
					allow: bitsToStrings(overwrite.allow),
					deny: bitsToStrings(overwrite.deny),
				},
				reason,
			),
		deleteChannelPermission: (channelId, overwriteId, reason) =>
			h.deleteChannelPermissionOverride(channelId, overwriteId, reason),
		createTextChannel: async (guildId, options, reason) => {
			const channel = await h.createChannel(
				guildId,
				{
					name: options.name,
					type: ChannelTypes.GuildText,
					parentId: options.parentId,
					topic: options.topic,
					permissionOverwrites: options.overwrites.map((o) => ({
						id: o.id,
						type: o.kind === "role" ? OverwriteTypes.Role : OverwriteTypes.Member,
						allow: bitsToStrings(o.allow),
						deny: bitsToStrings(o.deny),
					})),
				},
				reason,
			);
			return { id: channel.id };
		},
		deleteChannel: async (channelId, reason) => {
			await orNull(() => h.deleteChannel(channelId, reason));
		},
	};
}

export function bitsToStrings(bits: bigint): PermissionStrings[] {
	const names: PermissionStrings[] = [];
	for (const [name, value] of Object.entries(BitwisePermissionFlags)) {
		if (typeof value !== "number" && typeof value !== "bigint") continue;
		if ((bits & BigInt(value)) !== 0n) names.push(name as PermissionStrings);
	}
	return names;
}
