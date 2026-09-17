import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.ts";

export type Database = ReturnType<typeof createDatabase>["db"];
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DbExecutor = Database | Transaction;

export function createDatabase(url: string, options: { max?: number } = {}) {
	const sql = postgres(url, {
		max: options.max ?? 10,
		idle_timeout: 30,
		connect_timeout: 10,
		prepare: false,
		onnotice: () => {},
	});
	const db = drizzle(sql, { schema, casing: "snake_case" });
	return {
		db,
		async ping(): Promise<boolean> {
			try {
				await sql`select 1`;
				return true;
			} catch {
				return false;
			}
		},
		async close(): Promise<void> {
			await sql.end({ timeout: 5 });
		},
	};
}

export type DatabaseHandle = ReturnType<typeof createDatabase>;
