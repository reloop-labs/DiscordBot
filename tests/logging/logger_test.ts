import { assertEquals, assertStringIncludes } from "@std/assert";
import { createLogger } from "../../src/logging/logger.ts";

Deno.test("logger redacts secrets and serializes bigints", () => {
	const lines: string[] = [];
	const logger = createLogger({
		level: "info",
		secrets: ["supersecrettoken"],
		write: (l) => lines.push(l),
	});
	logger.info("hello", { token: "supersecrettoken", id: 123n });
	const record = JSON.parse(lines[0]!);
	assertEquals(record.token, "[redacted]");
	assertEquals(record.id, "123");
	assertEquals(record.level, "info");
});

Deno.test("logger respects level and child context", () => {
	const lines: string[] = [];
	const logger = createLogger({ level: "warn", write: (l) => lines.push(l) }).child({
		guildId: "1",
	});
	logger.info("dropped");
	logger.error("kept", { error: new Error("boom") });
	assertEquals(lines.length, 1);
	assertStringIncludes(lines[0]!, '"guildId":"1"');
	assertStringIncludes(lines[0]!, '"message":"boom"');
});
