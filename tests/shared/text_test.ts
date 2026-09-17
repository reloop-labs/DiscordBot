import { assertEquals } from "@std/assert";
import {
	escapeMarkdown,
	neutralizeMentions,
	NO_MENTIONS,
	truncate,
} from "../../src/shared/text.ts";

Deno.test("mass mentions are neutralized", () => {
	const out = neutralizeMentions("hi @everyone and @here <@&123>");
	assertEquals(out.includes("@everyone"), false);
	assertEquals(out.includes("@here"), false);
	assertEquals(out.includes("<@&123>"), false);
});

Deno.test("NO_MENTIONS parses nothing", () => {
	assertEquals(NO_MENTIONS.parse.length, 0);
});

Deno.test("markdown is escaped and text truncated", () => {
	assertEquals(escapeMarkdown("**bold** _x_"), "\\*\\*bold\\*\\* \\_x\\_");
	assertEquals(truncate("abcdef", 4), "abc…");
	assertEquals(truncate("abc", 4), "abc");
});
