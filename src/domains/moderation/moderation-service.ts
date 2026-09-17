import { BitwisePermissionFlags } from "@discordeno/bot";
import type { DiscordApi, MemberSnapshot } from "../../discord/adapters/discord-api.ts";
import { DiscordLogService, LOG_COLORS } from "../../discord/logging/discord-log.ts";
import type { Logger } from "../../logging/logger.ts";
import { assertCanModerate } from "../../permissions/hierarchy.ts";
import type { ActorContext } from "../../permissions/actor.ts";
import type { Permission } from "../../permissions/keys.ts";
import type { PermissionService } from "../../permissions/service.ts";
import { MemberNotFound, ValidationFailed } from "../../shared/errors.ts";
import { formatDuration, MAX_TIMEOUT_MS } from "../../shared/duration.ts";
import { escapeMarkdown, truncate, userMention } from "../../shared/text.ts";
import type { GuildConfigService } from "../guild-config/service.ts";
import { type CaseAction, CaseService, type ModerationCase } from "./case-service.ts";

export interface ModerationTarget {
	userId: bigint;
	username: string;
	member: MemberSnapshot | null;
}

export interface ActionInput {
	actor: ActorContext;
	target: ModerationTarget;
	reason: string | null;
	durationMs?: number;
	deleteMessageSeconds?: number;
}

export interface ActionResult {
	case: ModerationCase;
	dmDelivered: boolean;
}

const ACTION_LABEL: Record<CaseAction, string> = {
	warn: "Warned",
	timeout: "Timed out",
	untimeout: "Timeout removed",
	kick: "Kicked",
	ban: "Banned",
	unban: "Unbanned",
	automod: "Automod",
};

const ACTION_COLOR: Record<CaseAction, number> = {
	warn: LOG_COLORS.warning,
	timeout: LOG_COLORS.warning,
	untimeout: LOG_COLORS.success,
	kick: LOG_COLORS.danger,
	ban: LOG_COLORS.danger,
	unban: LOG_COLORS.success,
	automod: LOG_COLORS.neutral,
};

const ACTION_PERMISSION: Record<Exclude<CaseAction, "automod">, Permission> = {
	warn: "moderation.warn",
	timeout: "moderation.timeout",
	untimeout: "moderation.timeout",
	kick: "moderation.kick",
	ban: "moderation.ban",
	unban: "moderation.ban",
};

export class ModerationService {
	constructor(
		private readonly api: DiscordApi,
		private readonly cases: CaseService,
		private readonly permissions: PermissionService,
		private readonly config: GuildConfigService,
		private readonly discordLog: DiscordLogService,
		private readonly logger: Logger,
	) {}

	async warn(input: ActionInput): Promise<ActionResult> {
		await this.authorize(
			"warn",
			input,
			BitwisePermissionFlags.MODERATE_MEMBERS,
			"Moderate Members",
		);
		if (!input.target.member) throw new MemberNotFound();
		return this.record("warn", input, async () => {});
	}

	async timeout(input: ActionInput): Promise<ActionResult> {
		const durationMs = input.durationMs ?? 0;
		if (durationMs <= 0 || durationMs > MAX_TIMEOUT_MS) {
			throw new ValidationFailed("Timeout duration must be between 1 second and 28 days.");
		}
		await this.authorize(
			"timeout",
			input,
			BitwisePermissionFlags.MODERATE_MEMBERS,
			"Moderate Members",
		);
		if (!input.target.member) throw new MemberNotFound();
		const until = new Date(Date.now() + durationMs);
		return this.record(
			"timeout",
			input,
			() =>
				this.api.timeoutMember(
					input.actor.guild.id,
					input.target.userId,
					until,
					this.auditReason(input),
				),
		);
	}

	async untimeout(input: ActionInput): Promise<ActionResult> {
		await this.authorize(
			"untimeout",
			input,
			BitwisePermissionFlags.MODERATE_MEMBERS,
			"Moderate Members",
		);
		if (!input.target.member) throw new MemberNotFound();
		if (!input.target.member.communicationDisabledUntil) {
			throw new ValidationFailed("That member is not timed out.");
		}
		return this.record(
			"untimeout",
			input,
			() =>
				this.api.timeoutMember(
					input.actor.guild.id,
					input.target.userId,
					null,
					this.auditReason(input),
				),
		);
	}

	async kick(input: ActionInput): Promise<ActionResult> {
		await this.authorize("kick", input, BitwisePermissionFlags.KICK_MEMBERS, "Kick Members");
		if (!input.target.member) throw new MemberNotFound();
		return this.record(
			"kick",
			input,
			() => this.api.kickMember(input.actor.guild.id, input.target.userId, this.auditReason(input)),
			{ dmBefore: true },
		);
	}

	async ban(input: ActionInput): Promise<ActionResult> {
		await this.authorize("ban", input, BitwisePermissionFlags.BAN_MEMBERS, "Ban Members");
		return this.record(
			"ban",
			input,
			() =>
				this.api.banMember(input.actor.guild.id, input.target.userId, {
					deleteMessageSeconds: input.deleteMessageSeconds,
					reason: this.auditReason(input),
				}),
			{ dmBefore: true },
		);
	}

	async unban(input: ActionInput): Promise<ActionResult> {
		await this.authorize("unban", input, BitwisePermissionFlags.BAN_MEMBERS, "Ban Members");
		return this.record(
			"unban",
			input,
			() =>
				this.api.unbanMember(input.actor.guild.id, input.target.userId, this.auditReason(input)),
			{ dm: false },
		);
	}

	async logCase(
		guildId: bigint,
		moderationCase: ModerationCase,
		extra?: { dmDelivered?: boolean },
	): Promise<void> {
		const fields = [
			{
				name: "User",
				value: `${userMention(moderationCase.targetUserId)} (${moderationCase.targetUserId})`,
				inline: true,
			},
			{ name: "Moderator", value: userMention(moderationCase.moderatorUserId), inline: true },
		];
		if (moderationCase.durationMs) {
			fields.push({
				name: "Duration",
				value: formatDuration(moderationCase.durationMs),
				inline: true,
			});
		}
		fields.push({
			name: "Reason",
			value: moderationCase.reason ?? "*No reason provided*",
			inline: false,
		});
		if (extra?.dmDelivered === false && moderationCase.action !== "unban") {
			fields.push({ name: "DM", value: "Could not deliver", inline: true });
		}
		const messageId = await this.discordLog.embed(guildId, "moderation", {
			title: `${ACTION_LABEL[moderationCase.action]} · Case #${moderationCase.caseNumber}`,
			color: ACTION_COLOR[moderationCase.action],
			fields,
			footer: { text: `Case ${moderationCase.caseNumber}` },
		});
		if (messageId) await this.cases.setLogMessage(moderationCase.id, messageId);
	}

	private async authorize(
		action: Exclude<CaseAction, "automod">,
		input: ActionInput,
		botPermission: bigint,
		botPermissionName: string,
	): Promise<void> {
		await this.permissions.require(input.actor.actor, ACTION_PERMISSION[action]);
		assertCanModerate({
			guild: input.actor.guild,
			actor: input.actor.member,
			bot: input.actor.botMember,
			target: input.target.member,
			targetUserId: input.target.userId,
			requiredBotPermission: botPermission,
			requiredBotPermissionName: botPermissionName,
		});
	}

	private auditReason(input: ActionInput): string {
		const moderator = input.actor.member.username;
		return truncate(`${moderator}: ${input.reason ?? "No reason provided"}`, 512);
	}

	private async record(
		action: CaseAction,
		input: ActionInput,
		apply: () => Promise<void>,
		options: { dm?: boolean; dmBefore?: boolean } = {},
	): Promise<ActionResult> {
		const shouldDm = options.dm !== false &&
			(await this.config.get(input.actor.guild.id)).dmOnModeration;
		const created = await this.cases.create({
			guildId: input.actor.guild.id,
			action,
			targetUserId: input.target.userId,
			moderatorUserId: input.actor.actor.userId,
			reason: input.reason,
			durationMs: input.durationMs ?? null,
		});
		let dmDelivered = false;
		if (shouldDm && options.dmBefore) dmDelivered = await this.notify(input, created);
		try {
			await apply();
		} catch (error) {
			await this.cases.void(
				input.actor.guild.id,
				created.caseNumber,
				this.api.botUserId(),
				"Discord rejected the action",
			);
			throw error;
		}
		if (shouldDm && !options.dmBefore) dmDelivered = await this.notify(input, created);
		await this.cases.setDmStatus(
			created.id,
			shouldDm ? (dmDelivered ? "sent" : "failed") : "skipped",
		);
		this.logCase(input.actor.guild.id, created, { dmDelivered }).catch((error) =>
			this.logger.warn("moderation log failed", { caseNumber: created.caseNumber, error })
		);
		this.logger.info("moderation action", {
			guildId: input.actor.guild.id,
			action,
			caseNumber: created.caseNumber,
			targetUserId: input.target.userId,
			moderatorUserId: input.actor.actor.userId,
		});
		return { case: created, dmDelivered };
	}

	private async notify(input: ActionInput, moderationCase: ModerationCase): Promise<boolean> {
		const lines = [
			`You were **${ACTION_LABEL[moderationCase.action].toLowerCase()}** in **${
				escapeMarkdown(input.actor.guild.name)
			}**.`,
		];
		if (moderationCase.durationMs) {
			lines.push(`Duration: ${formatDuration(moderationCase.durationMs)}`);
		}
		lines.push(`Reason: ${moderationCase.reason ?? "No reason provided"}`);
		lines.push(`Case #${moderationCase.caseNumber}`);
		try {
			return await this.api.sendDirectMessage(input.target.userId, { content: lines.join("\n") });
		} catch (error) {
			this.logger.debug("dm failed", { userId: input.target.userId, error });
			return false;
		}
	}
}
