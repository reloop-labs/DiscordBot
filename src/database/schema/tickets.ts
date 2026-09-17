import {
	boolean,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createdAt, snowflake, updatedAt } from "./common.ts";
import { guilds } from "./guilds.ts";

export const ticketCategories = pgTable(
	"ticket_categories",
	{
		id: uuid().defaultRandom().primaryKey(),
		guildId: snowflake().notNull().references(() => guilds.id, { onDelete: "cascade" }),
		name: text().notNull(),
		description: text(),
		emoji: text(),
		parentChannelId: snowflake(),
		staffRoleIds: snowflake().array().notNull().default([]),
		openingMessage: text(),
		position: integer().notNull().default(0),
		enabled: boolean().notNull().default(true),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [uniqueIndex().on(t.guildId, t.name)],
);

export const panelStyle = pgEnum("panel_style", ["buttons", "select"]);

export const ticketPanels = pgTable(
	"ticket_panels",
	{
		id: uuid().defaultRandom().primaryKey(),
		guildId: snowflake().notNull().references(() => guilds.id, { onDelete: "cascade" }),
		channelId: snowflake().notNull(),
		messageId: snowflake(),
		title: text().notNull(),
		body: text(),
		style: panelStyle().notNull().default("buttons"),
		categoryIds: uuid().array().notNull().default([]),
		createdAt: createdAt(),
	},
	(t) => [index().on(t.guildId)],
);

export const ticketStatus = pgEnum("ticket_status", ["open", "closed"]);

export const tickets = pgTable(
	"tickets",
	{
		id: uuid().defaultRandom().primaryKey(),
		guildId: snowflake().notNull().references(() => guilds.id, { onDelete: "cascade" }),
		ticketNumber: integer().notNull(),
		categoryId: uuid().references(() => ticketCategories.id, { onDelete: "set null" }),
		openerUserId: snowflake().notNull(),
		channelId: snowflake().notNull(),
		status: ticketStatus().notNull().default("open"),
		claimedBy: snowflake(),
		closedBy: snowflake(),
		closedAt: timestamp({ withTimezone: true }),
		closeReason: text(),
		lastActivityAt: createdAt(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		uniqueIndex().on(t.guildId, t.ticketNumber),
		uniqueIndex("tickets_one_open_per_opener_category").on(t.guildId, t.openerUserId, t.categoryId)
			.where(sql`${t.status} = 'open'`),
		uniqueIndex().on(t.channelId),
		index().on(t.guildId, t.status, t.lastActivityAt),
	],
);

export const ticketParticipants = pgTable(
	"ticket_participants",
	{
		ticketId: uuid().notNull().references(() => tickets.id, { onDelete: "cascade" }),
		userId: snowflake().notNull(),
		addedBy: snowflake().notNull(),
		addedAt: createdAt(),
	},
	(t) => [primaryKey({ columns: [t.ticketId, t.userId] })],
);

export const ticketEvents = pgTable(
	"ticket_events",
	{
		id: uuid().defaultRandom().primaryKey(),
		ticketId: uuid().notNull().references(() => tickets.id, { onDelete: "cascade" }),
		type: text().notNull(),
		actorId: snowflake(),
		data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
		createdAt: createdAt(),
	},
	(t) => [index().on(t.ticketId, t.createdAt)],
);

export const ticketNotes = pgTable(
	"ticket_notes",
	{
		id: uuid().defaultRandom().primaryKey(),
		ticketId: uuid().notNull().references(() => tickets.id, { onDelete: "cascade" }),
		authorId: snowflake().notNull(),
		content: text().notNull(),
		createdAt: createdAt(),
	},
	(t) => [index().on(t.ticketId)],
);

export const ticketTranscripts = pgTable(
	"ticket_transcripts",
	{
		id: uuid().defaultRandom().primaryKey(),
		ticketId: uuid().notNull().references(() => tickets.id, { onDelete: "cascade" }),
		storageKey: text().notNull(),
		format: text().notNull().default("html"),
		messageCount: integer().notNull().default(0),
		sizeBytes: integer().notNull().default(0),
		createdAt: createdAt(),
	},
	(t) => [index().on(t.ticketId)],
);
