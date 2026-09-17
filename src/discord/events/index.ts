import type { Container } from "../../app/container.ts";
import type { LoopBot } from "../bot.ts";
import type { InteractionRouter } from "../interactions/router.ts";
import { attachMemberEvents } from "./members.ts";
import { attachMessageEvents } from "./messages.ts";

export interface GatewayState {
	connected: boolean;
}

export function attachEvents(
	bot: LoopBot,
	c: Container,
	router: InteractionRouter,
	state: GatewayState,
): void {
	const logger = c.logger.child({ component: "events" });

	bot.events.ready = ({ shardId, guilds, user }) => {
		state.connected = true;
		logger.info("gateway ready", { shardId, guildCount: guilds.length, botUserId: user.id });
	};

	bot.gateway.events = {
		...bot.gateway.events,
		connected: (shard) => {
			state.connected = true;
			logger.info("shard connected", { shardId: shard.id });
		},
		resumed: (shard) => {
			state.connected = true;
			logger.info("shard resumed", { shardId: shard.id });
		},
		disconnected: (shard) => {
			state.connected = false;
			logger.warn("shard disconnected", { shardId: shard.id });
		},
	};

	bot.events.guildCreate = async (guild) => {
		await c.config.ensureGuild(guild.id, guild.name).catch((error) =>
			logger.error("guild upsert failed", { guildId: guild.id, error })
		);
	};

	bot.events.guildDelete = async (guildId) => {
		await c.config.markLeft(guildId).catch((error) =>
			logger.error("guild leave update failed", { guildId, error })
		);
	};

	bot.events.interactionCreate = (interaction) => router.dispatch(interaction);

	attachMemberEvents(bot, { members: c.members, raid: c.raid, logger });
	attachMessageEvents(bot, { automod: c.automod, discordLog: c.discordLog, logger });
}
