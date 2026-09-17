import {
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { createdAt, snowflake, updatedAt } from "./common.ts";
import { guilds } from "./guilds.ts";
import { moderationCases } from "./moderation.ts";

export const reportType = pgEnum("report_type", ["user", "message", "general"]);
export const reportStatus = pgEnum("report_status", ["open", "in_review", "resolved", "dismissed"]);

export const reports = pgTable(
	"reports",
	{
		id: uuid().defaultRandom().primaryKey(),
		guildId: snowflake().notNull().references(() => guilds.id, { onDelete: "cascade" }),
		reportNumber: integer().notNull(),
		type: reportType().notNull(),
		status: reportStatus().notNull().default("open"),
		reporterId: snowflake().notNull(),
		targetUserId: snowflake(),
		messageId: snowflake(),
		channelId: snowflake(),
		messageContent: text(),
		reason: text().notNull(),
		evidence: text(),
		assignedTo: snowflake(),
		caseId: uuid().references(() => moderationCases.id, { onDelete: "set null" }),
		staffChannelId: snowflake(),
		staffMessageId: snowflake(),
		resolution: text(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		uniqueIndex().on(t.guildId, t.reportNumber),
		index().on(t.guildId, t.status),
		index().on(t.guildId, t.reporterId),
	],
);

export const reportEvents = pgTable(
	"report_events",
	{
		id: uuid().defaultRandom().primaryKey(),
		reportId: uuid().notNull().references(() => reports.id, { onDelete: "cascade" }),
		type: text().notNull(),
		actorId: snowflake(),
		data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
		createdAt: createdAt(),
	},
	(t) => [index().on(t.reportId, t.createdAt)],
);
