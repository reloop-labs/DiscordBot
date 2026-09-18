import { and, eq } from "drizzle-orm";
import type { Database } from "../../database/client.ts";
import { memberPersistedRoles } from "../../database/schema/index.ts";
import type {
	DiscordApi,
	GuildSnapshot,
	MemberSnapshot,
} from "../../discord/adapters/discord-api.ts";
import { DiscordLogService, LOG_COLORS } from "../../discord/logging/discord-log.ts";
import type { Logger } from "../../logging/logger.ts";
import type { CardInput, WelcomeCardRenderer } from "./welcome-card.ts";
import { assertCanManageRole } from "../../permissions/hierarchy.ts";
import { isLoopError } from "../../shared/errors.ts";
import { formatDuration } from "../../shared/duration.ts";
import { escapeMarkdown, roleMention, truncate, userMention } from "../../shared/text.ts";
import { accountAgeMs } from "../../shared/snowflake.ts";
import type { GuildConfigService } from "../guild-config/service.ts";

const DEFAULT_WELCOME = "Welcome {user} to {server}!";
const DEFAULT_LEAVE = "{username} left.";
const NEW_ACCOUNT_MS = 7 * 86_400_000;
const CACHE_LIMIT = 5000;

export interface MemberCacheEntry {
	nick: string | null;
	roleIds: bigint[];
}

interface RoleContext {
	guild: GuildSnapshot;
	botMember: MemberSnapshot;
}

export function renderTemplate(
	template: string,
	values: { userId: bigint; username: string; server: string; memberCount?: number },
): string {
	return template
		.replaceAll("{user}", userMention(values.userId))
		.replaceAll("{username}", escapeMarkdown(values.username))
		.replaceAll("{server}", escapeMarkdown(values.server))
		.replaceAll("{membercount}", values.memberCount === undefined ? "" : String(values.memberCount))
		.trim();
}

export class MemberService {
	#cache = new Map<string, MemberCacheEntry>();

	constructor(
		private readonly api: DiscordApi,
		private readonly db: Database,
		private readonly config: GuildConfigService,
		private readonly discordLog: DiscordLogService,
		private readonly logger: Logger,
		private readonly cards: WelcomeCardRenderer | null = null,
	) {}

	cached(guildId: bigint, userId: bigint): MemberCacheEntry | null {
		return this.#cache.get(`${guildId}:${userId}`) ?? null;
	}

	remember(guildId: bigint, userId: bigint, entry: MemberCacheEntry): void {
		const key = `${guildId}:${userId}`;
		this.#cache.delete(key);
		this.#cache.set(key, { nick: entry.nick, roleIds: [...entry.roleIds] });
		while (this.#cache.size > CACHE_LIMIT) {
			const oldest = this.#cache.keys().next();
			if (oldest.done) break;
			this.#cache.delete(oldest.value);
		}
	}

	forget(guildId: bigint, userId: bigint): void {
		this.#cache.delete(`${guildId}:${userId}`);
	}

	async onJoin(member: MemberSnapshot, isBot: boolean, memberCount?: number): Promise<void> {
		this.remember(member.guildId, member.userId, { nick: member.nick, roleIds: member.roleIds });
		const settings = await this.config.get(member.guildId);
		const context = await this.roleContext(member.guildId);
		if (!isBot) {
			if (settings.memberRoleId && context) {
				await this.grant(member, settings.memberRoleId, context, "Automatic member role");
			}
			if (settings.persistRoles) await this.restore(member, context);
			if (settings.welcomeChannelId) {
				const server = context?.guild.name ?? "this server";
				const count = memberCount ?? context?.guild.memberCount ?? undefined;
				await this.announce(
					settings.welcomeChannelId,
					renderTemplate(settings.welcomeMessage ?? DEFAULT_WELCOME, {
						userId: member.userId,
						username: member.username,
						server,
						memberCount: count,
					}),
					await this.card({
						kind: "welcome",
						displayName: member.displayName,
						username: member.username,
						serverName: server,
						avatarUrl: member.avatarUrl,
						memberCount: count,
					}),
				);
			}
		}
		const ageMs = accountAgeMs(member.userId);
		const isNew = ageMs < NEW_ACCOUNT_MS;
		await this.discordLog.embed(member.guildId, "joins", {
			title: isBot ? "Bot added" : "Member joined",
			color: isNew ? LOG_COLORS.warning : LOG_COLORS.success,
			description: `${userMention(member.userId)} · \`${member.userId}\``,
			fields: [
				{ name: "Account age", value: formatDuration(ageMs), inline: true },
				...(isNew ? [{ name: "Note", value: "New account", inline: true }] : []),
			],
			footer: { text: truncate(member.username, 80) },
		});
	}

	async onLeave(
		guildId: bigint,
		userId: bigint,
		username: string,
		roleIds: bigint[] | null,
		avatarUrl: string | null = null,
	): Promise<void> {
		const settings = await this.config.get(guildId);
		if (settings.persistRoles && roleIds) {
			const context = await this.roleContext(guildId);
			const managed = new Set(
				(context?.guild.roles ?? []).filter((role) => role.managed).map((role) => String(role.id)),
			);
			const keep = roleIds.filter((id) => id !== guildId && !managed.has(String(id)));
			const leftAt = new Date();
			await this.db
				.insert(memberPersistedRoles)
				.values({ guildId, userId, roleIds: keep, leftAt })
				.onConflictDoUpdate({
					target: [memberPersistedRoles.guildId, memberPersistedRoles.userId],
					set: { roleIds: keep, leftAt },
				});
		}
		if (settings.leaveChannelId) {
			const server = (await this.roleContext(guildId))?.guild.name ?? "this server";
			const cached = this.cached(guildId, userId);
			await this.announce(
				settings.leaveChannelId,
				renderTemplate(settings.leaveMessage ?? DEFAULT_LEAVE, { userId, username, server }),
				await this.card({
					kind: "leave",
					displayName: cached?.nick ?? username,
					username,
					serverName: server,
					avatarUrl,
				}),
			);
		}
		this.forget(guildId, userId);
		await this.discordLog.embed(guildId, "leaves", {
			title: "Member left",
			color: LOG_COLORS.neutral,
			description: `${userMention(userId)} · \`${userId}\``,
			footer: { text: truncate(username, 80) },
		});
	}

	async onUpdate(before: MemberCacheEntry | null, after: MemberSnapshot): Promise<void> {
		this.remember(after.guildId, after.userId, { nick: after.nick, roleIds: after.roleIds });
		if (!before) return;
		const previous = new Set(before.roleIds.map(String));
		const current = new Set(after.roleIds.map(String));
		const added = after.roleIds.filter((id) => !previous.has(String(id)));
		const removed = before.roleIds.filter((id) => !current.has(String(id)));
		const nickChanged = before.nick !== after.nick;
		if (!nickChanged && added.length === 0 && removed.length === 0) return;
		const fields: { name: string; value: string; inline: boolean }[] = [];
		if (nickChanged) {
			fields.push({
				name: "Nickname",
				value: `${before.nick ? escapeMarkdown(before.nick) : "*none*"} → ${
					after.nick ? escapeMarkdown(after.nick) : "*none*"
				}`,
				inline: false,
			});
		}
		if (added.length) {
			fields.push({ name: "Roles added", value: added.map(roleMention).join(" "), inline: false });
		}
		if (removed.length) {
			fields.push({
				name: "Roles removed",
				value: removed.map(roleMention).join(" "),
				inline: false,
			});
		}
		await this.discordLog.embed(after.guildId, "members", {
			title: "Member updated",
			color: LOG_COLORS.info,
			description: `${userMention(after.userId)} · \`${after.userId}\``,
			fields,
			footer: { text: truncate(after.username, 80) },
		});
	}

	private async roleContext(guildId: bigint): Promise<RoleContext | null> {
		const [guild, botMember] = await Promise.all([
			this.api.getGuild(guildId).catch(() => null),
			this.api.getMember(guildId, this.api.botUserId()).catch(() => null),
		]);
		if (!guild || !botMember) {
			this.logger.warn("guild or bot member unavailable", { guildId });
			return null;
		}
		return { guild, botMember };
	}

	private async grant(
		member: MemberSnapshot,
		roleId: bigint,
		context: RoleContext,
		reason: string,
	): Promise<void> {
		try {
			assertCanManageRole(context.guild, context.botMember, roleId);
		} catch (error) {
			if (!isLoopError(error)) throw error;
			this.logger.warn("cannot assign role on join", {
				guildId: member.guildId,
				roleId,
				code: error.code,
				reason: error.message,
			});
			return;
		}
		try {
			await this.api.addRole(member.guildId, member.userId, roleId, reason);
		} catch (error) {
			this.logger.warn("role assignment failed", { guildId: member.guildId, roleId, error });
		}
	}

	private async restore(member: MemberSnapshot, context: RoleContext | null): Promise<void> {
		const where = and(
			eq(memberPersistedRoles.guildId, member.guildId),
			eq(memberPersistedRoles.userId, member.userId),
		);
		const [row] = await this.db.select().from(memberPersistedRoles).where(where);
		if (!row) return;
		if (context) {
			for (const roleId of row.roleIds) {
				if (member.roleIds.includes(roleId)) continue;
				await this.grant(member, roleId, context, "Restored role on rejoin");
			}
		}
		await this.db.delete(memberPersistedRoles).where(where);
	}

	private async card(input: CardInput): Promise<Uint8Array | null> {
		if (!this.cards) return null;
		try {
			return await this.cards.render(input);
		} catch (error) {
			this.logger.warn("card render failed", { kind: input.kind, error });
			return null;
		}
	}

	private async announce(
		channelId: bigint,
		content: string,
		image: Uint8Array | null = null,
	): Promise<void> {
		if (!content && !image) return;
		try {
			await this.api.sendMessage(channelId, {
				content: truncate(content, 2000),
				files: image
					? [{ blob: new Blob([image as BlobPart], { type: "image/png" }), name: "card.png" }]
					: undefined,
			});
		} catch (error) {
			this.logger.warn("member announcement failed", { channelId, error });
		}
	}
}
