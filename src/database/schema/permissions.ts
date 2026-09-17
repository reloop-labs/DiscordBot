import { pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, snowflake } from "./common.ts";
import { guilds } from "./guilds.ts";

export const permissionGrants = pgTable(
	"permission_grants",
	{
		id: uuid().defaultRandom().primaryKey(),
		guildId: snowflake().notNull().references(() => guilds.id, { onDelete: "cascade" }),
		roleId: snowflake().notNull(),
		permission: text().notNull(),
		grantedBy: snowflake().notNull(),
		createdAt: createdAt(),
	},
	(t) => [uniqueIndex().on(t.guildId, t.roleId, t.permission)],
);
