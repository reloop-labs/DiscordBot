import { assertEquals, assertRejects } from "@std/assert";
import { DiscordLogService } from "../../src/discord/logging/discord-log.ts";
import { AuditService } from "../../src/domains/audit/service.ts";
import { GuildConfigService } from "../../src/domains/guild-config/service.ts";
import { CaseService } from "../../src/domains/moderation/case-service.ts";
import { ModerationService } from "../../src/domains/moderation/moderation-service.ts";
import { silentLogger } from "../../src/logging/logger.ts";
import { resolveActor } from "../../src/permissions/actor.ts";
import { PermissionService } from "../../src/permissions/service.ts";
import { HierarchyViolation, PermissionDenied } from "../../src/shared/errors.ts";
import { dbTest } from "../helpers/database.ts";
import {
	FakeDiscordApi,
	member,
	MOD_ID,
	MOD_ROLE,
	OWNER_ID,
	TARGET_ID,
} from "../helpers/fake-discord.ts";

async function setup(db: Parameters<Parameters<typeof dbTest>[1]>[0], guildId: bigint) {
	const api = new FakeDiscordApi();
	api.guildSnapshot.id = guildId;
	for (const m of api.members.values()) m.guildId = guildId;
	const config = new GuildConfigService(db);
	const permissions = new PermissionService(db);
	const cases = new CaseService(db);
	const moderation = new ModerationService(
		api,
		cases,
		permissions,
		config,
		new DiscordLogService(api, config, silentLogger),
		silentLogger,
	);
	void new AuditService(db, silentLogger);
	await permissions.grant(guildId, MOD_ROLE, "moderation.warn", OWNER_ID);
	await permissions.grant(guildId, MOD_ROLE, "moderation.timeout", OWNER_ID);
	await permissions.grant(guildId, MOD_ROLE, "moderation.kick", OWNER_ID);
	const actor = await resolveActor(api, guildId, MOD_ID);
	const target = {
		userId: TARGET_ID,
		username: "target",
		member: api.members.get(String(TARGET_ID))!,
	};
	return { api, cases, moderation, actor, target, permissions };
}

dbTest("warn creates a case and DMs the user", async (db, guildId) => {
	const { moderation, actor, target, api } = await setup(db, guildId);
	const result = await moderation.warn({ actor, target, reason: "be nice" });
	assertEquals(result.case.caseNumber, 1);
	assertEquals(result.dmDelivered, true);
	assertEquals(api.dms.length, 1);
	assertEquals(api.dms[0]!.message.content?.includes("Case #1"), true);
});

dbTest("a failed DM does not fail the action", async (db, guildId) => {
	const { moderation, actor, target, api, cases } = await setup(db, guildId);
	api.dmFails.add(String(TARGET_ID));
	const result = await moderation.kick({ actor, target, reason: null });
	assertEquals(result.dmDelivered, false);
	assertEquals(api.calledWith("kickMember").length, 1);
	assertEquals((await cases.getByNumber(guildId, result.case.caseNumber)).dmDelivered, "failed");
});

dbTest("missing internal permission is denied before any discord call", async (db, guildId) => {
	const { moderation, actor, target, api } = await setup(db, guildId);
	await assertRejects(() => moderation.ban({ actor, target, reason: null }), PermissionDenied);
	assertEquals(api.calledWith("banMember").length, 0);
});

dbTest("hierarchy stops moderating an equal role", async (db, guildId) => {
	const { moderation, actor, api } = await setup(db, guildId);
	const peer = member(TARGET_ID, [MOD_ROLE]);
	api.members.set(String(TARGET_ID), peer);
	await assertRejects(
		() =>
			moderation.warn({
				actor,
				target: { userId: TARGET_ID, username: "peer", member: peer },
				reason: null,
			}),
		HierarchyViolation,
	);
});

dbTest("discord rejection voids the created case", async (db, guildId) => {
	const { moderation, actor, target, api, cases } = await setup(db, guildId);
	api.failNext = { method: "timeoutMember", error: new Error("discord down") };
	await assertRejects(() =>
		moderation.timeout({ actor, target, reason: null, durationMs: 60_000 })
	);
	const history = await cases.historyFor(guildId, TARGET_ID);
	assertEquals(history.length, 1);
	assertEquals(history[0]!.status, "voided");
});

dbTest("timeout duration is validated", async (db, guildId) => {
	const { moderation, actor, target } = await setup(db, guildId);
	await assertRejects(() => moderation.timeout({ actor, target, reason: null, durationMs: 0 }));
	await assertRejects(() =>
		moderation.timeout({ actor, target, reason: null, durationMs: 29 * 86_400_000 })
	);
});
