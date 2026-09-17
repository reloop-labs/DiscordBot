import { assertEquals } from "@std/assert";
import { and, eq } from "drizzle-orm";
import { memberPersistedRoles } from "../../src/database/schema/index.ts";
import { DiscordLogService } from "../../src/discord/logging/discord-log.ts";
import { GuildConfigService } from "../../src/domains/guild-config/service.ts";
import { MemberService } from "../../src/domains/members/member-service.ts";
import { silentLogger } from "../../src/logging/logger.ts";
import { dbTest } from "../helpers/database.ts";
import {
	ADMIN_ROLE,
	FakeDiscordApi,
	member,
	MEMBER_ROLE,
	MOD_ROLE,
	TARGET_ID,
} from "../helpers/fake-discord.ts";

const WELCOME_CHANNEL = 500000000000000001n;
const LEAVE_CHANNEL = 500000000000000002n;

function setup(db: Parameters<Parameters<typeof dbTest>[1]>[0], guildId: bigint) {
	const api = new FakeDiscordApi();
	api.guildSnapshot.id = guildId;
	for (const m of api.members.values()) m.guildId = guildId;
	const config = new GuildConfigService(db);
	const members = new MemberService(
		api,
		db,
		config,
		new DiscordLogService(api, config, silentLogger),
		silentLogger,
	);
	const joining = { ...member(TARGET_ID, []), guildId, username: "newbie" };
	return { api, config, members, joining };
}

function persisted(db: Parameters<Parameters<typeof dbTest>[1]>[0], guildId: bigint) {
	return db
		.select()
		.from(memberPersistedRoles)
		.where(
			and(
				eq(memberPersistedRoles.guildId, guildId),
				eq(memberPersistedRoles.userId, TARGET_ID),
			),
		);
}

dbTest("join assigns the configured member role", async (db, guildId) => {
	const { api, config, members, joining } = setup(db, guildId);
	await config.update(guildId, { memberRoleId: MEMBER_ROLE });
	await members.onJoin(joining, false);
	assertEquals(api.calledWith("addRole").map((call) => call.args[2]), [MEMBER_ROLE]);
});

dbTest("a member role above Loop is skipped without throwing", async (db, guildId) => {
	const { api, config, members, joining } = setup(db, guildId);
	await config.update(guildId, { memberRoleId: ADMIN_ROLE });
	await members.onJoin(joining, false);
	assertEquals(api.calledWith("addRole").length, 0);
});

dbTest("persisted roles are restored and the row is deleted", async (db, guildId) => {
	const { api, config, members, joining } = setup(db, guildId);
	await config.update(guildId, { persistRoles: true });
	await db.insert(memberPersistedRoles).values({
		guildId,
		userId: TARGET_ID,
		roleIds: [MEMBER_ROLE, MOD_ROLE],
	});
	await members.onJoin(joining, false);
	assertEquals(api.calledWith("addRole").map((call) => call.args[2]), [MEMBER_ROLE, MOD_ROLE]);
	assertEquals((await persisted(db, guildId)).length, 0);
});

dbTest("welcome placeholders are rendered", async (db, guildId) => {
	const { api, config, members, joining } = setup(db, guildId);
	await config.update(guildId, {
		welcomeChannelId: WELCOME_CHANNEL,
		welcomeMessage: "{user} ({username}) joined {server} — member {membercount}",
	});
	await members.onJoin(joining, false, 42);
	const sent = api.sentMessages.at(-1)!;
	assertEquals(sent.channelId, WELCOME_CHANNEL);
	assertEquals(sent.message.content, `<@${TARGET_ID}> (newbie) joined Reloop — member 42`);
});

dbTest("the default welcome text is used when none is set", async (db, guildId) => {
	const { api, config, members, joining } = setup(db, guildId);
	await config.update(guildId, { welcomeChannelId: WELCOME_CHANNEL });
	await members.onJoin(joining, false);
	assertEquals(api.sentMessages.at(-1)!.message.content, `Welcome <@${TARGET_ID}> to Reloop!`);
});

dbTest("a failed welcome message does not fail the join", async (db, guildId) => {
	const { api, config, members, joining } = setup(db, guildId);
	await config.update(guildId, { welcomeChannelId: WELCOME_CHANNEL, memberRoleId: MEMBER_ROLE });
	api.failNext = { method: "sendMessage", error: new Error("missing access") };
	await members.onJoin(joining, false);
	assertEquals(api.calledWith("addRole").length, 1);
	assertEquals(api.sentMessages.length, 0);
});

dbTest("leaving persists roles when the setting is on", async (db, guildId) => {
	const { api, config, members } = setup(db, guildId);
	await config.update(guildId, { persistRoles: true, leaveChannelId: LEAVE_CHANNEL });
	await members.onLeave(guildId, TARGET_ID, "newbie", [guildId, MEMBER_ROLE, MOD_ROLE]);
	const [row] = await persisted(db, guildId);
	assertEquals(row?.roleIds, [MEMBER_ROLE, MOD_ROLE]);
	assertEquals(api.sentMessages.at(-1)!.message.content, "newbie left.");
});

dbTest("leaving persists nothing when the setting is off", async (db, guildId) => {
	const { members } = setup(db, guildId);
	await members.onLeave(guildId, TARGET_ID, "newbie", [MEMBER_ROLE]);
	assertEquals((await persisted(db, guildId)).length, 0);
});

dbTest("role and nickname changes are logged", async (db, guildId) => {
	const { api, config, members, joining } = setup(db, guildId);
	await config.setLogChannel(guildId, "members", LEAVE_CHANNEL);
	await members.onUpdate(null, joining);
	assertEquals(api.sentMessages.length, 0);
	await members.onUpdate(
		{ nick: null, roleIds: [MOD_ROLE] },
		{ ...joining, nick: "newb", roleIds: [MEMBER_ROLE] },
	);
	const embed = api.sentMessages.at(-1)!.message.embeds![0]!;
	assertEquals(embed.title, "Member updated");
	assertEquals(embed.fields?.length, 3);
});

dbTest("joins are cached so a leave can persist the roles", async (db, guildId) => {
	const { config, members, joining } = setup(db, guildId);
	await config.update(guildId, { persistRoles: true });
	await members.onJoin({ ...joining, roleIds: [MEMBER_ROLE] }, false);
	assertEquals(members.cached(guildId, TARGET_ID)?.roleIds, [MEMBER_ROLE]);
	await members.onLeave(
		guildId,
		TARGET_ID,
		"newbie",
		members.cached(guildId, TARGET_ID)?.roleIds ?? null,
	);
	const [row] = await persisted(db, guildId);
	assertEquals(row?.roleIds, [MEMBER_ROLE]);
	assertEquals(members.cached(guildId, TARGET_ID), null);
});
