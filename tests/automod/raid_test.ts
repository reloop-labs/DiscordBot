import { assertEquals } from "@std/assert";
import { DiscordLogService } from "../../src/discord/logging/discord-log.ts";
import { RaidService } from "../../src/domains/automod/raid-service.ts";
import { GuildConfigService } from "../../src/domains/guild-config/service.ts";
import { silentLogger } from "../../src/logging/logger.ts";
import { createMemoryStore, type KeyValueStore } from "../../src/redis/client.ts";
import { dbTest } from "../helpers/database.ts";
import { FakeDiscordApi } from "../helpers/fake-discord.ts";

const OLD_ACCOUNT = new Date("2020-01-01T00:00:00Z");

function storeWithoutRedis(): KeyValueStore {
	return {
		...createMemoryStore(),
		incrWithTtl: () => Promise.resolve(null),
		slidingWindowAdd: () => Promise.resolve(null),
		acquireLock: () => Promise.resolve(true),
	};
}

async function setup(
	db: Parameters<Parameters<typeof dbTest>[1]>[0],
	guildId: bigint,
	store: KeyValueStore = createMemoryStore(),
) {
	const api = new FakeDiscordApi();
	const config = new GuildConfigService(db);
	await config.update(guildId, {
		raidJoinThreshold: 3,
		raidJoinWindowSeconds: 60,
		raidMinAccountAgeHours: 24,
	});
	const raid = new RaidService(
		store,
		config,
		new DiscordLogService(api, config, silentLogger),
		silentLogger,
	);
	return { api, raid, store };
}

dbTest("the raid alert fires once per window", async (db, guildId) => {
	const { raid } = await setup(db, guildId);
	assertEquals(await raid.recordJoin(guildId, 1n, OLD_ACCOUNT), null);
	assertEquals(await raid.recordJoin(guildId, 2n, OLD_ACCOUNT), null);
	const signal = await raid.recordJoin(guildId, 3n, OLD_ACCOUNT);
	assertEquals(signal?.joins, 3);
	assertEquals(signal?.threshold, 3);
	assertEquals(signal?.windowSeconds, 60);
	assertEquals(await raid.recordJoin(guildId, 4n, OLD_ACCOUNT), null);
});

dbTest("young accounts are counted separately", async (db, guildId) => {
	const { raid } = await setup(db, guildId);
	const young = new Date(Date.now() - 3_600_000);
	await raid.recordJoin(guildId, 1n, young);
	await raid.recordJoin(guildId, 2n, OLD_ACCOUNT);
	const signal = await raid.recordJoin(guildId, 3n, young);
	assertEquals(signal?.youngAccounts, 2);
	assertEquals(signal?.minAccountAgeHours, 24);
});

dbTest("status reports the current window", async (db, guildId) => {
	const { raid } = await setup(db, guildId);
	assertEquals((await raid.status(guildId)).joins, 0);
	await raid.recordJoin(guildId, 1n, OLD_ACCOUNT);
	await raid.recordJoin(guildId, 2n, OLD_ACCOUNT);
	const status = await raid.status(guildId);
	assertEquals(status.joins, 2);
	assertEquals(status.threshold, 3);
	assertEquals(status.alerting, false);
	assertEquals(status.available, true);
});

dbTest("no redis means no raid signal", async (db, guildId) => {
	const { raid } = await setup(db, guildId, storeWithoutRedis());
	for (let join = 0; join < 5; join += 1) {
		assertEquals(await raid.recordJoin(guildId, BigInt(join), OLD_ACCOUNT), null);
	}
});
