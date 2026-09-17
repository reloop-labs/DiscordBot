import { assertEquals, assertRejects } from "@std/assert";
import { AuditService } from "../../src/domains/audit/service.ts";
import { RoleMenuService } from "../../src/domains/roles/role-menu-service.ts";
import { silentLogger } from "../../src/logging/logger.ts";
import { HierarchyViolation, ValidationFailed } from "../../src/shared/errors.ts";
import { dbTest } from "../helpers/database.ts";
import {
	ADMIN_ROLE,
	FakeDiscordApi,
	MEMBER_ROLE,
	MOD_ROLE,
	OWNER_ID,
	role,
	TARGET_ID,
} from "../helpers/fake-discord.ts";

const CHANNEL_ID = 400000000000000001n;
const GREEN_ROLE = 200000000000000101n;

function setup(db: Parameters<Parameters<typeof dbTest>[1]>[0], guildId: bigint) {
	const api = new FakeDiscordApi();
	api.guildSnapshot.id = guildId;
	api.guildSnapshot.roles.push(role(GREEN_ROLE, "Green", 2));
	for (const m of api.members.values()) m.guildId = guildId;
	const roleMenus = new RoleMenuService(api, db, new AuditService(db, silentLogger), silentLogger);
	return { api, roleMenus };
}

dbTest("a menu is created, filled, published and used", async (db, guildId) => {
	const { api, roleMenus } = setup(db, guildId);
	await roleMenus.create(guildId, {
		name: "Colours",
		title: "Pick a colour",
		style: "buttons",
		exclusive: true,
	}, OWNER_ID);
	await roleMenus.addOption(guildId, "colours", {
		roleId: MEMBER_ROLE,
		label: "Member",
	}, OWNER_ID);
	await roleMenus.addOption(guildId, "colours", {
		roleId: GREEN_ROLE,
		label: "Green",
		emoji: "🟢",
	}, OWNER_ID);

	const messageId = await roleMenus.publish(guildId, "colours", CHANNEL_ID, OWNER_ID);
	const posted = api.sentMessages.at(-1)!;
	assertEquals(posted.channelId, CHANNEL_ID);
	assertEquals(posted.message.components?.length, 1);

	const { menu, options } = await roleMenus.get(guildId, "colours");
	assertEquals(menu.messageId, messageId);
	assertEquals(options.length, 2);

	const target = api.members.get(String(TARGET_ID))!;
	target.roleIds = [MEMBER_ROLE];
	const result = await roleMenus.applySelection(
		guildId,
		TARGET_ID,
		menu.id,
		[GREEN_ROLE],
		"toggle",
	);
	assertEquals(result.added, [GREEN_ROLE]);
	assertEquals(result.removed, [MEMBER_ROLE]);
	assertEquals(target.roleIds, [GREEN_ROLE]);

	assertEquals(await roleMenus.refresh(guildId, "colours"), true);
	assertEquals(api.calledWith("editMessage").length, 1);
});

dbTest("select style menus replace the member's menu roles", async (db, guildId) => {
	const { api, roleMenus } = setup(db, guildId);
	const menu = await roleMenus.create(guildId, {
		name: "pings",
		title: "Ping roles",
		style: "select",
		exclusive: false,
	}, OWNER_ID);
	await roleMenus.addOption(guildId, "pings", { roleId: MEMBER_ROLE, label: "Member" }, OWNER_ID);
	await roleMenus.addOption(guildId, "pings", { roleId: GREEN_ROLE, label: "Green" }, OWNER_ID);
	await roleMenus.addOption(guildId, "pings", { roleId: MOD_ROLE, label: "Mod" }, OWNER_ID);

	const target = api.members.get(String(TARGET_ID))!;
	target.roleIds = [MEMBER_ROLE, MOD_ROLE];
	const result = await roleMenus.applySelection(guildId, TARGET_ID, menu.id, [GREEN_ROLE], "set");
	assertEquals(result.added, [GREEN_ROLE]);
	assertEquals(result.removed.sort(), [MEMBER_ROLE, MOD_ROLE].sort());
	assertEquals(target.roleIds, [GREEN_ROLE]);
	assertEquals(api.calledWith("setRoles").length, 1);
});

dbTest("a role above Loop cannot be added to a menu", async (db, guildId) => {
	const { roleMenus } = setup(db, guildId);
	await roleMenus.create(guildId, {
		name: "staff",
		title: "Staff",
		style: "buttons",
		exclusive: false,
	}, OWNER_ID);
	await assertRejects(
		() => roleMenus.addOption(guildId, "staff", { roleId: ADMIN_ROLE, label: "Admin" }, OWNER_ID),
		HierarchyViolation,
	);
});

dbTest("menu names are unique per guild", async (db, guildId) => {
	const { roleMenus } = setup(db, guildId);
	const input = { name: "dupe", title: "Dupe", style: "buttons" as const, exclusive: false };
	await roleMenus.create(guildId, input, OWNER_ID);
	await assertRejects(() => roleMenus.create(guildId, input, OWNER_ID), ValidationFailed);
	assertEquals((await roleMenus.list(guildId)).length, 1);
	await roleMenus.delete(guildId, "dupe", OWNER_ID);
	assertEquals((await roleMenus.list(guildId)).length, 0);
});
