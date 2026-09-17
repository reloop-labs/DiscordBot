import { type CreateApplicationCommand, createBot } from "@discordeno/bot";
import { loadEnv } from "../src/config/env.ts";
import { buildCommands } from "../src/discord/commands/index.ts";
import { buildContainer } from "../src/app/container.ts";
import { createLogger, silentLogger } from "../src/logging/logger.ts";
import { createMemoryStore } from "../src/redis/client.ts";
import type { DiscordApi } from "../src/discord/adapters/discord-api.ts";

const env = loadEnv();
const scope = Deno.args.includes("--global") ? "global" : "guild";
const logger = createLogger({ level: "info", secrets: [env.DISCORD_TOKEN] });

const definitions: CreateApplicationCommand[] = buildCommands(
	buildContainer({
		env,
		logger: silentLogger,
		store: createMemoryStore(),
		api: new Proxy({}, { get: () => () => Promise.resolve(null) }) as DiscordApi,
		database: {
			db: {} as never,
			ping: () => Promise.resolve(true),
			close: () => Promise.resolve(),
		},
	}),
).commands.map((command) => command.definition);

const bot = createBot({ token: env.DISCORD_TOKEN, applicationId: env.DISCORD_APPLICATION_ID });

if (scope === "global") {
	const result = await bot.helpers.upsertGlobalApplicationCommands(definitions);
	logger.info("registered global commands", {
		count: result.length,
		names: result.map((c) => c.name),
	});
} else {
	if (!env.DISCORD_DEV_GUILD_ID) {
		logger.error("DISCORD_DEV_GUILD_ID is required for guild registration (or pass --global)");
		Deno.exit(2);
	}
	const result = await bot.helpers.upsertGuildApplicationCommands(
		env.DISCORD_DEV_GUILD_ID,
		definitions,
	);
	logger.info("registered guild commands", {
		guildId: env.DISCORD_DEV_GUILD_ID,
		count: result.length,
		names: result.map((c) => c.name),
	});
}
Deno.exit(0);
