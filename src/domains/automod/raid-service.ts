import { LOG_COLORS } from "../../discord/logging/discord-log.ts";
import type { DiscordLogService } from "../../discord/logging/discord-log.ts";
import type { Logger } from "../../logging/logger.ts";
import type { KeyValueStore } from "../../redis/client.ts";
import { roleMention } from "../../shared/text.ts";
import type { GuildConfigService } from "../guild-config/service.ts";

export interface RaidSignal {
	guildId: bigint;
	joins: number;
	youngAccounts: number;
	windowSeconds: number;
	minAccountAgeHours: number;
	threshold: number;
}

export interface RaidStatus {
	joins: number;
	youngAccounts: number;
	threshold: number;
	windowSeconds: number;
	minAccountAgeHours: number;
	alerting: boolean;
	available: boolean;
}

export class RaidService {
	constructor(
		private readonly store: KeyValueStore,
		private readonly config: GuildConfigService,
		private readonly discordLog: DiscordLogService,
		private readonly logger: Logger,
	) {}

	async recordJoin(
		guildId: bigint,
		userId: bigint,
		accountCreatedAt: Date,
	): Promise<RaidSignal | null> {
		const settings = await this.config.get(guildId);
		const windowMs = settings.raidJoinWindowSeconds * 1000;
		const joins = await this.store.slidingWindowAdd(
			`raid:joins:${guildId}`,
			windowMs,
			String(userId),
		);
		if (joins === null) return null;
		await this.store.set(`raid:recent:${guildId}`, String(joins), windowMs);

		const isYoung = Date.now() - accountCreatedAt.getTime() <
			settings.raidMinAccountAgeHours * 3_600_000;
		const youngKey = `raid:young:${guildId}`;
		const youngAccounts = isYoung
			? await this.store.incrWithTtl(youngKey, windowMs) ?? 0
			: Number(await this.store.get(youngKey) ?? 0);

		if (joins < settings.raidJoinThreshold) return null;
		if (!(await this.store.acquireLock(`raid:alert:${guildId}`, windowMs * 5))) return null;

		const signal: RaidSignal = {
			guildId,
			joins,
			youngAccounts,
			windowSeconds: settings.raidJoinWindowSeconds,
			minAccountAgeHours: settings.raidMinAccountAgeHours,
			threshold: settings.raidJoinThreshold,
		};
		await this.#alert(signal, settings.raidAlertRoleId);
		this.logger.warn("raid signal", {
			guildId,
			joins,
			youngAccounts,
			windowSeconds: signal.windowSeconds,
		});
		return signal;
	}

	async status(guildId: bigint): Promise<RaidStatus> {
		const settings = await this.config.get(guildId);
		const [joins, young, alert] = await Promise.all([
			this.store.get(`raid:recent:${guildId}`),
			this.store.get(`raid:young:${guildId}`),
			this.store.get(`raid:alert:${guildId}`),
		]);
		return {
			joins: Number(joins ?? 0),
			youngAccounts: Number(young ?? 0),
			threshold: settings.raidJoinThreshold,
			windowSeconds: settings.raidJoinWindowSeconds,
			minAccountAgeHours: settings.raidMinAccountAgeHours,
			alerting: alert !== null,
			available: this.store.available(),
		};
	}

	async #alert(signal: RaidSignal, alertRoleId: bigint | null): Promise<void> {
		await this.discordLog.post(signal.guildId, "automod", {
			content: alertRoleId ? roleMention(alertRoleId) : undefined,
			allowedMentions: alertRoleId ? { parse: [], roles: [alertRoleId] } : undefined,
			embeds: [{
				title: "Possible raid",
				color: LOG_COLORS.danger,
				timestamp: new Date().toISOString(),
				description:
					`Possible raid: ${signal.joins} joins in ${signal.windowSeconds}s, ${signal.youngAccounts} of them accounts under ${signal.minAccountAgeHours}h.`,
				fields: [
					{ name: "Threshold", value: `${signal.threshold} joins`, inline: true },
					{ name: "Window", value: `${signal.windowSeconds}s`, inline: true },
					{
						name: "Young accounts",
						value: `${signal.youngAccounts} under ${signal.minAccountAgeHours}h`,
						inline: true,
					},
				],
				footer: { text: "Loop only reports raids. Lockdown stays a human decision." },
			}],
		});
	}
}
