import {
	boolean,
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

export const automodRuleType = pgEnum("automod_rule_type", [
	"message_rate",
	"repeated_message",
	"mention_spam",
	"invite_link",
	"suspicious_link",
	"blocked_terms",
	"regex",
	"caps",
	"emoji_spam",
	"channel_hopping",
	"new_account",
]);

export type AutomodActions = {
	delete: boolean;
	warn: boolean;
	timeoutMs: number | null;
	notifyStaff: boolean;
	createCase: boolean;
};

export type AutomodConfig = Record<string, unknown>;

export const automodRules = pgTable(
	"automod_rules",
	{
		id: uuid().defaultRandom().primaryKey(),
		guildId: snowflake().notNull().references(() => guilds.id, { onDelete: "cascade" }),
		name: text().notNull(),
		type: automodRuleType().notNull(),
		enabled: boolean().notNull().default(true),
		severity: integer().notNull().default(1),
		config: jsonb().$type<AutomodConfig>().notNull().default({}),
		actions: jsonb().$type<AutomodActions>().notNull().default({
			delete: true,
			warn: false,
			timeoutMs: null,
			notifyStaff: false,
			createCase: false,
		}),
		exemptRoleIds: snowflake().array().notNull().default([]),
		exemptChannelIds: snowflake().array().notNull().default([]),
		cooldownSeconds: integer().notNull().default(30),
		createdBy: snowflake().notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [uniqueIndex().on(t.guildId, t.name), index().on(t.guildId, t.enabled)],
);
