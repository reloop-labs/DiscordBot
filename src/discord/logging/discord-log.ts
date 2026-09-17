import type { DiscordApi, Embed, OutboundMessage } from "../adapters/discord-api.ts";
import type { GuildConfigService, LogKind } from "../../domains/guild-config/service.ts";
import type { Logger } from "../../logging/logger.ts";

export const LOG_COLORS = {
	info: 0x5865f2,
	success: 0x57f287,
	warning: 0xfee75c,
	danger: 0xed4245,
	neutral: 0x99aab5,
} as const;

export class DiscordLogService {
	#api: DiscordApi;
	#config: GuildConfigService;
	#logger: Logger;

	constructor(api: DiscordApi, config: GuildConfigService, logger: Logger) {
		this.#api = api;
		this.#config = config;
		this.#logger = logger;
	}

	async post(guildId: bigint, kind: LogKind, message: OutboundMessage): Promise<bigint | null> {
		const channelId = await this.#config.logChannel(guildId, kind);
		if (!channelId) return null;
		try {
			const sent = await this.#api.sendMessage(channelId, message);
			return sent?.id ?? null;
		} catch (error) {
			this.#logger.warn("discord log post failed", { guildId, kind, error });
			return null;
		}
	}

	embed(guildId: bigint, kind: LogKind, embed: Embed): Promise<bigint | null> {
		return this.post(guildId, kind, {
			embeds: [{ timestamp: new Date().toISOString(), ...embed }],
		});
	}
}
