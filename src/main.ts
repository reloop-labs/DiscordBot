import { Lifecycle } from "./app/lifecycle.ts";
import { Scheduler } from "./app/scheduler.ts";
import { buildContainer } from "./app/container.ts";
import { loadEnv, secretsOf } from "./config/env.ts";
import { createDiscordenoApi } from "./discord/adapters/discordeno-api.ts";
import { createLoopBot } from "./discord/bot.ts";
import { buildCommands } from "./discord/commands/index.ts";
import { attachEvents, type GatewayState } from "./discord/events/index.ts";
import { InteractionRouter } from "./discord/interactions/router.ts";
import { startHealthServer } from "./health/server.ts";
import { createLogger } from "./logging/logger.ts";
import { createRedisStore } from "./redis/client.ts";

const env = loadEnv();
const logger = createLogger({
	level: env.LOG_LEVEL,
	base: { service: "loop", environment: env.ENVIRONMENT },
	secrets: secretsOf(env),
});
const lifecycle = new Lifecycle(logger.child({ component: "lifecycle" }));

const bot = createLoopBot({ token: env.DISCORD_TOKEN, logger });
const api = createDiscordenoApi(bot);
const store = createRedisStore(env.REDIS_URL, logger.child({ component: "redis" }));
const container = buildContainer({ env, logger, store, api });

if (!(await container.database.ping())) {
	logger.error("database unreachable at startup");
	Deno.exit(1);
}
await store.connect();

const router = new InteractionRouter(logger.child({ component: "interactions" }));
const commands = buildCommands(container);
for (const command of commands.commands) router.command(command);
for (const component of commands.components) router.component(component);

const gateway: GatewayState = { connected: false };
attachEvents(bot, container, router, gateway);

const health = startHealthServer({
	host: env.HEALTH_HOST,
	port: env.PORT,
	logger: logger.child({ component: "health" }),
	probe: {
		gatewayConnected: () => gateway.connected,
		databaseReachable: () => container.database.ping(),
		redisAvailable: () => store.available(),
		shuttingDown: () => lifecycle.shuttingDown,
	},
});

const scheduler = new Scheduler(logger.child({ component: "scheduler" }));
scheduler.add({
	name: "expire-cases",
	intervalMs: 60_000,
	run: async () => {
		const expired = await container.cases.expireDue();
		if (expired.length) logger.info("cases expired", { count: expired.length });
	},
});

lifecycle.onShutdown("scheduler", () => scheduler.stop());
lifecycle.onShutdown("health server", () => health.close());
lifecycle.onShutdown("redis", () => store.close());
lifecycle.onShutdown("database", () => container.database.close());
lifecycle.onShutdown("discord gateway", async () => {
	gateway.connected = false;
	await bot.shutdown();
});
lifecycle.listenForSignals();

if (env.DISCORD_REGISTER_COMMANDS !== "off") {
	const definitions = commands.commands.map((command) => command.definition);
	const target = env.DISCORD_REGISTER_COMMANDS;
	try {
		const registered = target === "global"
			? await bot.helpers.upsertGlobalApplicationCommands(definitions)
			: await bot.helpers.upsertGuildApplicationCommands(
				target.slice("guild:".length),
				definitions,
			);
		logger.info("application commands registered", { target, count: registered.length });
	} catch (error) {
		logger.error("application command registration failed", { target, error });
	}
}

logger.info("starting gateway", { applicationId: env.DISCORD_APPLICATION_ID });
await bot.start();
