import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fromFileUrl } from "@std/path";

const url = Deno.env.get("DATABASE_URL");
if (!url) {
	console.error("DATABASE_URL is required");
	Deno.exit(2);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
	await migrate(drizzle(sql), {
		migrationsFolder: fromFileUrl(new URL("../drizzle", import.meta.url)),
	});
	console.log("migrations applied");
} catch (error) {
	console.error("migration failed:", error instanceof Error ? error.message : error);
	Deno.exit(1);
} finally {
	await sql.end({ timeout: 5 });
}
