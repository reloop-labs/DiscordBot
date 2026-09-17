import type { DiscordApi } from "../adapters/discord-api.ts";
import { decodeCustomId } from "../interactions/custom-id.ts";
import { LOG_COLORS } from "../logging/discord-log.ts";
import type {
	RoleMenu,
	RoleMenuService,
	RoleMenuStyle,
} from "../../domains/roles/role-menu-service.ts";
import type { PermissionService } from "../../permissions/service.ts";
import { ValidationFailed } from "../../shared/errors.ts";
import { channelMention, roleMention, truncate } from "../../shared/text.ts";
import type { CommandDefinition } from "./registry.ts";
import {
	actorOf,
	bool,
	channel,
	int,
	requireSubcommand,
	role,
	slash,
	str,
	sub,
} from "./helpers.ts";

export interface RoleMenuDeps {
	api: DiscordApi;
	roleMenus: RoleMenuService;
	permissions: PermissionService;
}

const nameOption = (description: string) =>
	str("name", description, { required: true, autocomplete: true });

function summary(menu: RoleMenu): string {
	const bits: string[] = [menu.style];
	if (menu.exclusive) bits.push("exclusive");
	if (menu.maxSelections) bits.push(`max ${menu.maxSelections}`);
	if (menu.requiredRoleId) bits.push(`requires ${roleMention(menu.requiredRoleId)}`);
	if (menu.channelId) bits.push(`published in ${channelMention(menu.channelId)}`);
	return `**${menu.name}** · ${bits.join(" · ")}`;
}

export function roleMenuCommands(deps: RoleMenuDeps): CommandDefinition[] {
	const { api, roleMenus, permissions } = deps;

	const handle: CommandDefinition["handle"] = async (ctx) => {
		await ctx.defer(true);
		const actor = await actorOf(api, ctx);
		await permissions.require(actor.actor, "roles.manage");
		const command = requireSubcommand(ctx);

		switch (command) {
			case "create": {
				const menu = await roleMenus.create(ctx.guildId, {
					name: ctx.requireString("name"),
					title: ctx.requireString("title"),
					body: ctx.string("body") ?? null,
					style: (ctx.string("style") ?? "buttons") as RoleMenuStyle,
					exclusive: ctx.boolean("exclusive") ?? false,
					maxSelections: ctx.integer("max") ?? null,
					requiredRoleId: ctx.roleOption("required_role") ?? null,
				}, ctx.userId);
				await ctx.reply(
					`Created \`${menu.name}\`. Add roles with \`/rolemenu add-option\`, then publish it.`,
				);
				return;
			}
			case "delete": {
				await roleMenus.delete(ctx.guildId, ctx.requireString("name"), ctx.userId);
				await ctx.reply("Role menu deleted.");
				return;
			}
			case "list": {
				const menus = await roleMenus.list(ctx.guildId);
				await ctx.reply({
					embeds: [{
						title: "Role menus",
						color: LOG_COLORS.neutral,
						description: menus.length
							? menus.map(summary).join("\n")
							: "No role menus yet. Create one with `/rolemenu create`.",
					}],
				});
				return;
			}
			case "add-option": {
				const conflicts = ctx.roleOption("conflicts_with");
				const option = await roleMenus.addOption(ctx.guildId, ctx.requireString("name"), {
					roleId: ctx.roleOption("role")!,
					label: ctx.requireString("label"),
					description: ctx.string("description") ?? null,
					emoji: ctx.string("emoji") ?? null,
					requiresRoleId: ctx.roleOption("requires_role") ?? null,
					conflictsWithRoleIds: conflicts ? [conflicts] : [],
				}, ctx.userId);
				await roleMenus.refresh(ctx.guildId, ctx.requireString("name"));
				await ctx.reply(`Added ${roleMention(option.roleId)} as **${option.label}**.`);
				return;
			}
			case "remove-option": {
				const name = ctx.requireString("name");
				await roleMenus.removeOption(ctx.guildId, name, ctx.roleOption("role")!, ctx.userId);
				await roleMenus.refresh(ctx.guildId, name);
				await ctx.reply("Option removed.");
				return;
			}
			case "edit": {
				const name = ctx.requireString("name");
				const title = ctx.string("title");
				const body = ctx.string("body");
				const exclusive = ctx.boolean("exclusive");
				const max = ctx.integer("max");
				const menu = await roleMenus.update(ctx.guildId, name, {
					...(title !== undefined ? { title } : {}),
					...(body !== undefined ? { body } : {}),
					...(exclusive !== undefined ? { exclusive } : {}),
					...(max !== undefined ? { maxSelections: max } : {}),
				}, ctx.userId);
				await roleMenus.refresh(ctx.guildId, name);
				await ctx.reply(`Updated ${summary(menu)}`);
				return;
			}
			case "publish": {
				const channelId = ctx.channelOption("channel") ?? ctx.channelId;
				if (!channelId) throw new ValidationFailed("Pick a channel.");
				await roleMenus.publish(ctx.guildId, ctx.requireString("name"), channelId, ctx.userId);
				await ctx.reply(`Published to ${channelMention(channelId)}.`);
				return;
			}
			case "refresh": {
				const refreshed = await roleMenus.refresh(ctx.guildId, ctx.requireString("name"));
				await ctx.reply(refreshed ? "Menu message updated." : "That menu has not been published.");
				return;
			}
		}
	};

	return [
		{
			name: "rolemenu",
			definition: slash("rolemenu", "Self-assignable role menus", [
				sub("create", "Create a role menu", [
					str("name", "Short name used in commands", { required: true, maxLength: 32 }),
					str("title", "Title shown on the menu", { required: true, maxLength: 256 }),
					str("body", "Text under the title", { maxLength: 2000 }),
					str("style", "How members pick roles", {
						choices: [
							{ name: "buttons", value: "buttons" },
							{ name: "select", value: "select" },
						],
					}),
					bool("exclusive", "Only one role from this menu at a time"),
					int("max", "Most roles a member can hold from this menu", {
						minValue: 1,
						maxValue: 25,
					}),
					role("required_role", "Role needed to use this menu"),
				]),
				sub("delete", "Delete a role menu", [nameOption("Menu to delete")]),
				sub("list", "List this server's role menus"),
				sub("add-option", "Add a role to a menu", [
					nameOption("Menu to add to"),
					role("role", "Role members can take", { required: true }),
					str("label", "Button or option label", { required: true, maxLength: 80 }),
					str("description", "Shown next to the option", { maxLength: 100 }),
					str("emoji", "Emoji shown on the option"),
					role("requires_role", "Role a member must already have"),
					role("conflicts_with", "Role that cannot be held alongside this one"),
				]),
				sub("remove-option", "Remove a role from a menu", [
					nameOption("Menu to edit"),
					role("role", "Role to remove", { required: true }),
				]),
				sub("edit", "Change a menu's text or limits", [
					nameOption("Menu to edit"),
					str("title", "New title", { maxLength: 256 }),
					str("body", "New body text", { maxLength: 2000 }),
					bool("exclusive", "Only one role from this menu at a time"),
					int("max", "Most roles a member can hold from this menu", {
						minValue: 1,
						maxValue: 25,
					}),
				]),
				sub("publish", "Post the menu to a channel", [
					nameOption("Menu to publish"),
					channel("channel", "Channel to post in"),
				]),
				sub("refresh", "Update the published menu message", [nameOption("Menu to refresh")]),
			], { defaultMemberPermissions: ["MANAGE_ROLES"] }),
			autocomplete: async (ctx) => {
				const focused = (ctx.string("name") ?? "").toLowerCase();
				const menus = await roleMenus.list(ctx.guildId);
				await ctx.interaction.respond({
					choices: menus
						.filter((menu) => menu.name.includes(focused))
						.slice(0, 25)
						.map((menu) => ({ name: menu.name, value: menu.name })),
				});
			},
			handle,
			components: [{
				domain: "rolemenu",
				handle: async (ctx) => {
					await ctx.defer(true);
					const decoded = decodeCustomId(ctx.customId);
					if (!decoded) throw new ValidationFailed("That menu is no longer available.");
					const menuId = decoded.args[0];
					if (!menuId) throw new ValidationFailed("That menu is no longer available.");
					const selected = decoded.action === "toggle"
						? [BigInt(decoded.args[1]!)]
						: ctx.selectedValues.map(BigInt);
					const result = await roleMenus.applySelection(
						ctx.guildId,
						ctx.userId,
						menuId,
						selected,
						decoded.action === "toggle" ? "toggle" : "set",
					);
					const parts: string[] = [];
					if (result.added.length) {
						parts.push(`Added ${result.added.map(roleMention).join(" ")}`);
					}
					if (result.removed.length) {
						parts.push(`Removed ${result.removed.map(roleMention).join(" ")}`);
					}
					await ctx.reply(parts.length ? truncate(parts.join(", "), 2000) : "Nothing changed.");
				},
			}],
		},
	];
}
