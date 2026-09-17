import { ButtonStyles, MessageComponentTypes } from "@discordeno/bot";
import type { ActionRow, ButtonComponent, MessageComponents } from "@discordeno/bot";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../../database/client.ts";
import { roleMenuOptions, roleMenus } from "../../database/schema/index.ts";
import type { DiscordApi, OutboundMessage } from "../../discord/adapters/discord-api.ts";
import { LOG_COLORS } from "../../discord/logging/discord-log.ts";
import { encodeCustomId } from "../../discord/interactions/custom-id.ts";
import type { Logger } from "../../logging/logger.ts";
import { assertCanManageRole } from "../../permissions/hierarchy.ts";
import { MemberNotFound, NotFound, ValidationFailed } from "../../shared/errors.ts";
import { roleMention, truncate } from "../../shared/text.ts";
import type { AuditService } from "../audit/service.ts";

export type RoleMenu = typeof roleMenus.$inferSelect;
export type RoleMenuOption = typeof roleMenuOptions.$inferSelect;
export type RoleMenuStyle = RoleMenu["style"];

export const MAX_OPTIONS = 25;
export const MAX_LABEL = 80;

export interface CreateMenuInput {
	name: string;
	title: string;
	body?: string | null;
	style: RoleMenuStyle;
	exclusive: boolean;
	maxSelections?: number | null;
	requiredRoleId?: bigint | null;
}

export interface AddOptionInput {
	roleId: bigint;
	label: string;
	description?: string | null;
	emoji?: string | null;
	requiresRoleId?: bigint | null;
	conflictsWithRoleIds?: bigint[];
}

export interface MenuPatch {
	title?: string;
	body?: string | null;
	exclusive?: boolean;
	maxSelections?: number | null;
}

export interface SelectionMenu {
	exclusive: boolean;
	maxSelections: number | null;
	requiredRoleId: bigint | null;
}

export interface SelectionOption {
	roleId: bigint;
	requiresRoleId: bigint | null;
	conflictsWithRoleIds: bigint[];
}

export interface SelectionInput {
	menu: SelectionMenu;
	options: SelectionOption[];
	memberRoleIds: bigint[];
	selected: bigint[];
	mode: "toggle" | "set";
	assertManageable?: (roleId: bigint) => void;
}

export interface SelectionResult {
	added: bigint[];
	removed: bigint[];
}

export function resolveSelection(input: SelectionInput): SelectionResult {
	const { menu, options, mode } = input;
	const held = new Set(input.memberRoleIds.map(String));
	if (menu.requiredRoleId && !held.has(String(menu.requiredRoleId))) {
		throw new ValidationFailed(
			`You need the ${roleMention(menu.requiredRoleId)} role to use this menu.`,
		);
	}
	const byRole = new Map(options.map((option) => [String(option.roleId), option]));
	for (const roleId of input.selected) {
		if (!byRole.has(String(roleId))) throw new ValidationFailed("That role is not in this menu.");
	}
	const current = options.filter((option) => held.has(String(option.roleId))).map((o) => o.roleId);
	const currentSet = new Set(current.map(String));

	let desired: Set<string>;
	if (mode === "toggle") {
		if (input.selected.length !== 1) throw new ValidationFailed("Pick exactly one role.");
		const roleId = String(input.selected[0]);
		desired = new Set(currentSet);
		if (desired.has(roleId)) desired.delete(roleId);
		else desired.add(roleId);
	} else {
		desired = new Set(input.selected.map(String));
	}

	let newlyAdded = [...desired].filter((roleId) => !currentSet.has(roleId));
	if (menu.exclusive && newlyAdded.length > 1) {
		throw new ValidationFailed("This menu only allows one role at a time.");
	}
	if (menu.exclusive && newlyAdded.length === 1) desired = new Set(newlyAdded);
	if (menu.maxSelections !== null && newlyAdded.length > 0 && desired.size > menu.maxSelections) {
		throw new ValidationFailed(
			`You can hold at most ${menu.maxSelections} role${menu.maxSelections === 1 ? "" : "s"} ` +
				"from this menu.",
		);
	}

	newlyAdded = [...desired].filter((roleId) => !currentSet.has(roleId));
	const removedKeys = [...currentSet].filter((roleId) => !desired.has(roleId));
	const finalHeld = new Set(held);
	for (const roleId of removedKeys) finalHeld.delete(roleId);
	for (const roleId of newlyAdded) finalHeld.add(roleId);

	for (const roleId of newlyAdded) {
		const option = byRole.get(roleId)!;
		if (option.requiresRoleId && !finalHeld.has(String(option.requiresRoleId))) {
			throw new ValidationFailed(
				`You need the ${roleMention(option.requiresRoleId)} role before taking that one.`,
			);
		}
		const conflict = option.conflictsWithRoleIds.find((id) => finalHeld.has(String(id)));
		if (conflict !== undefined) {
			throw new ValidationFailed(
				`That role cannot be combined with ${roleMention(conflict)}.`,
			);
		}
	}

	const assertManageable = input.assertManageable;
	if (assertManageable) {
		for (const roleId of [...newlyAdded, ...removedKeys]) assertManageable(BigInt(roleId));
	}
	return {
		added: newlyAdded.map(BigInt),
		removed: removedKeys.map(BigInt),
	};
}

function parseEmoji(
	emoji: string | null,
): { id?: bigint; name?: string; animated?: boolean } | null {
	if (!emoji) return null;
	const custom = /^<(a?):([\w~]+):(\d+)>$/.exec(emoji.trim());
	if (custom) return { id: BigInt(custom[3]!), name: custom[2]!, animated: custom[1] === "a" };
	return { name: emoji.trim() };
}

export class RoleMenuService {
	constructor(
		private readonly api: DiscordApi,
		private readonly db: Database,
		private readonly audit: AuditService,
		private readonly logger: Logger,
	) {}

	async create(guildId: bigint, input: CreateMenuInput, actorId: bigint): Promise<RoleMenu> {
		const name = normalizeName(input.name);
		const [row] = await this.db
			.insert(roleMenus)
			.values({
				guildId,
				name,
				title: truncate(input.title.trim(), 256),
				body: input.body?.trim() || null,
				style: input.style,
				exclusive: input.exclusive,
				maxSelections: input.maxSelections ?? null,
				requiredRoleId: input.requiredRoleId ?? null,
			})
			.onConflictDoNothing()
			.returning();
		if (!row) throw new ValidationFailed(`A role menu called \`${name}\` already exists.`);
		await this.audit.record({
			guildId,
			actorId,
			action: "rolemenu.create",
			target: name,
			data: { style: input.style, exclusive: input.exclusive },
		});
		return row;
	}

	async get(guildId: bigint, name: string): Promise<{ menu: RoleMenu; options: RoleMenuOption[] }> {
		const [menu] = await this.db
			.select()
			.from(roleMenus)
			.where(and(eq(roleMenus.guildId, guildId), eq(roleMenus.name, normalizeName(name))));
		if (!menu) throw new NotFound(`Role menu \`${normalizeName(name)}\``);
		return { menu, options: await this.optionsOf(menu.id) };
	}

	list(guildId: bigint): Promise<RoleMenu[]> {
		return this.db
			.select()
			.from(roleMenus)
			.where(eq(roleMenus.guildId, guildId))
			.orderBy(asc(roleMenus.name));
	}

	async delete(guildId: bigint, name: string, actorId: bigint): Promise<void> {
		const { menu } = await this.get(guildId, name);
		await this.db.delete(roleMenus).where(eq(roleMenus.id, menu.id));
		await this.audit.record({ guildId, actorId, action: "rolemenu.delete", target: menu.name });
	}

	async update(
		guildId: bigint,
		name: string,
		patch: MenuPatch,
		actorId: bigint,
	): Promise<RoleMenu> {
		const { menu } = await this.get(guildId, name);
		const values: Partial<RoleMenu> = {};
		if (patch.title !== undefined) values.title = truncate(patch.title.trim(), 256);
		if (patch.body !== undefined) values.body = patch.body?.trim() || null;
		if (patch.exclusive !== undefined) values.exclusive = patch.exclusive;
		if (patch.maxSelections !== undefined) values.maxSelections = patch.maxSelections;
		if (Object.keys(values).length === 0) throw new ValidationFailed("Nothing to change.");
		const [row] = await this.db
			.update(roleMenus)
			.set(values)
			.where(eq(roleMenus.id, menu.id))
			.returning();
		await this.audit.record({
			guildId,
			actorId,
			action: "rolemenu.update",
			target: menu.name,
			data: values,
		});
		return row!;
	}

	async addOption(
		guildId: bigint,
		name: string,
		input: AddOptionInput,
		actorId: bigint,
	): Promise<RoleMenuOption> {
		const label = input.label.trim();
		if (!label) throw new ValidationFailed("Give the option a label.");
		if (label.length > MAX_LABEL) {
			throw new ValidationFailed(`Labels must be ${MAX_LABEL} characters or fewer.`);
		}
		const { menu, options } = await this.get(guildId, name);
		if (options.length >= MAX_OPTIONS) {
			throw new ValidationFailed(`A menu can hold at most ${MAX_OPTIONS} roles.`);
		}
		if (options.some((option) => option.roleId === input.roleId)) {
			throw new ValidationFailed("That role is already in this menu.");
		}
		const context = await this.roleContext(guildId);
		assertCanManageRole(context.guild, context.botMember, input.roleId);
		const [row] = await this.db
			.insert(roleMenuOptions)
			.values({
				menuId: menu.id,
				roleId: input.roleId,
				label,
				description: input.description?.trim() || null,
				emoji: input.emoji?.trim() || null,
				requiresRoleId: input.requiresRoleId ?? null,
				conflictsWithRoleIds: input.conflictsWithRoleIds ?? [],
				position: options.length,
			})
			.returning();
		await this.audit.record({
			guildId,
			actorId,
			action: "rolemenu.add-option",
			target: menu.name,
			data: { roleId: input.roleId, label },
		});
		return row!;
	}

	async removeOption(
		guildId: bigint,
		name: string,
		roleId: bigint,
		actorId: bigint,
	): Promise<void> {
		const { menu } = await this.get(guildId, name);
		const deleted = await this.db
			.delete(roleMenuOptions)
			.where(and(eq(roleMenuOptions.menuId, menu.id), eq(roleMenuOptions.roleId, roleId)))
			.returning({ id: roleMenuOptions.id });
		if (deleted.length === 0) throw new ValidationFailed("That role is not in this menu.");
		await this.audit.record({
			guildId,
			actorId,
			action: "rolemenu.remove-option",
			target: menu.name,
			data: { roleId },
		});
	}

	render(menu: RoleMenu, options: RoleMenuOption[]): OutboundMessage {
		const embed = {
			title: menu.title,
			color: LOG_COLORS.info,
			...(menu.body ? { description: menu.body } : {}),
		};
		return { embeds: [embed], components: this.components(menu, options) };
	}

	async publish(
		guildId: bigint,
		name: string,
		channelId: bigint,
		actorId: bigint,
	): Promise<bigint> {
		const { menu, options } = await this.get(guildId, name);
		if (options.length === 0) throw new ValidationFailed("Add at least one role first.");
		const sent = await this.api.sendMessage(channelId, this.render(menu, options));
		if (!sent) throw new ValidationFailed("Loop could not post in that channel.");
		await this.db
			.update(roleMenus)
			.set({ channelId, messageId: sent.id })
			.where(eq(roleMenus.id, menu.id));
		await this.audit.record({
			guildId,
			actorId,
			action: "rolemenu.publish",
			target: menu.name,
			data: { channelId, messageId: sent.id },
		});
		return sent.id;
	}

	async refresh(guildId: bigint, name: string): Promise<boolean> {
		const { menu, options } = await this.get(guildId, name);
		if (!menu.channelId || !menu.messageId) return false;
		try {
			await this.api.editMessage(menu.channelId, menu.messageId, this.render(menu, options));
			return true;
		} catch (error) {
			this.logger.warn("role menu refresh failed", { guildId, name: menu.name, error });
			return false;
		}
	}

	async applySelection(
		guildId: bigint,
		userId: bigint,
		menuId: string,
		selectedRoleIds: bigint[],
		mode: "toggle" | "set",
	): Promise<SelectionResult & { menu: RoleMenu }> {
		const [menu] = await this.db
			.select()
			.from(roleMenus)
			.where(and(eq(roleMenus.guildId, guildId), eq(roleMenus.id, menuId)));
		if (!menu) throw new NotFound("That role menu");
		const options = await this.optionsOf(menu.id);
		const context = await this.roleContext(guildId);
		const member = await this.api.getMember(guildId, userId);
		if (!member) throw new MemberNotFound();
		const result = resolveSelection({
			menu: {
				exclusive: menu.exclusive,
				maxSelections: menu.maxSelections,
				requiredRoleId: menu.requiredRoleId,
			},
			options,
			memberRoleIds: member.roleIds,
			selected: selectedRoleIds,
			mode,
			assertManageable: (roleId) => assertCanManageRole(context.guild, context.botMember, roleId),
		});
		const reason = truncate(`Role menu: ${menu.name}`, 512);
		if (result.added.length + result.removed.length > 2) {
			const removed = new Set(result.removed.map(String));
			const roles = member.roleIds.filter((id) => !removed.has(String(id)));
			await this.api.setRoles(guildId, userId, [...roles, ...result.added], reason);
		} else {
			for (const roleId of result.added) {
				await this.api.addRole(guildId, userId, roleId, reason);
			}
			for (const roleId of result.removed) {
				await this.api.removeRole(guildId, userId, roleId, reason);
			}
		}
		return { ...result, menu };
	}

	private optionsOf(menuId: string): Promise<RoleMenuOption[]> {
		return this.db
			.select()
			.from(roleMenuOptions)
			.where(eq(roleMenuOptions.menuId, menuId))
			.orderBy(asc(roleMenuOptions.position));
	}

	private async roleContext(guildId: bigint) {
		const [guild, botMember] = await Promise.all([
			this.api.getGuild(guildId),
			this.api.getMember(guildId, this.api.botUserId()),
		]);
		if (!guild || !botMember) {
			throw new ValidationFailed("Loop cannot read this server's roles right now.");
		}
		return { guild, botMember };
	}

	private components(menu: RoleMenu, options: RoleMenuOption[]): MessageComponents {
		const usable = options.slice(0, MAX_OPTIONS);
		if (menu.style === "select") {
			return [{
				type: MessageComponentTypes.ActionRow,
				components: [{
					type: MessageComponentTypes.SelectMenu,
					customId: encodeCustomId("rolemenu", "select", menu.id),
					placeholder: "Pick your roles",
					minValues: 0,
					maxValues: Math.min(menu.maxSelections ?? usable.length, MAX_OPTIONS),
					options: usable.map((option) => {
						const emoji = parseEmoji(option.emoji);
						return {
							label: truncate(option.label, MAX_LABEL),
							value: String(option.roleId),
							...(option.description ? { description: truncate(option.description, 100) } : {}),
							...(emoji ? { emoji } : {}),
						};
					}),
				}],
			}];
		}
		const rows: ActionRow[] = [];
		for (let index = 0; index < usable.length; index += 5) {
			const buttons: ButtonComponent[] = usable.slice(index, index + 5).map((option) => {
				const emoji = parseEmoji(option.emoji);
				return {
					type: MessageComponentTypes.Button,
					style: ButtonStyles.Secondary,
					label: truncate(option.label, MAX_LABEL),
					customId: encodeCustomId("rolemenu", "toggle", menu.id, option.roleId),
					...(emoji ? { emoji } : {}),
				};
			});
			rows.push({
				type: MessageComponentTypes.ActionRow,
				components: buttons as ActionRow["components"],
			});
		}
		return rows;
	}
}

function normalizeName(name: string): string {
	const normalized = name.trim().toLowerCase();
	if (!/^[a-z0-9-]{1,32}$/.test(normalized)) {
		throw new ValidationFailed("Menu names use letters, numbers and dashes, up to 32 characters.");
	}
	return normalized;
}
