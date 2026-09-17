import { assertEquals, assertThrows } from "@std/assert";
import { decodeCustomId, encodeCustomId } from "../../src/discord/interactions/custom-id.ts";

Deno.test("custom ids round trip", () => {
	const id = encodeCustomId("ticket", "close", 123456789012345678n, "reason");
	assertEquals(decodeCustomId(id), {
		domain: "ticket",
		action: "close",
		args: ["123456789012345678", "reason"],
	});
});

Deno.test("foreign custom ids are rejected", () => {
	assertEquals(decodeCustomId("other:x:y"), null);
	assertEquals(decodeCustomId("loop:only"), null);
});

Deno.test("custom ids over 100 characters throw", () => {
	assertThrows(() => encodeCustomId("a", "b", "x".repeat(100)));
});
