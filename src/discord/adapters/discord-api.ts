import type {
	AllowedMentions,
	Camelize,
	DiscordEmbed,
	FileContent,
	MessageComponents,
} from "@discordeno/bot";

export type Embed = Camelize<DiscordEmbed>;

export interface OutboundMessage {
	content?: string;
	embeds?: Embed[];
	components?: MessageComponents;
	allowedMentions?: AllowedMentions;
	files?: FileContent[];
}

export interface RoleSnapshot {
	id: bigint;
	name: string;
	position: number;
	permissions: bigint;
	managed: boolean;
}

export interface GuildSnapshot {
	id: bigint;
	name: string;
	ownerId: bigint;
	roles: RoleSnapshot[];
}

export interface MemberSnapshot {
	userId: bigint;
	guildId: bigint;
	username: string;
	displayName: string;
	nick: string | null;
	roleIds: bigint[];
	joinedAt: Date;
	communicationDisabledUntil: Date | null;
	isBot: boolean;
	avatarUrl: string | null;
}

export interface UserSnapshot {
	id: bigint;
	username: string;
	isBot: boolean;
}

export interface ChannelSnapshot {
	id: bigint;
	guildId: bigint | null;
	name: string;
	type: number;
	parentId: bigint | null;
	rateLimitPerUser: number;
}

export interface MessageSnapshot {
	id: bigint;
	channelId: bigint;
	authorId: bigint;
	authorUsername: string;
	authorIsBot: boolean;
	content: string;
	createdAt: Date;
	editedAt: Date | null;
	attachments: { name: string; url: string; size: number; contentType: string | null }[];
	embeds: Embed[];
	referencedMessageId: bigint | null;
	pinned: boolean;
}

export interface PermissionOverwrite {
	id: bigint;
	kind: "role" | "member";
	allow: bigint;
	deny: bigint;
}

export interface DiscordApi {
	botUserId(): bigint;
	getGuild(guildId: bigint): Promise<GuildSnapshot | null>;
	getMember(guildId: bigint, userId: bigint): Promise<MemberSnapshot | null>;
	getUser(userId: bigint): Promise<UserSnapshot | null>;
	getChannel(channelId: bigint): Promise<ChannelSnapshot | null>;
	getInviteGuildId(code: string): Promise<bigint | null>;
	banMember(
		guildId: bigint,
		userId: bigint,
		options: { deleteMessageSeconds?: number; reason: string },
	): Promise<void>;
	unbanMember(guildId: bigint, userId: bigint, reason: string): Promise<void>;
	kickMember(guildId: bigint, userId: bigint, reason: string): Promise<void>;
	timeoutMember(guildId: bigint, userId: bigint, until: Date | null, reason: string): Promise<void>;
	setNickname(
		guildId: bigint,
		userId: bigint,
		nickname: string | null,
		reason: string,
	): Promise<void>;
	addRole(guildId: bigint, userId: bigint, roleId: bigint, reason: string): Promise<void>;
	removeRole(guildId: bigint, userId: bigint, roleId: bigint, reason: string): Promise<void>;
	setRoles(guildId: bigint, userId: bigint, roleIds: bigint[], reason: string): Promise<void>;
	sendMessage(channelId: bigint, message: OutboundMessage): Promise<{ id: bigint } | null>;
	editMessage(channelId: bigint, messageId: bigint, message: OutboundMessage): Promise<void>;
	sendDirectMessage(userId: bigint, message: OutboundMessage): Promise<boolean>;
	deleteMessage(channelId: bigint, messageId: bigint, reason: string): Promise<void>;
	bulkDeleteMessages(channelId: bigint, messageIds: bigint[], reason: string): Promise<void>;
	getMessages(
		channelId: bigint,
		options: { limit: number; before?: bigint },
	): Promise<MessageSnapshot[]>;
	editChannel(
		channelId: bigint,
		changes: { name?: string; rateLimitPerUser?: number; parentId?: bigint | null; topic?: string },
		reason: string,
	): Promise<void>;
	setChannelPermission(
		channelId: bigint,
		overwrite: PermissionOverwrite,
		reason: string,
	): Promise<void>;
	deleteChannelPermission(channelId: bigint, overwriteId: bigint, reason: string): Promise<void>;
	createTextChannel(
		guildId: bigint,
		options: { name: string; parentId?: bigint; topic?: string; overwrites: PermissionOverwrite[] },
		reason: string,
	): Promise<{ id: bigint }>;
	deleteChannel(channelId: bigint, reason: string): Promise<void>;
}
