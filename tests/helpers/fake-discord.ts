import type {
	ChannelSnapshot,
	DiscordApi,
	GuildSnapshot,
	MemberSnapshot,
	MessageSnapshot,
	OutboundMessage,
	RoleSnapshot,
	UserSnapshot,
} from "../../src/discord/adapters/discord-api.ts";

export const GUILD_ID = 100000000000000001n;
export const OWNER_ID = 100000000000000002n;
export const BOT_ID = 100000000000000003n;
export const MOD_ID = 100000000000000004n;
export const TARGET_ID = 100000000000000005n;
export const EVERYONE_ROLE = GUILD_ID;
export const BOT_ROLE = 200000000000000001n;
export const MOD_ROLE = 200000000000000002n;
export const MEMBER_ROLE = 200000000000000003n;
export const ADMIN_ROLE = 200000000000000004n;

const ADMINISTRATOR = 8n;
const KICK = 2n;
const BAN = 4n;
const MODERATE = 1n << 40n;
const MANAGE_ROLES = 1n << 28n;
const MANAGE_MESSAGES = 1n << 13n;

export function role(
	id: bigint,
	name: string,
	position: number,
	permissions = 0n,
	managed = false,
): RoleSnapshot {
	return { id, name, position, permissions, managed };
}

export function member(
	userId: bigint,
	roleIds: bigint[],
	extra: Partial<MemberSnapshot> = {},
): MemberSnapshot {
	return {
		userId,
		guildId: GUILD_ID,
		username: `user${userId % 100n}`,
		displayName: `user${userId % 100n}`,
		nick: null,
		roleIds,
		joinedAt: new Date("2025-01-01T00:00:00Z"),
		communicationDisabledUntil: null,
		isBot: false,
		avatarUrl: null,
		...extra,
	};
}

export function guild(): GuildSnapshot {
	return {
		id: GUILD_ID,
		name: "Reloop",
		ownerId: OWNER_ID,
		memberCount: 1204,
		roles: [
			role(EVERYONE_ROLE, "@everyone", 0),
			role(MEMBER_ROLE, "Member", 1),
			role(MOD_ROLE, "Moderator", 5, KICK | BAN | MODERATE | MANAGE_MESSAGES),
			role(BOT_ROLE, "Loop", 8, KICK | BAN | MODERATE | MANAGE_ROLES | MANAGE_MESSAGES),
			role(ADMIN_ROLE, "Admin", 10, ADMINISTRATOR),
		],
	};
}

export interface Call {
	method: string;
	args: unknown[];
}

export class FakeDiscordApi implements DiscordApi {
	calls: Call[] = [];
	guildSnapshot = guild();
	members = new Map<string, MemberSnapshot>();
	users = new Map<string, UserSnapshot>();
	dmFails = new Set<string>();
	failNext: { method: string; error: Error } | null = null;
	sentMessages: { channelId: bigint; message: OutboundMessage }[] = [];
	dms: { userId: bigint; message: OutboundMessage }[] = [];
	messages = new Map<string, MessageSnapshot[]>();
	invites = new Map<string, bigint>();

	constructor() {
		this.members.set(String(BOT_ID), member(BOT_ID, [BOT_ROLE], { isBot: true, username: "loop" }));
		this.members.set(String(MOD_ID), member(MOD_ID, [MOD_ROLE], { username: "mod" }));
		this.members.set(String(TARGET_ID), member(TARGET_ID, [MEMBER_ROLE], { username: "target" }));
		this.members.set(String(OWNER_ID), member(OWNER_ID, [], { username: "owner" }));
	}

	#record(method: string, ...args: unknown[]): void {
		this.calls.push({ method, args });
		if (this.failNext?.method === method) {
			const { error } = this.failNext;
			this.failNext = null;
			throw error;
		}
	}

	calledWith(method: string): Call[] {
		return this.calls.filter((c) => c.method === method);
	}

	botUserId(): bigint {
		return BOT_ID;
	}
	getGuild(): Promise<GuildSnapshot | null> {
		return Promise.resolve(this.guildSnapshot);
	}
	getMember(_guildId: bigint, userId: bigint): Promise<MemberSnapshot | null> {
		return Promise.resolve(this.members.get(String(userId)) ?? null);
	}
	getUser(userId: bigint): Promise<UserSnapshot | null> {
		const m = this.members.get(String(userId));
		if (m) return Promise.resolve({ id: userId, username: m.username, isBot: m.isBot });
		return Promise.resolve(this.users.get(String(userId)) ?? null);
	}
	getChannel(channelId: bigint): Promise<ChannelSnapshot | null> {
		return Promise.resolve({
			id: channelId,
			guildId: GUILD_ID,
			name: "channel",
			type: 0,
			parentId: null,
			rateLimitPerUser: 0,
		});
	}
	getInviteGuildId(code: string): Promise<bigint | null> {
		return Promise.resolve(this.invites.get(code.toLowerCase()) ?? null);
	}
	banMember(
		guildId: bigint,
		userId: bigint,
		options: { deleteMessageSeconds?: number; reason: string },
	): Promise<void> {
		this.#record("banMember", guildId, userId, options);
		return Promise.resolve();
	}
	unbanMember(guildId: bigint, userId: bigint, reason: string): Promise<void> {
		this.#record("unbanMember", guildId, userId, reason);
		return Promise.resolve();
	}
	kickMember(guildId: bigint, userId: bigint, reason: string): Promise<void> {
		this.#record("kickMember", guildId, userId, reason);
		this.members.delete(String(userId));
		return Promise.resolve();
	}
	timeoutMember(
		guildId: bigint,
		userId: bigint,
		until: Date | null,
		reason: string,
	): Promise<void> {
		this.#record("timeoutMember", guildId, userId, until, reason);
		const m = this.members.get(String(userId));
		if (m) m.communicationDisabledUntil = until;
		return Promise.resolve();
	}
	setNickname(
		guildId: bigint,
		userId: bigint,
		nickname: string | null,
		reason: string,
	): Promise<void> {
		this.#record("setNickname", guildId, userId, nickname, reason);
		return Promise.resolve();
	}
	addRole(guildId: bigint, userId: bigint, roleId: bigint, reason: string): Promise<void> {
		this.#record("addRole", guildId, userId, roleId, reason);
		const m = this.members.get(String(userId));
		if (m && !m.roleIds.includes(roleId)) m.roleIds.push(roleId);
		return Promise.resolve();
	}
	removeRole(guildId: bigint, userId: bigint, roleId: bigint, reason: string): Promise<void> {
		this.#record("removeRole", guildId, userId, roleId, reason);
		const m = this.members.get(String(userId));
		if (m) m.roleIds = m.roleIds.filter((r) => r !== roleId);
		return Promise.resolve();
	}
	setRoles(guildId: bigint, userId: bigint, roleIds: bigint[], reason: string): Promise<void> {
		this.#record("setRoles", guildId, userId, roleIds, reason);
		const m = this.members.get(String(userId));
		if (m) m.roleIds = [...roleIds];
		return Promise.resolve();
	}
	sendMessage(channelId: bigint, message: OutboundMessage): Promise<{ id: bigint } | null> {
		this.#record("sendMessage", channelId, message);
		this.sentMessages.push({ channelId, message });
		return Promise.resolve({ id: 900000000000000000n + BigInt(this.sentMessages.length) });
	}
	editMessage(channelId: bigint, messageId: bigint, message: OutboundMessage): Promise<void> {
		this.#record("editMessage", channelId, messageId, message);
		return Promise.resolve();
	}
	sendDirectMessage(userId: bigint, message: OutboundMessage): Promise<boolean> {
		this.#record("sendDirectMessage", userId, message);
		if (this.dmFails.has(String(userId))) return Promise.resolve(false);
		this.dms.push({ userId, message });
		return Promise.resolve(true);
	}
	deleteMessage(channelId: bigint, messageId: bigint, reason: string): Promise<void> {
		this.#record("deleteMessage", channelId, messageId, reason);
		return Promise.resolve();
	}
	bulkDeleteMessages(channelId: bigint, messageIds: bigint[], reason: string): Promise<void> {
		this.#record("bulkDeleteMessages", channelId, messageIds, reason);
		return Promise.resolve();
	}
	getMessages(
		channelId: bigint,
		options: { limit: number; before?: bigint },
	): Promise<MessageSnapshot[]> {
		this.#record("getMessages", channelId, options);
		const all = this.messages.get(String(channelId)) ?? [];
		const filtered = options.before ? all.filter((m) => m.id < options.before!) : all;
		return Promise.resolve(filtered.slice(0, options.limit));
	}
	editChannel(channelId: bigint, changes: Record<string, unknown>, reason: string): Promise<void> {
		this.#record("editChannel", channelId, changes, reason);
		return Promise.resolve();
	}
	setChannelPermission(channelId: bigint, overwrite: unknown, reason: string): Promise<void> {
		this.#record("setChannelPermission", channelId, overwrite, reason);
		return Promise.resolve();
	}
	deleteChannelPermission(channelId: bigint, overwriteId: bigint, reason: string): Promise<void> {
		this.#record("deleteChannelPermission", channelId, overwriteId, reason);
		return Promise.resolve();
	}
	createTextChannel(guildId: bigint, options: unknown, reason: string): Promise<{ id: bigint }> {
		this.#record("createTextChannel", guildId, options, reason);
		return Promise.resolve({ id: 800000000000000000n + BigInt(this.calls.length) });
	}
	deleteChannel(channelId: bigint, reason: string): Promise<void> {
		this.#record("deleteChannel", channelId, reason);
		return Promise.resolve();
	}
}
