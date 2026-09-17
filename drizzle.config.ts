import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "postgresql",
	schema: "./src/database/schema/index.ts",
	out: "./drizzle",
	casing: "snake_case",
	strict: true,
	verbose: true,
	dbCredentials: {
		url: Deno.env.get("DATABASE_URL") ?? "postgres://loop:loop@localhost:5432/loop",
	},
});
