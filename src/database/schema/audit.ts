import { index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, snowflake } from "./common.ts";
import { guilds } from "./guilds.ts";

export const auditEvents = pgTable(
	"audit_events",
	{
		id: uuid().defaultRandom().primaryKey(),
		guildId: snowflake().notNull().references(() => guilds.id, { onDelete: "cascade" }),
		actorId: snowflake(),
		action: text().notNull(),
		target: text(),
		data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
		createdAt: createdAt(),
	},
	(t) => [index().on(t.guildId, t.createdAt), index().on(t.guildId, t.action)],
);
