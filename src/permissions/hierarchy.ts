import { BitwisePermissionFlags } from "@discordeno/bot";
import type { GuildSnapshot, MemberSnapshot } from "../discord/adapters/discord-api.ts";
import { BotMissingPermission, HierarchyViolation } from "../shared/errors.ts";

export const ADMINISTRATOR = BigInt(BitwisePermissionFlags.ADMINISTRATOR);

export function basePermissions(
	guild: GuildSnapshot,
	member: Pick<MemberSnapshot, "userId" | "roleIds">,
): bigint {
	if (member.userId === guild.ownerId) return ~0n;
	const everyone = guild.roles.find((role) => role.id === guild.id);
	let bits = everyone?.permissions ?? 0n;
	const held = new Set(member.roleIds.map(String));
	for (const role of guild.roles) {
		if (held.has(String(role.id))) bits |= role.permissions;
	}
	if ((bits & ADMINISTRATOR) === ADMINISTRATOR) return ~0n;
	return bits;
}

export function hasDiscordPermission(bits: bigint, flag: bigint | number): boolean {
	const value = BigInt(flag);
	return (bits & value) === value;
}

export function highestRolePosition(guild: GuildSnapshot, roleIds: bigint[]): number {
	const held = new Set(roleIds.map(String));
	let highest = 0;
	for (const role of guild.roles) {
		if (held.has(String(role.id)) && role.position > highest) highest = role.position;
	}
	return highest;
}

export interface HierarchyCheck {
	guild: GuildSnapshot;
	actor: Pick<MemberSnapshot, "userId" | "roleIds">;
	bot: Pick<MemberSnapshot, "userId" | "roleIds">;
	target: Pick<MemberSnapshot, "userId" | "roleIds" | "isBot"> | null;
	targetUserId: bigint;
	requiredBotPermission: bigint | number;
	requiredBotPermissionName: string;
}

export function assertCanModerate(check: HierarchyCheck): void {
	const { guild, actor, bot, target, targetUserId } = check;
	if (targetUserId === actor.userId) throw new HierarchyViolation("You cannot moderate yourself.");
	if (targetUserId === bot.userId) throw new HierarchyViolation("Loop cannot moderate itself.");
	if (targetUserId === guild.ownerId) {
		throw new HierarchyViolation("The server owner cannot be moderated.");
	}
	const botPermissions = basePermissions(guild, bot);
	if (!hasDiscordPermission(botPermissions, check.requiredBotPermission)) {
		throw new BotMissingPermission(check.requiredBotPermissionName);
	}
	if (!target) return;
	const actorIsOwner = actor.userId === guild.ownerId;
	const actorTop = highestRolePosition(guild, actor.roleIds);
	const botTop = highestRolePosition(guild, bot.roleIds);
	const targetTop = highestRolePosition(guild, target.roleIds);
	if (!actorIsOwner && actorTop <= targetTop) {
		throw new HierarchyViolation(
			"You cannot moderate someone with an equal or higher role than yours.",
		);
	}
	if (botTop <= targetTop) {
		throw new HierarchyViolation("Loop's role must be above the target's highest role.");
	}
}

export function assertCanManageRole(
	guild: GuildSnapshot,
	bot: Pick<MemberSnapshot, "userId" | "roleIds">,
	roleId: bigint,
): void {
	const role = guild.roles.find((r) => r.id === roleId);
	if (!role) throw new HierarchyViolation("That role no longer exists.");
	if (role.managed) {
		throw new HierarchyViolation("That role is managed by an integration and cannot be assigned.");
	}
	if (role.id === guild.id) throw new HierarchyViolation("The @everyone role cannot be assigned.");
	const botPermissions = basePermissions(guild, bot);
	if (!hasDiscordPermission(botPermissions, BitwisePermissionFlags.MANAGE_ROLES)) {
		throw new BotMissingPermission("Manage Roles");
	}
	if (bot.userId !== guild.ownerId && highestRolePosition(guild, bot.roleIds) <= role.position) {
		throw new HierarchyViolation(`Loop's role must be above **${role.name}** to assign it.`);
	}
}
