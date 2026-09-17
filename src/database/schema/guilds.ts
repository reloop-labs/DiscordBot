import {
	boolean,
	index,
	integer,
	pgEnum,
	pgTable,
	primaryKey,
	text,
	timestamp,
} from "drizzle-orm/pg-core";
import { createdAt, snowflake, updatedAt } from "./common.ts";

export const guilds = pgTable("guilds", {
	id: snowflake().primaryKey(),
	name: text().notNull().default(""),
	joinedAt: createdAt(),
	leftAt: timestamp({ withTimezone: true }),
});

export const guildSettings = pgTable("guild_settings", {
	guildId: snowflake().primaryKey().references(() => guilds.id, { onDelete: "cascade" }),
	memberRoleId: snowflake(),
	welcomeChannelId: snowflake(),
	welcomeMessage: text(),
	leaveChannelId: snowflake(),
	leaveMessage: text(),
	dmOnModeration: boolean().notNull().default(true),
	persistRoles: boolean().notNull().default(false),
	suggestionChannelId: snowflake(),
	reportChannelId: snowflake(),
	ticketArchiveCategoryId: snowflake(),
	ticketInactivityHours: integer().notNull().default(72),
	raidJoinThreshold: integer().notNull().default(10),
	raidJoinWindowSeconds: integer().notNull().default(60),
	raidMinAccountAgeHours: integer().notNull().default(24),
	raidAlertRoleId: snowflake(),
	updatedAt: updatedAt(),
});

export const logKind = pgEnum("log_kind", [
	"moderation",
	"automod",
	"joins",
	"leaves",
	"messages",
	"members",
	"tickets",
	"reports",
	"suggestions",
	"config",
]);

export const guildLogChannels = pgTable(
	"guild_log_channels",
	{
		guildId: snowflake().notNull().references(() => guilds.id, { onDelete: "cascade" }),
		kind: logKind().notNull(),
		channelId: snowflake().notNull(),
	},
	(t) => [primaryKey({ columns: [t.guildId, t.kind] })],
);

export const guildSequences = pgTable(
	"guild_sequences",
	{
		guildId: snowflake().notNull().references(() => guilds.id, { onDelete: "cascade" }),
		kind: text().notNull(),
		value: integer().notNull().default(0),
	},
	(t) => [primaryKey({ columns: [t.guildId, t.kind] }), index().on(t.guildId)],
);
