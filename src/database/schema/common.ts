import { bigint, timestamp } from "drizzle-orm/pg-core";

export const snowflake = () => bigint({ mode: "bigint" });

export const createdAt = () => timestamp({ withTimezone: true }).defaultNow().notNull();

export const updatedAt = () =>
	timestamp({ withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date());
