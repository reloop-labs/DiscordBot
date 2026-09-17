import { z } from "zod";
import {
	type AutomodActions,
	automodRules,
	automodRuleType,
} from "../../database/schema/automod.ts";
import { formatDuration } from "../../shared/duration.ts";
import { ValidationFailed } from "../../shared/errors.ts";
import { channelMention, neutralizeMentions, roleMention, truncate } from "../../shared/text.ts";

export type AutomodRule = typeof automodRules.$inferSelect;

export const RULE_TYPES = automodRuleType.enumValues;

export type RuleType = (typeof RULE_TYPES)[number];

export interface AutomodMessage {
	guildId: bigint;
	channelId: bigint;
	messageId: bigint;
	authorId: bigint;
	authorRoleIds: bigint[];
	authorIsBot: boolean;
	accountCreatedAt: Date;
	content: string;
	mentionedUserIds: bigint[];
	mentionedRoleIds: bigint[];
	mentionsEveryone: boolean;
	attachmentCount: number;
	createdAt: Date;
}

export interface WindowResult {
	count: number;
}

export interface Match {
	ruleType: RuleType;
	reason: string;
	severity: number;
	data?: Record<string, string>;
}

export type WindowKind = "rate" | "repeat" | "hop";

export type RuleConfig = Record<string, unknown>;

export const ESCALATION_LADDER =
	"3 automod hits in an hour upgrade a warn to a 10m timeout, 5 to a 1h timeout.";

const ZERO_WIDTH = /[\u00AD\u200B-\u200F\u2060\uFEFF]/g;

export function normalizeContent(content: string): string {
	return content.normalize("NFKC").replaceAll(ZERO_WIDTH, "").toLowerCase();
}

export function fingerprintContent(content: string): string {
	return normalizeContent(content).replaceAll(/\s+/g, " ").trim();
}

export function contentExcerpt(content: string, max: number): string {
	const text = truncate(neutralizeMentions(content).replaceAll("```", "'''"), max).trim();
	return text ? `\`\`\`\n${text}\n\`\`\`` : "*No text content*";
}

const compiled = new Map<string, RegExp>();

function cachedRegex(key: string, build: () => RegExp): RegExp {
	const hit = compiled.get(key);
	if (hit) return hit;
	if (compiled.size > 500) compiled.clear();
	const made = build();
	compiled.set(key, made);
	return made;
}

interface RuleSpec {
	parse(raw: unknown): RuleConfig;
	windowKind: WindowKind | null;
	windowMs(config: RuleConfig): number;
	describe(config: RuleConfig): string;
	evaluate(
		message: AutomodMessage,
		config: RuleConfig,
		window: WindowResult | null,
	): Match | null;
}

function define<S extends z.ZodType>(spec: {
	schema: S;
	windowKind?: WindowKind;
	windowMs?: (config: z.output<S>) => number;
	describe: (config: z.output<S>) => string;
	evaluate: (
		message: AutomodMessage,
		config: z.output<S>,
		window: WindowResult | null,
	) => Match | null;
}): RuleSpec {
	return {
		parse: (raw) => spec.schema.parse(raw) as RuleConfig,
		windowKind: spec.windowKind ?? null,
		windowMs: (config) => spec.windowMs?.(config as z.output<S>) ?? 0,
		describe: (config) => spec.describe(config as z.output<S>),
		evaluate: (message, config, window) => spec.evaluate(message, config as z.output<S>, window),
	};
}

function match(ruleType: RuleType, reason: string): Match {
	return { ruleType, reason, severity: 1 };
}

const INVITE_PATTERN =
	/(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([a-z0-9-]{2,64})/gi;

const URL_PATTERN =
	/(?:https?:\/\/|www\.)[^\s<>"'`]+|(?<![@\w.-])[a-z0-9-]{2,63}(?:\.[a-z0-9-]{2,63})+(?:\/[^\s<>"'`]*)?/gi;

const CUSTOM_EMOJI = /<a?:[a-z0-9_]{2,32}:\d{15,25}>/gi;

const UNICODE_EMOJI = /\p{Extended_Pictographic}/gu;

const DEFAULT_SHORTENERS = ["bit.ly", "tinyurl.com", "t.co", "is.gd", "cutt.ly", "rb.gy"];

const DISCORD_HOSTS = ["discord.com", "discord.gg", "discordapp.com", "discordapp.net"];

const CONFUSABLES: [RegExp, string][] = [
	[/cl/g, "d"],
	[/rn/g, "m"],
	[/vv/g, "w"],
	[/[l1|!]/g, "i"],
	[/0/g, "o"],
];

function domainMatches(host: string, domain: string): boolean {
	const clean = domain.trim().toLowerCase().replace(/^\*?\.?/, "");
	if (!clean) return false;
	return host === clean || host.endsWith(`.${clean}`);
}

function hostnamesOf(content: string): string[] {
	const hosts: string[] = [];
	for (const [raw] of content.matchAll(URL_PATTERN)) {
		const url = URL.parse(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
		if (url) hosts.push(url.hostname.toLowerCase().replace(/^www\./, ""));
	}
	return hosts;
}

function looksLikeDiscord(host: string): boolean {
	if (DISCORD_HOSTS.some((legit) => domainMatches(host, legit))) return false;
	let canonical = host;
	for (const [pattern, replacement] of CONFUSABLES) {
		canonical = canonical.replaceAll(pattern, replacement);
	}
	return canonical.includes("discord");
}

function escapeForRegex(term: string): string {
	return term.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NESTED_QUANTIFIER = /\([^()]*[+*][^()]*\)\s*[*+{]/;

const MAX_PATTERN_LENGTH = 200;

const MAX_REGEX_CONTENT = 2000;

const patternSchema = z
	.string()
	.min(1)
	.max(MAX_PATTERN_LENGTH, `Pattern must be ${MAX_PATTERN_LENGTH} characters or fewer.`)
	.refine((pattern) => !NESTED_QUANTIFIER.test(pattern), {
		message: "Nested quantifiers such as (a+)+ are not allowed.",
	})
	.refine((pattern) => {
		try {
			new RegExp(pattern);
			return true;
		} catch {
			return false;
		}
	}, { message: "That is not a valid regular expression." });

const SPECS: Record<RuleType, RuleSpec> = {
	message_rate: define({
		schema: z.object({
			maxMessages: z.number().int().min(2).max(100).default(5),
			windowSeconds: z.number().int().min(1).max(300).default(5),
		}),
		windowKind: "rate",
		windowMs: (config) => config.windowSeconds * 1000,
		describe: (config) => `More than ${config.maxMessages} messages in ${config.windowSeconds}s`,
		evaluate: (_message, config, window) =>
			window && window.count > config.maxMessages
				? match(
					"message_rate",
					`sent ${window.count} messages in ${config.windowSeconds}s (limit ${config.maxMessages})`,
				)
				: null,
	}),

	repeated_message: define({
		schema: z.object({
			maxRepeats: z.number().int().min(2).max(50).default(3),
			windowSeconds: z.number().int().min(1).max(3600).default(30),
		}),
		windowKind: "repeat",
		windowMs: (config) => config.windowSeconds * 1000,
		describe: (config) =>
			`The same message more than ${config.maxRepeats} times in ${config.windowSeconds}s`,
		evaluate: (_message, config, window) =>
			window && window.count > config.maxRepeats
				? match(
					"repeated_message",
					`repeated the same message ${window.count} times in ${config.windowSeconds}s`,
				)
				: null,
	}),

	mention_spam: define({
		schema: z.object({
			maxMentions: z.number().int().min(1).max(100).default(5),
			countRoles: z.boolean().default(true),
		}),
		describe: (config) =>
			`More than ${config.maxMentions} mentions in one message${
				config.countRoles ? " (roles counted)" : " (users only)"
			}`,
		evaluate: (message, config) => {
			if (message.mentionsEveryone) {
				return match("mention_spam", "mentioned @everyone or @here");
			}
			const users = new Set(message.mentionedUserIds.map(String)).size;
			const roles = config.countRoles ? new Set(message.mentionedRoleIds.map(String)).size : 0;
			const total = users + roles;
			return total > config.maxMentions
				? match("mention_spam", `mentioned ${total} targets (limit ${config.maxMentions})`)
				: null;
		},
	}),

	invite_link: define({
		schema: z.object({
			allowOwnGuild: z.boolean().default(true),
			allowedCodes: z.array(z.string().min(1).max(64)).max(100).default([]),
		}),
		describe: (config) =>
			`Discord invite links${
				config.allowedCodes.length ? `, except ${config.allowedCodes.join(", ")}` : ""
			}`,
		evaluate: (message, config) => {
			const allowed = new Set(config.allowedCodes.map((code) => code.toLowerCase()));
			for (const [, code] of message.content.matchAll(INVITE_PATTERN)) {
				if (code && !allowed.has(code.toLowerCase())) {
					return { ...match("invite_link", `posted the invite \`${code}\``), data: { code } };
				}
			}
			return null;
		},
	}),

	suspicious_link: define({
		schema: z.object({
			blockedDomains: z.array(z.string().min(1).max(253)).max(200).default([]),
			allowedDomains: z.array(z.string().min(1).max(253)).max(200).default([]),
			blockShorteners: z.boolean().default(true),
		}),
		describe: (config) =>
			[
				config.blockedDomains.length
					? `Blocked domains: ${config.blockedDomains.join(", ")}`
					: "Blocked domains: none",
				config.blockShorteners ? "Link shorteners blocked" : "Link shorteners allowed",
				"Discord lookalike domains blocked",
				config.allowedDomains.length ? `Always allowed: ${config.allowedDomains.join(", ")}` : "",
			].filter(Boolean).join(" · "),
		evaluate: (message, config) => {
			for (const host of hostnamesOf(message.content)) {
				if (config.allowedDomains.some((domain) => domainMatches(host, domain))) continue;
				if (config.blockedDomains.some((domain) => domainMatches(host, domain))) {
					return match("suspicious_link", `linked to the blocked domain \`${host}\``);
				}
				if (
					config.blockShorteners &&
					DEFAULT_SHORTENERS.some((domain) => domainMatches(host, domain))
				) {
					return match("suspicious_link", `linked through the shortener \`${host}\``);
				}
				if (looksLikeDiscord(host)) {
					return match("suspicious_link", `linked to the Discord lookalike \`${host}\``);
				}
			}
			return null;
		},
	}),

	blocked_terms: define({
		schema: z.object({
			terms: z.array(z.string().min(1).max(100)).max(500).default([]),
			matchWholeWord: z.boolean().default(true),
		}),
		describe: (config) =>
			`${config.terms.length} blocked term${config.terms.length === 1 ? "" : "s"}, matched ${
				config.matchWholeWord ? "as whole words" : "anywhere"
			}`,
		evaluate: (message, config) => {
			const content = normalizeContent(message.content);
			if (!content) return null;
			for (const term of config.terms) {
				const normalized = normalizeContent(term);
				if (!normalized) continue;
				const pattern = cachedRegex(`term:${config.matchWholeWord}:${normalized}`, () =>
					new RegExp(
						config.matchWholeWord
							? `(?<![\\p{L}\\p{N}])${escapeForRegex(normalized)}(?![\\p{L}\\p{N}])`
							: escapeForRegex(normalized),
						"u",
					));
				if (pattern.test(content)) {
					return match("blocked_terms", `used the blocked term \`${normalized}\``);
				}
			}
			return null;
		},
	}),

	regex: define({
		schema: z.object({
			pattern: patternSchema,
			flags: z.string().max(4).regex(/^[imsu]*$/, "Flags may only be i, m, s or u.").default("i"),
		}),
		describe: (config) => `Matches \`/${config.pattern}/${config.flags}\``,
		evaluate: (message, config) => {
			const pattern = cachedRegex(
				`rx:${config.flags}:${config.pattern}`,
				() => new RegExp(config.pattern, config.flags),
			);
			return pattern.test(message.content.slice(0, MAX_REGEX_CONTENT))
				? match("regex", "matched a blocked pattern")
				: null;
		},
	}),

	caps: define({
		schema: z.object({
			minLength: z.number().int().min(1).max(2000).default(15),
			maxRatio: z.number().min(0.1).max(1).default(0.7),
		}),
		describe: (config) =>
			`Over ${
				Math.round(config.maxRatio * 100)
			}% capitals in messages of ${config.minLength}+ characters`,
		evaluate: (message, config) => {
			if (message.content.length < config.minLength) return null;
			const letters = message.content.match(/\p{L}/gu)?.length ?? 0;
			if (letters === 0) return null;
			const upper = message.content.match(/\p{Lu}/gu)?.length ?? 0;
			const ratio = upper / letters;
			return ratio > config.maxRatio
				? match("caps", `shouted with ${Math.round(ratio * 100)}% capitals`)
				: null;
		},
	}),

	emoji_spam: define({
		schema: z.object({ maxEmojis: z.number().int().min(1).max(200).default(10) }),
		describe: (config) => `More than ${config.maxEmojis} emoji in one message`,
		evaluate: (message, config) => {
			const unicode = message.content.match(UNICODE_EMOJI)?.length ?? 0;
			const custom = message.content.match(CUSTOM_EMOJI)?.length ?? 0;
			const total = unicode + custom;
			return total > config.maxEmojis
				? match("emoji_spam", `used ${total} emoji (limit ${config.maxEmojis})`)
				: null;
		},
	}),

	channel_hopping: define({
		schema: z.object({
			maxChannels: z.number().int().min(2).max(50).default(4),
			windowSeconds: z.number().int().min(1).max(3600).default(20),
		}),
		windowKind: "hop",
		windowMs: (config) => config.windowSeconds * 1000,
		describe: (config) =>
			`Posting in more than ${config.maxChannels} channels within ${config.windowSeconds}s`,
		evaluate: (_message, config, window) =>
			window && window.count > config.maxChannels
				? match(
					"channel_hopping",
					`posted in ${window.count} channels in ${config.windowSeconds}s`,
				)
				: null,
	}),

	new_account: define({
		schema: z.object({ minAgeHours: z.number().int().min(1).max(8760).default(24) }),
		describe: (config) => `Accounts younger than ${config.minAgeHours}h (signal only)`,
		evaluate: (message, config) => {
			const ageHours = (message.createdAt.getTime() - message.accountCreatedAt.getTime()) /
				3_600_000;
			return ageHours < config.minAgeHours
				? match("new_account", `account is ${Math.max(0, Math.floor(ageHours))}h old`)
				: null;
		},
	}),
};

export function isRuleType(value: string): value is RuleType {
	return (RULE_TYPES as readonly string[]).includes(value);
}

export function parseRuleConfig(type: RuleType, raw: unknown): RuleConfig {
	try {
		return SPECS[type].parse(raw ?? {});
	} catch (error) {
		if (error instanceof z.ZodError) {
			throw new ValidationFailed(
				`Invalid \`${type}\` config: ${
					error.issues.map((issue) => `${issue.path.join(".") || "config"} — ${issue.message}`)
						.join("; ")
				}`,
			);
		}
		throw error;
	}
}

export function windowKindOf(type: RuleType): WindowKind | null {
	return SPECS[type].windowKind;
}

export function windowMsOf(type: RuleType, config: RuleConfig): number {
	return SPECS[type].windowMs(config);
}

export function evaluateRule(
	rule: Pick<AutomodRule, "type" | "config" | "severity">,
	message: AutomodMessage,
	window: WindowResult | null,
): Match | null {
	const found = SPECS[rule.type].evaluate(message, rule.config, window);
	return found ? { ...found, severity: rule.severity } : null;
}

export function defaultActions(type: RuleType): AutomodActions {
	if (type === "new_account") {
		return { delete: false, warn: false, timeoutMs: null, notifyStaff: true, createCase: false };
	}
	return { delete: true, warn: false, timeoutMs: null, notifyStaff: false, createCase: false };
}

export function describeActions(actions: AutomodActions): string {
	const parts: string[] = [];
	if (actions.delete) parts.push("delete");
	if (actions.warn) parts.push("warn");
	if (actions.timeoutMs) parts.push(`timeout ${formatDuration(actions.timeoutMs)}`);
	if (actions.notifyStaff) parts.push("notify staff");
	if (actions.createCase) parts.push("create case");
	return parts.length ? parts.join(" · ") : "log only";
}

export function describeRule(rule: AutomodRule): string {
	const lines = [
		`**${rule.name}** · \`${rule.type}\` · ${rule.enabled ? "enabled" : "disabled"}`,
		SPECS[rule.type].describe(rule.config),
		`Actions: ${describeActions(rule.actions)}`,
		`Severity ${rule.severity} · cooldown ${rule.cooldownSeconds}s`,
	];
	if (rule.exemptRoleIds.length) {
		lines.push(`Exempt roles: ${rule.exemptRoleIds.map(roleMention).join(" ")}`);
	}
	if (rule.exemptChannelIds.length) {
		lines.push(`Exempt channels: ${rule.exemptChannelIds.map(channelMention).join(" ")}`);
	}
	lines.push(`Escalation: ${ESCALATION_LADDER}`);
	return lines.join("\n");
}
