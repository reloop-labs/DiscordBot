import {
	index,
	integer,
	pgEnum,
	pgTable,
	primaryKey,
	smallint,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { createdAt, snowflake, updatedAt } from "./common.ts";
import { guilds } from "./guilds.ts";

export const suggestionStatus = pgEnum("suggestion_status", [
	"open",
	"under_review",
	"planned",
	"accepted",
	"declined",
	"implemented",
]);

export const suggestions = pgTable(
	"suggestions",
	{
		id: uuid().defaultRandom().primaryKey(),
		guildId: snowflake().notNull().references(() => guilds.id, { onDelete: "cascade" }),
		suggestionNumber: integer().notNull(),
		authorId: snowflake().notNull(),
		channelId: snowflake().notNull(),
		messageId: snowflake(),
		title: text().notNull(),
		content: text().notNull(),
		status: suggestionStatus().notNull().default("open"),
		upvotes: integer().notNull().default(0),
		downvotes: integer().notNull().default(0),
		officialResponse: text(),
		respondedBy: snowflake(),
		respondedAt: timestamp({ withTimezone: true }),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		uniqueIndex().on(t.guildId, t.suggestionNumber),
		index().on(t.guildId, t.status),
		index().on(t.messageId),
	],
);

export const suggestionVotes = pgTable(
	"suggestion_votes",
	{
		suggestionId: uuid().notNull().references(() => suggestions.id, { onDelete: "cascade" }),
		userId: snowflake().notNull(),
		vote: smallint().notNull(),
		createdAt: createdAt(),
	},
	(t) => [primaryKey({ columns: [t.suggestionId, t.userId] })],
);
