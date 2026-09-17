import { assertEquals, assertThrows } from "@std/assert";
import { accountAgeMs, parseSnowflake, snowflakeCreatedAt } from "../../src/shared/snowflake.ts";

Deno.test("snowflakes keep full precision", () => {
	assertEquals(parseSnowflake("1390212514658123836"), 1390212514658123836n);
	assertEquals(String(parseSnowflake("1390212514658123836")), "1390212514658123836");
});

Deno.test("invalid snowflakes throw", () => {
	assertThrows(() => parseSnowflake("abc"));
	assertThrows(() => parseSnowflake("123"));
});

Deno.test("creation date is derived from the snowflake", () => {
	const created = snowflakeCreatedAt(1390212514658123836n);
	assertEquals(created.getUTCFullYear(), 2025);
	assertEquals(accountAgeMs(1390212514658123836n, new Date(created.getTime() + 1000)), 1000);
});
