import { assertEquals, assertThrows } from "@std/assert";
import { loadEnv, secretsOf } from "../../src/config/env.ts";

const valid = {
	DISCORD_TOKEN: "x".repeat(60),
	DISCORD_APPLICATION_ID: "123456789012345678",
	DATABASE_URL: "postgres://loop:s3cret@localhost:5432/loop",
	REDIS_URL: "redis://:redispass@localhost:6379",
};

Deno.test("valid environment loads with defaults", () => {
	const env = loadEnv(valid);
	assertEquals(env.PORT, 8080);
	assertEquals(env.LOG_LEVEL, "info");
	assertEquals(env.ENVIRONMENT, "development");
	assertEquals(env.HEALTH_HOST, "127.0.0.1");
});

Deno.test("missing token fails clearly", () => {
	assertThrows(() => loadEnv({ ...valid, DISCORD_TOKEN: "" }), Error, "DISCORD_TOKEN");
});

Deno.test("wrong database scheme fails", () => {
	assertThrows(() => loadEnv({ ...valid, DATABASE_URL: "mysql://x" }), Error, "DATABASE_URL");
});

Deno.test("application id must be a snowflake", () => {
	assertThrows(
		() => loadEnv({ ...valid, DISCORD_APPLICATION_ID: "12" }),
		Error,
		"DISCORD_APPLICATION_ID",
	);
});

Deno.test("secrets include token and connection passwords", () => {
	const secrets = secretsOf(loadEnv(valid));
	assertEquals(secrets.includes("s3cret"), true);
	assertEquals(secrets.includes("redispass"), true);
	assertEquals(secrets.includes(valid.DISCORD_TOKEN), true);
});
