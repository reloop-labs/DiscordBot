import { BitwisePermissionFlags } from "@discordeno/bot";
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../../database/client.ts";
import { type AutomodActions, automodRules } from "../../database/schema/automod.ts";
import type { DiscordApi, GuildSnapshot } from "../../discord/adapters/discord-api.ts";
import { DiscordLogService, LOG_COLORS } from "../../discord/logging/discord-log.ts";
import type { Logger } from "../../logging/logger.ts";
import { assertCanModerate, basePermissions } from "../../permissions/hierarchy.ts";
import type { PermissionService } from "../../permissions/service.ts";
import type { KeyValueStore } from "../../redis/client.ts";
import { formatDuration } from "../../shared/duration.ts";
import { NotFound, ValidationFailed } from "../../shared/errors.ts";
import {
	channelMention,
	escapeMarkdown,
	roleMention,
	truncate,
	userMention,
} from "../../shared/text.ts";
import type { GuildConfigService } from "../guild-config/service.ts";
import type { CaseService } from "../moderation/case-service.ts";
import {
	type AutomodMessage,
	type AutomodRule,
	contentExcerpt,
	defaultActions,
	describeActions,
	evaluateRule,
	fingerprintContent,
	type Match,
	parseRuleConfig,
	type RuleType,
	type WindowKind,
	windowKindOf,
	windowMsOf,
	type WindowResult,
} from "./rules.ts";

export type { AutomodMessage, AutomodRule } from "./rules.ts";

export interface Decision {
	rule: AutomodRule;
	matches: Match[];
	actions: AutomodActions;
	escalationLevel: number;
	reason: string;
}

export interface RuleInput {
	name: string;
	type: RuleType;
	config?: unknown;
	actions?: Partial<AutomodActions>;
	exemptRoleIds?: bigint[];
	exemptChannelIds?: bigint[];
	cooldownSeconds?: number;
	severity?: number;
}

export type RulePatch = Partial<Omit<RuleInput, "name" | "type">>;

export const MAX_RULES_PER_GUILD = 50;
export const MAX_RULE_NAME_LENGTH = 64;

const CACHE_TTL_MS = 60_000;
const ESCALATION_TTL_MS = 3_600_000;
const ESCALATION_WARN_TIMEOUT_MS = 600_000;
const ESCALATION_HARD_TIMEOUT_MS = 3_600_000;

const STAFF_BITS = BigInt(BitwisePermissionFlags.MANAGE_MESSAGES) |
	BigInt(BitwisePermissionFlags.ADMINISTRATOR);

function actionStrength(actions: AutomodActions): number {
	if (actions.timeoutMs) return 4;
	if (actions.warn) return 3;
	if (actions.delete) return 2;
	if (actions.notifyStaff) return 1;
	return 0;
}

function mergeActions(base: AutomodActions, patch: Partial<AutomodActions> | undefined) {
	return {
		delete: patch?.delete ?? base.delete,
		warn: patch?.warn ?? base.warn,
		timeoutMs: patch?.timeoutMs === undefined ? base.timeoutMs : patch.timeoutMs,
		notifyStaff: patch?.notifyStaff ?? base.notifyStaff,
		createCase: patch?.createCase ?? base.createCase,
	};
}

function unionActions(all: AutomodActions[]): AutomodActions {
	return {
		delete: all.some((a) => a.delete),
		warn: all.some((a) => a.warn),
		timeoutMs: all.reduce<number | null>(
			(max, a) => (a.timeoutMs && a.timeoutMs > (max ?? 0) ? a.timeoutMs : max),
			null,
		),
		notifyStaff: all.some((a) => a.notifyStaff),
		createCase: all.some((a) => a.createCase),
	};
}

function requireName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) throw new ValidationFailed("Rule name cannot be empty.");
	if (trimmed.length > MAX_RULE_NAME_LENGTH) {
		throw new ValidationFailed(`Rule name must be ${MAX_RULE_NAME_LENGTH} characters or fewer.`);
	}
	return trimmed;
}

function requireSeverity(severity: number): number {
	if (!Number.isInteger(severity) || severity < 1 || severity > 10) {
		throw new ValidationFailed("Severity must be a whole number between 1 and 10.");
	}
	return severity;
}

function requireCooldown(seconds: number): number {
	if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86_400) {
		throw new ValidationFailed("Cooldown must be between 0 and 86400 seconds.");
	}
	return seconds;
}

async function hash(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 16);
}

export class AutomodService {
	#cache = new Map<string, { rules: AutomodRule[]; expiresAt: number }>();

	constructor(
		private readonly api: DiscordApi,
		private readonly db: Database,
		private readonly store: KeyValueStore,
		private readonly cases: CaseService,
		private readonly config: GuildConfigService,
		private readonly permissions: PermissionService,
		private readonly discordLog: DiscordLogService,
		private readonly logger: Logger,
	) {}

	invalidate(guildId: bigint): void {
		this.#cache.delete(String(guildId));
	}

	async list(guildId: bigint): Promise<AutomodRule[]> {
		return await this.db
			.select()
			.from(automodRules)
			.where(eq(automodRules.guildId, guildId))
			.orderBy(automodRules.name);
	}

	async get(guildId: bigint, name: string): Promise<AutomodRule> {
		const [row] = await this.db
			.select()
			.from(automodRules)
			.where(and(eq(automodRules.guildId, guildId), eq(automodRules.name, name.trim())));
		if (!row) throw new NotFound(`The automod rule \`${escapeMarkdown(name)}\``);
		return row;
	}

	async create(guildId: bigint, input: RuleInput, actorId: bigint): Promise<AutomodRule> {
		const name = requireName(input.name);
		const [counted] = await this.db
			.select({ count: sql<number>`count(*)::int` })
			.from(automodRules)
			.where(eq(automodRules.guildId, guildId));
		if ((counted?.count ?? 0) >= MAX_RULES_PER_GUILD) {
			throw new ValidationFailed(`A server can have at most ${MAX_RULES_PER_GUILD} automod rules.`);
		}
		const [row] = await this.db
			.insert(automodRules)
			.values({
				guildId,
				name,
				type: input.type,
				config: parseRuleConfig(input.type, input.config),
				actions: mergeActions(defaultActions(input.type), input.actions),
				exemptRoleIds: input.exemptRoleIds ?? [],
				exemptChannelIds: input.exemptChannelIds ?? [],
				cooldownSeconds: requireCooldown(input.cooldownSeconds ?? 30),
				severity: requireSeverity(input.severity ?? 1),
				createdBy: actorId,
			})
			.onConflictDoNothing()
			.returning();
		if (!row) {
			throw new ValidationFailed(`A rule named \`${escapeMarkdown(name)}\` already exists.`);
		}
		this.invalidate(guildId);
		return row;
	}

	async update(guildId: bigint, name: string, patch: RulePatch): Promise<AutomodRule> {
		const existing = await this.get(guildId, name);
		const [row] = await this.db
			.update(automodRules)
			.set({
				config: patch.config === undefined
					? existing.config
					: parseRuleConfig(existing.type, patch.config),
				actions: mergeActions(existing.actions, patch.actions),
				exemptRoleIds: patch.exemptRoleIds ?? existing.exemptRoleIds,
				exemptChannelIds: patch.exemptChannelIds ?? existing.exemptChannelIds,
				cooldownSeconds: requireCooldown(patch.cooldownSeconds ?? existing.cooldownSeconds),
				severity: requireSeverity(patch.severity ?? existing.severity),
			})
			.where(eq(automodRules.id, existing.id))
			.returning();
		this.invalidate(guildId);
		return row!;
	}

	async toggle(guildId: bigint, name: string, enabled: boolean): Promise<AutomodRule> {
		const existing = await this.get(guildId, name);
		const [row] = await this.db
			.update(automodRules)
			.set({ enabled })
			.where(eq(automodRules.id, existing.id))
			.returning();
		this.invalidate(guildId);
		return row!;
	}

	async delete(guildId: bigint, name: string): Promise<AutomodRule> {
		const existing = await this.get(guildId, name);
		await this.db.delete(automodRules).where(eq(automodRules.id, existing.id));
		this.invalidate(guildId);
		return existing;
	}

	async enabledRules(guildId: bigint): Promise<AutomodRule[]> {
		const cached = this.#cache.get(String(guildId));
		if (cached && cached.expiresAt > Date.now()) return cached.rules;
		const rules = await this.db
			.select()
			.from(automodRules)
			.where(and(eq(automodRules.guildId, guildId), eq(automodRules.enabled, true)));
		this.#cache.set(String(guildId), { rules, expiresAt: Date.now() + CACHE_TTL_MS });
		return rules;
	}

	async evaluate(message: AutomodMessage): Promise<Decision | null> {
		if (message.authorIsBot) return null;
		const rules = await this.enabledRules(message.guildId);
		if (!rules.length) return null;
		const held = new Set(message.authorRoleIds.map(String));
		const applicable = rules.filter((rule) =>
			!rule.exemptChannelIds.some((id) => id === message.channelId) &&
			!rule.exemptRoleIds.some((id) => held.has(String(id)))
		);
		if (!applicable.length) return null;

		const windows = new Map<WindowKind, WindowResult | null>();
		const windowFor = async (rule: AutomodRule): Promise<WindowResult | null> => {
			const kind = windowKindOf(rule.type);
			if (!kind) return null;
			if (windows.has(kind)) return windows.get(kind) ?? null;
			const windowMs = windowMsOf(rule.type, rule.config);
			const count = await this.#countWindow(kind, message, windowMs);
			const result = count === null ? null : { count };
			windows.set(kind, result);
			return result;
		};

		const hits: { rule: AutomodRule; match: Match }[] = [];
		for (const rule of applicable) {
			const window = await windowFor(rule);
			if (windowKindOf(rule.type) && !window) continue;
			const found = evaluateRule(rule, message, window);
			if (!found) continue;
			if (await this.#isOwnGuildInvite(rule, found, message.guildId)) continue;
			hits.push({ rule, match: found });
		}
		if (!hits.length) return null;

		const guild = await this.api.getGuild(message.guildId);
		if (!guild) return null;
		const bits = basePermissions(guild, {
			userId: message.authorId,
			roleIds: message.authorRoleIds,
		});
		if ((bits & STAFF_BITS) !== 0n) return null;

		const winner = hits.reduce((best, current) =>
			current.match.severity > best.match.severity ||
				(current.match.severity === best.match.severity &&
					actionStrength(current.rule.actions) > actionStrength(best.rule.actions))
				? current
				: best
		);
		let actions = unionActions(hits.map((hit) => hit.rule.actions));

		const allowed = winner.rule.cooldownSeconds <= 0 || await this.store.acquireLock(
			`am:cd:${message.guildId}:${message.authorId}:${winner.rule.id}`,
			winner.rule.cooldownSeconds * 1000,
		);
		let escalationLevel = 0;
		if (!allowed) {
			actions = {
				delete: actions.delete,
				warn: false,
				timeoutMs: null,
				notifyStaff: false,
				createCase: false,
			};
		} else {
			escalationLevel = await this.store.incrWithTtl(
				`am:esc:${message.guildId}:${message.authorId}`,
				ESCALATION_TTL_MS,
			) ?? 0;
			if (actions.warn && !actions.timeoutMs) {
				if (escalationLevel >= 5) actions.timeoutMs = ESCALATION_HARD_TIMEOUT_MS;
				else if (escalationLevel >= 3) actions.timeoutMs = ESCALATION_WARN_TIMEOUT_MS;
			}
		}

		return {
			rule: winner.rule,
			matches: hits.map((hit) => hit.match),
			actions,
			escalationLevel,
			reason: `${winner.rule.name} — ${winner.match.reason}`,
		};
	}

	async enforce(message: AutomodMessage, decision: Decision): Promise<void> {
		const { actions } = decision;
		if (actions.delete) {
			await this.api
				.deleteMessage(message.channelId, message.messageId, `Automod: ${decision.rule.name}`)
				.catch((error) =>
					this.logger.warn("automod delete failed", {
						guildId: message.guildId,
						messageId: message.messageId,
						error,
					})
				);
		}

		const guild = actions.timeoutMs || actions.warn
			? await this.api.getGuild(message.guildId)
			: null;
		let timedOutMs: number | null = null;
		if (actions.timeoutMs && guild) {
			timedOutMs = await this.#timeout(message, guild, actions.timeoutMs, decision);
		}

		if (actions.createCase || timedOutMs) {
			await this.cases
				.create({
					guildId: message.guildId,
					action: "automod",
					targetUserId: message.authorId,
					moderatorUserId: this.api.botUserId(),
					reason: truncate(`Automod: ${decision.reason}`, 512),
					durationMs: timedOutMs,
					evidence: { messageIds: [String(message.messageId)] },
					metadata: {
						rule: decision.rule.name,
						ruleType: decision.rule.type,
						escalationLevel: decision.escalationLevel,
						matches: decision.matches.map((m) => m.reason),
					},
				})
				.catch((error) =>
					this.logger.error("automod case failed", { guildId: message.guildId, error })
				);
		}

		if ((actions.warn || timedOutMs) && guild) {
			const lines = [
				`Automod in **${escapeMarkdown(guild.name)}** acted on your message.`,
				`Rule: ${escapeMarkdown(decision.reason)}`,
			];
			if (timedOutMs) lines.push(`You are timed out for ${formatDuration(timedOutMs)}.`);
			await this.api
				.sendDirectMessage(message.authorId, { content: lines.join("\n") })
				.catch(() => false);
		}

		await this.#log(message, decision, timedOutMs);
	}

	async handle(message: AutomodMessage): Promise<void> {
		try {
			const decision = await this.evaluate(message);
			if (decision) await this.enforce(message, decision);
		} catch (error) {
			this.logger.error("automod failed", {
				guildId: message.guildId,
				messageId: message.messageId,
				error,
			});
		}
	}

	async #isOwnGuildInvite(rule: AutomodRule, found: Match, guildId: bigint): Promise<boolean> {
		if (rule.type !== "invite_link" || !found.data?.code) return false;
		const config = rule.config as { allowOwnGuild?: boolean };
		if (config.allowOwnGuild === false) return false;
		try {
			return (await this.api.getInviteGuildId(found.data.code)) === guildId;
		} catch {
			return false;
		}
	}

	async #countWindow(
		kind: WindowKind,
		message: AutomodMessage,
		windowMs: number,
	): Promise<number | null> {
		if (kind === "rate") {
			return await this.store.slidingWindowAdd(
				`am:rate:${message.guildId}:${message.authorId}`,
				windowMs,
			);
		}
		if (kind === "hop") {
			return await this.store.slidingWindowAdd(
				`am:hop:${message.guildId}:${message.authorId}`,
				windowMs,
				String(message.channelId),
			);
		}
		const fingerprint = fingerprintContent(message.content);
		if (!fingerprint) return null;
		return await this.store.incrWithTtl(
			`am:rep:${message.guildId}:${message.authorId}:${await hash(fingerprint)}`,
			windowMs,
		);
	}

	async #timeout(
		message: AutomodMessage,
		guild: GuildSnapshot,
		timeoutMs: number,
		decision: Decision,
	): Promise<number | null> {
		const guildId = guild.id;
		try {
			const [bot, target] = await Promise.all([
				this.api.getMember(guildId, this.api.botUserId()),
				this.api.getMember(guildId, message.authorId),
			]);
			if (!bot || !target) return null;
			assertCanModerate({
				guild,
				actor: bot,
				bot,
				target,
				targetUserId: message.authorId,
				requiredBotPermission: BitwisePermissionFlags.MODERATE_MEMBERS,
				requiredBotPermissionName: "Moderate Members",
			});
			await this.api.timeoutMember(
				guildId,
				message.authorId,
				new Date(Date.now() + timeoutMs),
				truncate(`Automod: ${decision.reason}`, 512),
			);
			return timeoutMs;
		} catch (error) {
			this.logger.warn("automod timeout skipped", {
				guildId,
				userId: message.authorId,
				rule: decision.rule.name,
				error,
			});
			return null;
		}
	}

	async #log(
		message: AutomodMessage,
		decision: Decision,
		timedOutMs: number | null,
	): Promise<void> {
		const taken = describeActions({ ...decision.actions, timeoutMs: timedOutMs });
		const settings = await this.config.get(message.guildId);
		const alertRoleId = decision.actions.notifyStaff ? settings.raidAlertRoleId : null;
		await this.discordLog.post(message.guildId, "automod", {
			content: alertRoleId ? roleMention(alertRoleId) : undefined,
			allowedMentions: alertRoleId ? { parse: [], roles: [alertRoleId] } : undefined,
			embeds: [{
				title: `Automod · ${decision.rule.name}`,
				color: timedOutMs ? LOG_COLORS.danger : LOG_COLORS.warning,
				timestamp: new Date().toISOString(),
				fields: [
					{
						name: "User",
						value: `${userMention(message.authorId)} (${message.authorId})`,
						inline: true,
					},
					{ name: "Channel", value: channelMention(message.channelId), inline: true },
					{ name: "Rule", value: `\`${decision.rule.type}\``, inline: true },
					{ name: "Action taken", value: taken, inline: true },
					{ name: "Escalation", value: `Level ${decision.escalationLevel}`, inline: true },
					{
						name: "Triggered",
						value: truncate(decision.matches.map((m) => m.reason).join("\n"), 1000),
						inline: false,
					},
					{ name: "Message", value: contentExcerpt(message.content, 500), inline: false },
				],
			}],
		});
	}
}
