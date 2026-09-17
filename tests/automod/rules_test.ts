import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
	type AutomodMessage,
	defaultActions,
	describeRule,
	evaluateRule,
	fingerprintContent,
	parseRuleConfig,
	RULE_TYPES,
	type RuleType,
} from "../../src/domains/automod/rules.ts";
import { ValidationFailed } from "../../src/shared/errors.ts";

const NOW = new Date("2025-06-01T12:00:00Z");

function message(overrides: Partial<AutomodMessage> = {}): AutomodMessage {
	return {
		guildId: 1n,
		channelId: 2n,
		messageId: 3n,
		authorId: 4n,
		authorRoleIds: [],
		authorIsBot: false,
		accountCreatedAt: new Date("2020-01-01T00:00:00Z"),
		content: "",
		mentionedUserIds: [],
		mentionedRoleIds: [],
		mentionsEveryone: false,
		attachmentCount: 0,
		createdAt: NOW,
		...overrides,
	};
}

function rule(type: RuleType, config: Record<string, unknown> = {}, severity = 1) {
	return { type, config: parseRuleConfig(type, config), severity };
}

function run(
	type: RuleType,
	config: Record<string, unknown>,
	overrides: Partial<AutomodMessage>,
	window: { count: number } | null = null,
) {
	return evaluateRule(rule(type, config), message(overrides), window);
}

Deno.test("every rule type has a config schema with defaults", () => {
	for (const type of RULE_TYPES) {
		const parsed = parseRuleConfig(type, type === "regex" ? { pattern: "spam" } : {});
		assertEquals(typeof parsed, "object");
	}
	assertThrows(() => parseRuleConfig("regex", {}), ValidationFailed, "pattern");
});

Deno.test("message_rate fires only above the limit", () => {
	assertEquals(run("message_rate", { maxMessages: 3 }, {}, { count: 3 }), null);
	assertStringIncludes(
		run("message_rate", { maxMessages: 3 }, {}, { count: 4 })?.reason ?? "",
		"4 messages",
	);
	assertEquals(run("message_rate", { maxMessages: 3 }, {}, null), null);
});

Deno.test("repeated_message fires only above the repeat limit", () => {
	assertEquals(run("repeated_message", { maxRepeats: 3 }, {}, { count: 3 }), null);
	assertStringIncludes(
		run("repeated_message", { maxRepeats: 3 }, {}, { count: 5 })?.reason ?? "",
		"5 times",
	);
});

Deno.test("mention_spam counts users and roles", () => {
	const ids = (count: number) => Array.from({ length: count }, (_, i) => BigInt(i + 1));
	assertEquals(run("mention_spam", {}, { mentionedUserIds: ids(5) }), null);
	assertEquals(run("mention_spam", {}, { mentionedUserIds: ids(6) })?.ruleType, "mention_spam");
	assertEquals(
		run("mention_spam", {}, { mentionedUserIds: ids(4), mentionedRoleIds: ids(4) })?.ruleType,
		"mention_spam",
	);
	assertEquals(
		run("mention_spam", { countRoles: false }, {
			mentionedUserIds: ids(4),
			mentionedRoleIds: ids(4),
		}),
		null,
	);
	assertEquals(run("mention_spam", {}, { mentionsEveryone: true })?.ruleType, "mention_spam");
});

Deno.test("invite_link detects every invite host and honours allowed codes", () => {
	for (
		const content of [
			"join discord.gg/abcd123",
			"https://discord.com/invite/abcd123",
			"http://discordapp.com/invite/abcd123",
		]
	) {
		assertEquals(run("invite_link", {}, { content })?.ruleType, "invite_link", content);
	}
	assertEquals(
		run("invite_link", { allowedCodes: ["abcd123"] }, { content: "discord.gg/abcd123" }),
		null,
	);
	assertEquals(run("invite_link", {}, { content: "no invites here" }), null);
});

Deno.test("suspicious_link flags shorteners, blocked domains and discord lookalikes", () => {
	assertStringIncludes(
		run("suspicious_link", {}, { content: "click https://bit.ly/free" })?.reason ?? "",
		"shortener",
	);
	assertEquals(
		run("suspicious_link", { blockShorteners: false }, { content: "click https://bit.ly/free" }),
		null,
	);
	for (const host of ["dlscord.com", "discorcl.net", "discord-nitro.xyz"]) {
		assertStringIncludes(
			run("suspicious_link", {}, { content: `https://${host}/gift` })?.reason ?? "",
			"lookalike",
			host,
		);
	}
	for (
		const url of [
			"https://discord.com/channels/1/2",
			"https://cdn.discordapp.com/a.png",
			"https://media.discordapp.net/a.png",
			"https://example.com/post",
		]
	) {
		assertEquals(run("suspicious_link", {}, { content: url }), null, url);
	}
	assertStringIncludes(
		run("suspicious_link", { blockedDomains: ["evil.test"] }, {
			content: "https://a.evil.test/x",
		})?.reason ?? "",
		"blocked domain",
	);
	assertEquals(
		run("suspicious_link", { blockedDomains: ["evil.test"], allowedDomains: ["a.evil.test"] }, {
			content: "https://a.evil.test/x",
		}),
		null,
	);
});

Deno.test("blocked_terms ignores zero-width characters and normalizes NFKC", () => {
	const config = { terms: ["badword"] };
	assertEquals(
		run("blocked_terms", config, { content: "that is badword" })?.ruleType,
		"blocked_terms",
	);
	assertEquals(
		run("blocked_terms", config, { content: "that is bad​wo‌rd" })?.ruleType,
		"blocked_terms",
	);
	assertEquals(
		run("blocked_terms", config, { content: "that is ｂａｄｗｏｒｄ" })?.ruleType,
		"blocked_terms",
	);
	assertEquals(run("blocked_terms", config, { content: "embeddedbadwordinside" }), null);
	assertEquals(
		run("blocked_terms", { terms: ["badword"], matchWholeWord: false }, {
			content: "embeddedbadwordinside",
		})?.ruleType,
		"blocked_terms",
	);
});

Deno.test("regex rejects nested quantifiers and over-long patterns", () => {
	for (const pattern of ["(a+)+", "(.*)*", "(ab+)*", "(x*){2,}"]) {
		assertThrows(() => parseRuleConfig("regex", { pattern }), ValidationFailed, "config", pattern);
	}
	assertThrows(() => parseRuleConfig("regex", { pattern: "a".repeat(201) }), ValidationFailed);
	assertThrows(() => parseRuleConfig("regex", { pattern: "(" }), ValidationFailed);
	assertThrows(() => parseRuleConfig("regex", { pattern: "ok", flags: "g" }), ValidationFailed);
});

Deno.test("regex matches within the content cap", () => {
	const config = { pattern: "needle" };
	assertEquals(run("regex", config, { content: "a needle here" })?.ruleType, "regex");
	assertEquals(run("regex", config, { content: "NEEDLE" })?.ruleType, "regex");
	assertEquals(run("regex", config, { content: `${"x".repeat(2100)}needle` }), null);
});

Deno.test("caps uses the letter ratio above a minimum length", () => {
	assertEquals(run("caps", {}, { content: "SHORT" }), null);
	assertEquals(run("caps", {}, { content: "THIS IS ALL SHOUTING" })?.ruleType, "caps");
	assertEquals(run("caps", {}, { content: "This is a calm sentence." }), null);
	assertEquals(run("caps", {}, { content: "1234567890123456789" }), null);
});

Deno.test("emoji_spam counts unicode and custom emoji together", () => {
	assertEquals(run("emoji_spam", { maxEmojis: 3 }, { content: "😀😀😀" }), null);
	assertEquals(
		run("emoji_spam", { maxEmojis: 3 }, { content: "😀😀😀😀" })?.ruleType,
		"emoji_spam",
	);
	assertEquals(
		run("emoji_spam", { maxEmojis: 3 }, {
			content: "<:loop:123456789012345678><a:spin:123456789012345678>😀😀",
		})?.ruleType,
		"emoji_spam",
	);
});

Deno.test("channel_hopping fires above the distinct channel limit", () => {
	assertEquals(run("channel_hopping", { maxChannels: 4 }, {}, { count: 4 }), null);
	assertStringIncludes(
		run("channel_hopping", { maxChannels: 4 }, {}, { count: 5 })?.reason ?? "",
		"5 channels",
	);
});

Deno.test("new_account compares account age against the minimum", () => {
	const young = new Date(NOW.getTime() - 3_600_000);
	assertEquals(run("new_account", {}, { accountCreatedAt: young })?.ruleType, "new_account");
	assertEquals(
		run("new_account", { minAgeHours: 1 }, { accountCreatedAt: young }),
		null,
	);
});

Deno.test("new_account defaults to notifying staff without deleting", () => {
	assertEquals(defaultActions("new_account"), {
		delete: false,
		warn: false,
		timeoutMs: null,
		notifyStaff: true,
		createCase: false,
	});
	assertEquals(defaultActions("caps").delete, true);
});

Deno.test("the match carries the rule severity", () => {
	const found = evaluateRule(
		rule("caps", {}, 7),
		message({ content: "THIS IS ALL SHOUTING" }),
		null,
	);
	assertEquals(found?.severity, 7);
});

Deno.test("fingerprintContent collapses whitespace and invisible characters", () => {
	assertEquals(fingerprintContent("  Hello​   World  "), "hello world");
});

Deno.test("describeRule documents the escalation ladder", () => {
	const description = describeRule({
		id: "00000000-0000-0000-0000-000000000000",
		guildId: 1n,
		name: "shouting",
		type: "caps",
		enabled: true,
		severity: 2,
		config: parseRuleConfig("caps", {}),
		actions: defaultActions("caps"),
		exemptRoleIds: [5n],
		exemptChannelIds: [6n],
		cooldownSeconds: 30,
		createdBy: 7n,
		createdAt: NOW,
		updatedAt: NOW,
	});
	assertStringIncludes(description, "shouting");
	assertStringIncludes(description, "10m timeout");
	assertStringIncludes(description, "<@&5>");
	assertStringIncludes(description, "<#6>");
});
