import {
	boolean,
	index,
	integer,
	pgEnum,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { createdAt, snowflake, updatedAt } from "./common.ts";
import { guilds } from "./guilds.ts";

export const roleMenuStyle = pgEnum("role_menu_style", ["buttons", "select"]);

export const roleMenus = pgTable(
	"role_menus",
	{
		id: uuid().defaultRandom().primaryKey(),
		guildId: snowflake().notNull().references(() => guilds.id, { onDelete: "cascade" }),
		name: text().notNull(),
		title: text().notNull(),
		body: text(),
		style: roleMenuStyle().notNull().default("buttons"),
		exclusive: boolean().notNull().default(false),
		maxSelections: integer(),
		requiredRoleId: snowflake(),
		channelId: snowflake(),
		messageId: snowflake(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [uniqueIndex().on(t.guildId, t.name)],
);

export const roleMenuOptions = pgTable(
	"role_menu_options",
	{
		id: uuid().defaultRandom().primaryKey(),
		menuId: uuid().notNull().references(() => roleMenus.id, { onDelete: "cascade" }),
		roleId: snowflake().notNull(),
		label: text().notNull(),
		description: text(),
		emoji: text(),
		requiresRoleId: snowflake(),
		conflictsWithRoleIds: snowflake().array().notNull().default([]),
		position: integer().notNull().default(0),
	},
	(t) => [uniqueIndex().on(t.menuId, t.roleId), index().on(t.menuId, t.position)],
);

export const memberPersistedRoles = pgTable(
	"member_persisted_roles",
	{
		guildId: snowflake().notNull().references(() => guilds.id, { onDelete: "cascade" }),
		userId: snowflake().notNull(),
		roleIds: snowflake().array().notNull().default([]),
		leftAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [primaryKey({ columns: [t.guildId, t.userId] })],
);
