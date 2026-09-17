import {
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { createdAt, snowflake, updatedAt } from "./common.ts";
import { guilds } from "./guilds.ts";

export const caseAction = pgEnum("case_action", [
	"warn",
	"timeout",
	"untimeout",
	"kick",
	"ban",
	"unban",
	"automod",
]);

export const caseStatus = pgEnum("case_status", ["active", "expired", "voided"]);

export type CaseEvidence = { urls: string[]; messageIds: string[]; attachments: string[] };

export const moderationCases = pgTable(
	"moderation_cases",
	{
		id: uuid().defaultRandom().primaryKey(),
		guildId: snowflake().notNull().references(() => guilds.id, { onDelete: "cascade" }),
		caseNumber: integer().notNull(),
		action: caseAction().notNull(),
		status: caseStatus().notNull().default("active"),
		targetUserId: snowflake().notNull(),
		moderatorUserId: snowflake().notNull(),
		reason: text(),
		durationMs: integer(),
		expiresAt: timestamp({ withTimezone: true }),
		evidence: jsonb().$type<CaseEvidence>().notNull().default({
			urls: [],
			messageIds: [],
			attachments: [],
		}),
		metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
		dmDelivered: text().$type<"sent" | "failed" | "skipped">().notNull().default("skipped"),
		logMessageId: snowflake(),
		voidedBy: snowflake(),
		voidedAt: timestamp({ withTimezone: true }),
		voidReason: text(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		uniqueIndex().on(t.guildId, t.caseNumber),
		index().on(t.guildId, t.targetUserId, t.createdAt),
		index().on(t.guildId, t.moderatorUserId),
	],
);

export const moderationCaseNotes = pgTable(
	"moderation_case_notes",
	{
		id: uuid().defaultRandom().primaryKey(),
		caseId: uuid().notNull().references(() => moderationCases.id, { onDelete: "cascade" }),
		authorId: snowflake().notNull(),
		content: text().notNull(),
		createdAt: createdAt(),
	},
	(t) => [index().on(t.caseId)],
);

export const staffNotes = pgTable(
	"staff_notes",
	{
		id: uuid().defaultRandom().primaryKey(),
		guildId: snowflake().notNull().references(() => guilds.id, { onDelete: "cascade" }),
		userId: snowflake().notNull(),
		authorId: snowflake().notNull(),
		content: text().notNull(),
		createdAt: createdAt(),
		deletedAt: timestamp({ withTimezone: true }),
		deletedBy: snowflake(),
	},
	(t) => [index().on(t.guildId, t.userId)],
);
