import { assertEquals } from "@std/assert";
import { formatDuration, MAX_TIMEOUT_MS, parseDuration } from "../../src/shared/duration.ts";

Deno.test("parseDuration handles units and combinations", () => {
	assertEquals(parseDuration("10m"), 600_000);
	assertEquals(parseDuration("1h30m"), 5_400_000);
	assertEquals(parseDuration("2d"), 172_800_000);
	assertEquals(parseDuration("1w"), 604_800_000);
	assertEquals(parseDuration(" 45 s "), 45_000);
});

Deno.test("parseDuration rejects garbage", () => {
	assertEquals(parseDuration("forever"), null);
	assertEquals(parseDuration("10"), null);
	assertEquals(parseDuration("0m"), null);
	assertEquals(parseDuration("-5m"), null);
	assertEquals(parseDuration("1y"), null);
});

Deno.test("formatDuration is compact", () => {
	assertEquals(formatDuration(90_000), "1m 30s");
	assertEquals(formatDuration(MAX_TIMEOUT_MS), "4w");
	assertEquals(formatDuration(0), "0s");
});
