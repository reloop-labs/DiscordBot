import { assertEquals, assertNotEquals } from "@std/assert";
import { DiscordLogService } from "../../src/discord/logging/discord-log.ts";
import { AutomodService } from "../../src/domains/automod/engine.ts";
import type { AutomodMessage } from "../../src/domains/automod/rules.ts";
import { GuildConfigService } from "../../src/domains/guild-config/service.ts";
import { CaseService } from "../../src/domains/moderation/case-service.ts";
import { silentLogger } from "../../src/logging/logger.ts";
import { PermissionService } from "../../src/permissions/service.ts";
import { createMemoryStore, type KeyValueStore } from "../../src/redis/client.ts";
import { dbTest } from "../helpers/database.ts";
import {
	BOT_ID,
	BOT_ROLE,
	FakeDiscordApi,
	MEMBER_ROLE,
	MOD_ID,
	MOD_ROLE,
	TARGET_ID,
} from "../helpers/fake-discord.ts";

const SHOUTING = "THIS IS ALL SHOUTING AT EVERYONE";

function storeWithoutRedis(): KeyValueStore {
	return {
		...createMemoryStore(),
		incrWithTtl: () => Promise.resolve(null),
		slidingWindowAdd: () => Promise.resolve(null),
		acquireLock: () => Promise.resolve(true),
	};
}

function setup(
	db: Parameters<Parameters<typeof dbTest>[1]>[0],
	guildId: bigint,
	store: KeyValueStore = createMemoryStore(),
) {
	const api = new FakeDiscordApi();
	api.guildSnapshot.id = guildId;
	for (const m of api.members.values()) m.guildId = guildId;
	const config = new GuildConfigService(db);
	const cases = new CaseService(db);
	const discordLog = new DiscordLogService(api, config, silentLogger);
	const automod = new AutomodService(
		api,
		db,
		store,
		cases,
		config,
		new PermissionService(db),
		discordLog,
		silentLogger,
	);
	return { api, automod, cases, store };
}

function message(guildId: bigint, overrides: Partial<AutomodMessage> = {}): AutomodMessage {
	return {
		guildId,
		channelId: 500000000000000001n,
		messageId: 600000000000000001n,
		authorId: TARGET_ID,
		authorRoleIds: [MEMBER_ROLE],
		authorIsBot: false,
		accountCreatedAt: new Date("2020-01-01T00:00:00Z"),
		content: SHOUTING,
		mentionedUserIds: [],
		mentionedRoleIds: [],
		mentionsEveryone: false,
		attachmentCount: 0,
		createdAt: new Date(),
		...overrides,
	};
}

dbTest("bots and staff are never evaluated", async (db, guildId) => {
	const { automod } = setup(db, guildId);
	await automod.create(guildId, { name: "shout", type: "caps" }, MOD_ID);
	assertEquals(await automod.evaluate(message(guildId, { authorIsBot: true })), null);
	assertEquals(
		await automod.evaluate(message(guildId, { authorId: MOD_ID, authorRoleIds: [MOD_ROLE] })),
		null,
	);
	assertNotEquals(await automod.evaluate(message(guildId)), null);
});

dbTest("exempt roles and channels skip the rule", async (db, guildId) => {
	const { automod } = setup(db, guildId);
	await automod.create(guildId, {
		name: "shout",
		type: "caps",
		exemptRoleIds: [MEMBER_ROLE],
	}, MOD_ID);
	assertEquals(await automod.evaluate(message(guildId)), null);

	await automod.update(guildId, "shout", {
		exemptRoleIds: [],
		exemptChannelIds: [500000000000000001n],
	});
	assertEquals(await automod.evaluate(message(guildId)), null);
	assertNotEquals(
		await automod.evaluate(message(guildId, { channelId: 500000000000000002n })),
		null,
	);
});

dbTest("three matching rules resolve to one decision with merged actions", async (db, guildId) => {
	const { automod } = setup(db, guildId);
	await automod.create(guildId, {
		name: "terms",
		type: "blocked_terms",
		config: { terms: ["shouting"] },
		severity: 1,
		actions: { delete: true },
	}, MOD_ID);
	await automod.create(guildId, {
		name: "shout",
		type: "caps",
		severity: 5,
		actions: { delete: false, warn: true, notifyStaff: true },
	}, MOD_ID);
	await automod.create(guildId, {
		name: "mentions",
		type: "mention_spam",
		severity: 3,
		actions: { delete: false, createCase: true },
	}, MOD_ID);

	const decision = await automod.evaluate(
		message(guildId, { mentionedUserIds: [1n, 2n, 3n, 4n, 5n, 6n] }),
	);
	assertEquals(decision?.rule.name, "shout");
	assertEquals(decision?.matches.length, 3);
	assertEquals(decision?.actions, {
		delete: true,
		warn: true,
		timeoutMs: null,
		notifyStaff: true,
		createCase: true,
	});
});

dbTest("cooldown suppresses punishment but still deletes", async (db, guildId) => {
	const { automod } = setup(db, guildId);
	await automod.create(guildId, {
		name: "shout",
		type: "caps",
		cooldownSeconds: 60,
		actions: { delete: true, warn: true, createCase: true, notifyStaff: true },
	}, MOD_ID);

	const first = await automod.evaluate(message(guildId));
	assertEquals(first?.actions.warn, true);
	assertEquals(first?.actions.createCase, true);

	const second = await automod.evaluate(message(guildId));
	assertEquals(second?.actions, {
		delete: true,
		warn: false,
		timeoutMs: null,
		notifyStaff: false,
		createCase: false,
	});
	assertEquals(second?.escalationLevel, 0);
});

dbTest("escalation upgrades a warn to 10m then 1h", async (db, guildId) => {
	const { automod } = setup(db, guildId);
	await automod.create(guildId, {
		name: "shout",
		type: "caps",
		cooldownSeconds: 0,
		actions: { delete: true, warn: true },
	}, MOD_ID);

	const levels: (number | null)[] = [];
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const decision = await automod.evaluate(message(guildId));
		levels.push(decision?.actions.timeoutMs ?? null);
	}
	assertEquals(levels, [null, null, 600_000, 600_000, 3_600_000]);
});

dbTest(
	"a store without redis skips windowed rules but keeps content rules",
	async (db, guildId) => {
		const { automod } = setup(db, guildId, storeWithoutRedis());
		await automod.create(guildId, {
			name: "flood",
			type: "message_rate",
			config: { maxMessages: 2, windowSeconds: 5 },
			severity: 9,
		}, MOD_ID);
		await automod.create(guildId, { name: "shout", type: "caps", severity: 1 }, MOD_ID);

		const decision = await automod.evaluate(message(guildId));
		assertEquals(decision?.rule.name, "shout");
		assertEquals(decision?.matches.length, 1);
		assertEquals(decision?.escalationLevel, 0);
	},
);

dbTest("enforce deletes, times out and records the case as the bot", async (db, guildId) => {
	const { automod, api, cases } = setup(db, guildId);
	await automod.create(guildId, {
		name: "shout",
		type: "caps",
		actions: { delete: true, warn: true, timeoutMs: 600_000, createCase: true },
	}, MOD_ID);

	const input = message(guildId);
	const decision = await automod.evaluate(input);
	await automod.enforce(input, decision!);

	assertEquals(api.calledWith("deleteMessage").length, 1);
	assertEquals(api.calledWith("timeoutMember").length, 1);
	assertEquals(api.dms.length, 1);

	const history = await cases.historyFor(guildId, TARGET_ID);
	assertEquals(history.length, 1);
	assertEquals(history[0]?.action, "automod");
	assertEquals(history[0]?.moderatorUserId, BOT_ID);
	assertEquals(history[0]?.durationMs, 600_000);
	assertEquals(history[0]?.reason?.startsWith("Automod: shout"), true);
});

dbTest("a hierarchy failure on timeout is logged, not thrown", async (db, guildId) => {
	const { automod, api, cases } = setup(db, guildId);
	const botRole = api.guildSnapshot.roles.find((role) => role.id === BOT_ROLE);
	if (botRole) botRole.position = 0;
	await automod.create(guildId, {
		name: "shout",
		type: "caps",
		actions: { delete: true, timeoutMs: 600_000, createCase: false },
	}, MOD_ID);

	const input = message(guildId);
	const decision = await automod.evaluate(input);
	await automod.enforce(input, decision!);

	assertEquals(api.calledWith("timeoutMember").length, 0);
	assertEquals(api.calledWith("deleteMessage").length, 1);
	assertEquals((await cases.historyFor(guildId, TARGET_ID)).length, 0);
});

dbTest("handle swallows failures from discord", async (db, guildId) => {
	const { automod, api } = setup(db, guildId);
	await automod.create(guildId, { name: "shout", type: "caps" }, MOD_ID);
	api.failNext = { method: "deleteMessage", error: new Error("discord down") };
	await automod.handle(message(guildId));
	assertEquals(api.calledWith("deleteMessage").length, 1);
});

dbTest("rules are validated and unique per guild", async (db, guildId) => {
	const { automod } = setup(db, guildId);
	await automod.create(guildId, { name: "shout", type: "caps" }, MOD_ID);
	let duplicate = false;
	await automod.create(guildId, { name: "shout", type: "caps" }, MOD_ID).catch(() => {
		duplicate = true;
	});
	assertEquals(duplicate, true);

	let rejected = false;
	await automod.create(guildId, {
		name: "bad regex",
		type: "regex",
		config: { pattern: "(a+)+" },
	}, MOD_ID).catch(() => {
		rejected = true;
	});
	assertEquals(rejected, true);

	assertEquals((await automod.list(guildId)).length, 1);
	await automod.toggle(guildId, "shout", false);
	assertEquals(await automod.evaluate(message(guildId)), null);
	await automod.delete(guildId, "shout");
	assertEquals((await automod.list(guildId)).length, 0);
});
