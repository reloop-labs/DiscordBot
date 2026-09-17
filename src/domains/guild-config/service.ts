import { and, eq } from "drizzle-orm";
import type { Database } from "../../database/client.ts";
import { guildLogChannels, guilds, guildSettings } from "../../database/schema/index.ts";

export type GuildSettings = typeof guildSettings.$inferSelect;
export type GuildSettingsPatch = Partial<Omit<GuildSettings, "guildId" | "updatedAt">>;
export type LogKind = (typeof guildLogChannels.$inferSelect)["kind"];

const DEFAULTS: Omit<GuildSettings, "guildId" | "updatedAt"> = {
	memberRoleId: null,
	welcomeChannelId: null,
	welcomeMessage: null,
	leaveChannelId: null,
	leaveMessage: null,
	dmOnModeration: true,
	persistRoles: false,
	suggestionChannelId: null,
	reportChannelId: null,
	ticketArchiveCategoryId: null,
	ticketInactivityHours: 72,
	raidJoinThreshold: 10,
	raidJoinWindowSeconds: 60,
	raidMinAccountAgeHours: 24,
	raidAlertRoleId: null,
};

export class GuildConfigService {
	#db: Database;
	#cache = new Map<string, { settings: GuildSettings; expiresAt: number }>();

	constructor(db: Database) {
		this.#db = db;
	}

	async ensureGuild(guildId: bigint, name: string): Promise<void> {
		await this.#db
			.insert(guilds)
			.values({ id: guildId, name })
			.onConflictDoUpdate({ target: guilds.id, set: { name, leftAt: null } });
	}

	async markLeft(guildId: bigint): Promise<void> {
		await this.#db.update(guilds).set({ leftAt: new Date() }).where(eq(guilds.id, guildId));
	}

	async get(guildId: bigint): Promise<GuildSettings> {
		const cached = this.#cache.get(String(guildId));
		if (cached && cached.expiresAt > Date.now()) return cached.settings;
		const [row] = await this.#db.select().from(guildSettings).where(
			eq(guildSettings.guildId, guildId),
		);
		const settings = row ?? { guildId, updatedAt: new Date(), ...DEFAULTS };
		this.#cache.set(String(guildId), { settings, expiresAt: Date.now() + 30_000 });
		return settings;
	}

	async update(guildId: bigint, patch: GuildSettingsPatch): Promise<GuildSettings> {
		const [row] = await this.#db
			.insert(guildSettings)
			.values({ guildId, ...patch })
			.onConflictDoUpdate({ target: guildSettings.guildId, set: patch })
			.returning();
		this.#cache.delete(String(guildId));
		return row!;
	}

	async logChannel(guildId: bigint, kind: LogKind): Promise<bigint | null> {
		const [row] = await this.#db
			.select({ channelId: guildLogChannels.channelId })
			.from(guildLogChannels)
			.where(and(eq(guildLogChannels.guildId, guildId), eq(guildLogChannels.kind, kind)));
		return row?.channelId ?? null;
	}

	async logChannels(guildId: bigint): Promise<Partial<Record<LogKind, bigint>>> {
		const rows = await this.#db.select().from(guildLogChannels).where(
			eq(guildLogChannels.guildId, guildId),
		);
		return Object.fromEntries(rows.map((row) => [row.kind, row.channelId]));
	}

	async setLogChannel(guildId: bigint, kind: LogKind, channelId: bigint | null): Promise<void> {
		if (channelId === null) {
			await this.#db
				.delete(guildLogChannels)
				.where(and(eq(guildLogChannels.guildId, guildId), eq(guildLogChannels.kind, kind)));
			return;
		}
		await this.#db
			.insert(guildLogChannels)
			.values({ guildId, kind, channelId })
			.onConflictDoUpdate({
				target: [guildLogChannels.guildId, guildLogChannels.kind],
				set: { channelId },
			});
	}

	invalidate(guildId: bigint): void {
		this.#cache.delete(String(guildId));
	}
}
