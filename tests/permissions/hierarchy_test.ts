import { assertEquals, assertThrows } from "@std/assert";
import { BitwisePermissionFlags } from "@discordeno/bot";
import {
	assertCanManageRole,
	assertCanModerate,
	basePermissions,
	highestRolePosition,
} from "../../src/permissions/hierarchy.ts";
import { BotMissingPermission, HierarchyViolation } from "../../src/shared/errors.ts";
import {
	ADMIN_ROLE,
	BOT_ID,
	BOT_ROLE,
	guild,
	member,
	MEMBER_ROLE,
	MOD_ID,
	MOD_ROLE,
	OWNER_ID,
	TARGET_ID,
} from "../helpers/fake-discord.ts";

const g = guild();
const bot = member(BOT_ID, [BOT_ROLE]);
const mod = member(MOD_ID, [MOD_ROLE]);
const base = {
	guild: g,
	actor: mod,
	bot,
	requiredBotPermission: BitwisePermissionFlags.BAN_MEMBERS,
	requiredBotPermissionName: "Ban Members",
};

Deno.test("owner and administrators get all permissions", () => {
	assertEquals(basePermissions(g, member(OWNER_ID, [])), ~0n);
	assertEquals(basePermissions(g, member(TARGET_ID, [ADMIN_ROLE])), ~0n);
	assertEquals(basePermissions(g, member(TARGET_ID, [MEMBER_ROLE])), 0n);
});

Deno.test("highest role position", () => {
	assertEquals(highestRolePosition(g, [MEMBER_ROLE, MOD_ROLE]), 5);
	assertEquals(highestRolePosition(g, []), 0);
});

Deno.test("moderator can act on a lower member", () => {
	assertCanModerate({ ...base, target: member(TARGET_ID, [MEMBER_ROLE]), targetUserId: TARGET_ID });
});

Deno.test("self, bot and owner are protected", () => {
	assertThrows(
		() => assertCanModerate({ ...base, target: mod, targetUserId: MOD_ID }),
		HierarchyViolation,
	);
	assertThrows(
		() => assertCanModerate({ ...base, target: bot, targetUserId: BOT_ID }),
		HierarchyViolation,
	);
	assertThrows(
		() => assertCanModerate({ ...base, target: member(OWNER_ID, []), targetUserId: OWNER_ID }),
		HierarchyViolation,
	);
});

Deno.test("equal or higher target role blocks the actor", () => {
	assertThrows(
		() =>
			assertCanModerate({
				...base,
				target: member(TARGET_ID, [MOD_ROLE]),
				targetUserId: TARGET_ID,
			}),
		HierarchyViolation,
	);
	assertThrows(
		() =>
			assertCanModerate({
				...base,
				target: member(TARGET_ID, [ADMIN_ROLE]),
				targetUserId: TARGET_ID,
			}),
		HierarchyViolation,
	);
});

Deno.test("owner actor bypasses role position but not bot hierarchy", () => {
	const owner = member(OWNER_ID, []);
	assertCanModerate({
		...base,
		actor: owner,
		target: member(TARGET_ID, [MOD_ROLE]),
		targetUserId: TARGET_ID,
	});
	assertThrows(
		() =>
			assertCanModerate({
				...base,
				actor: owner,
				target: member(TARGET_ID, [ADMIN_ROLE]),
				targetUserId: TARGET_ID,
			}),
		HierarchyViolation,
	);
});

Deno.test("bot without the discord permission is rejected", () => {
	assertThrows(
		() =>
			assertCanModerate({
				...base,
				bot: member(BOT_ID, [MEMBER_ROLE]),
				target: member(TARGET_ID, [MEMBER_ROLE]),
				targetUserId: TARGET_ID,
			}),
		BotMissingPermission,
	);
});

Deno.test("users who left can still be banned when no member snapshot exists", () => {
	assertCanModerate({ ...base, target: null, targetUserId: TARGET_ID });
});

Deno.test("role management respects bot position and managed roles", () => {
	assertCanManageRole(g, bot, MEMBER_ROLE);
	assertThrows(() => assertCanManageRole(g, bot, ADMIN_ROLE), HierarchyViolation);
	assertThrows(() => assertCanManageRole(g, bot, g.id), HierarchyViolation);
});
