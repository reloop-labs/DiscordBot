import { ButtonStyles, MessageComponentTypes } from "@discordeno/bot";
import type { MessageComponents } from "@discordeno/bot";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "../../database/client.ts";
import { nextSequence } from "../../database/sequences.ts";
import { reportEvents, reports } from "../../database/schema/index.ts";
import type { DiscordApi, Embed } from "../../discord/adapters/discord-api.ts";
import { encodeCustomId } from "../../discord/interactions/custom-id.ts";
import { type DiscordLogService, LOG_COLORS } from "../../discord/logging/discord-log.ts";
import type { Logger } from "../../logging/logger.ts";
import type { ActorContext } from "../../permissions/actor.ts";
import type { PermissionService } from "../../permissions/service.ts";
import type { KeyValueStore } from "../../redis/client.ts";
import { CooldownActive, NotConfigured, NotFound, ValidationFailed } from "../../shared/errors.ts";
import { neutralizeMentions, truncate, userMention } from "../../shared/text.ts";
import type { AuditService } from "../audit/service.ts";
import type { GuildConfigService } from "../guild-config/service.ts";
import type { CaseService } from "../moderation/case-service.ts";

export type Report = typeof reports.$inferSelect;
export type ReportType = Report["type"];
export type ReportStatus = Report["status"];

export interface SubmitReportInput {
	guildId: bigint;
	reporterId: bigint;
	type: ReportType;
	targetUserId?: bigint;
	messageId?: bigint;
	channelId?: bigint;
	messageContent?: string;
	reason: string;
	evidence?: string;
}

export interface ReportDeps {
	api: DiscordApi;
	db: Database;
	store: KeyValueStore;
	config: GuildConfigService;
	permissions: PermissionService;
	cases: CaseService;
	discordLog: DiscordLogService;
	audit: AuditService;
	logger: Logger;
}

const RATE_WINDOW_MS = 600_000;
const RATE_LIMIT = 3;
const MIN_REASON = 10;
const MAX_REASON = 1000;
const MAX_EVIDENCE = 1000;
const OPEN_STATUSES: ReportStatus[] = ["open", "in_review"];

const STATUS_LABEL: Record<ReportStatus, string> = {
	open: "Open",
	in_review: "In review",
	resolved: "Resolved",
	dismissed: "Dismissed",
};

const STATUS_COLOR: Record<ReportStatus, number> = {
	open: LOG_COLORS.warning,
	in_review: LOG_COLORS.info,
	resolved: LOG_COLORS.success,
	dismissed: LOG_COLORS.neutral,
};

function isClosed(status: ReportStatus): boolean {
	return status === "resolved" || status === "dismissed";
}

function messageLink(guildId: bigint, channelId: bigint, messageId: bigint): string {
	return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

export function reportEmbed(report: Report): Embed {
	const fields: NonNullable<Embed["fields"]> = [
		{ name: "Status", value: STATUS_LABEL[report.status], inline: true },
		{ name: "Type", value: report.type, inline: true },
		{
			name: "Reporter",
			value: `${userMention(report.reporterId)} (${report.reporterId})`,
			inline: true,
		},
	];
	if (report.targetUserId) {
		fields.push({
			name: "Reported user",
			value: `${userMention(report.targetUserId)} (${report.targetUserId})`,
			inline: true,
		});
	}
	if (report.assignedTo) {
		fields.push({ name: "Assigned to", value: userMention(report.assignedTo), inline: true });
	}
	if (report.messageId && report.channelId) {
		fields.push({
			name: "Message",
			value: messageLink(report.guildId, report.channelId, report.messageId),
			inline: false,
		});
	}
	if (report.messageContent) {
		const excerpt = neutralizeMentions(truncate(report.messageContent, 500)).replaceAll(
			"```",
			"'''",
		);
		fields.push({ name: "Message content", value: `\`\`\`\n${excerpt}\n\`\`\``, inline: false });
	}
	fields.push({ name: "Reason", value: neutralizeMentions(report.reason), inline: false });
	if (report.evidence) {
		fields.push({ name: "Evidence", value: neutralizeMentions(report.evidence), inline: false });
	}
	if (report.resolution) {
		fields.push({
			name: "Resolution",
			value: neutralizeMentions(truncate(report.resolution, 1000)),
			inline: false,
		});
	}
	return {
		title: `Report #${report.reportNumber}`,
		color: STATUS_COLOR[report.status],
		fields,
		footer: { text: report.id },
		timestamp: report.createdAt.toISOString(),
	};
}

export function reportComponents(report: Report): MessageComponents {
	const closed = isClosed(report.status);
	return [{
		type: MessageComponentTypes.ActionRow,
		components: [
			{
				type: MessageComponentTypes.Button,
				label: "Claim",
				customId: encodeCustomId("report", "claim", report.id),
				style: ButtonStyles.Primary,
				disabled: closed || report.status === "in_review",
			},
			{
				type: MessageComponentTypes.Button,
				label: "Resolve",
				customId: encodeCustomId("report", "resolve", report.id),
				style: ButtonStyles.Success,
				disabled: closed,
			},
			{
				type: MessageComponentTypes.Button,
				label: "Dismiss",
				customId: encodeCustomId("report", "dismiss", report.id),
				style: ButtonStyles.Secondary,
				disabled: closed,
			},
			{
				type: MessageComponentTypes.Button,
				label: "Open case",
				customId: encodeCustomId("report", "case", report.id),
				style: ButtonStyles.Secondary,
				disabled: closed,
			},
		],
	}];
}

export class ReportService {
	constructor(private readonly deps: ReportDeps) {}

	async submit(input: SubmitReportInput): Promise<Report> {
		const { api, db, store, config } = this.deps;
		const reason = input.reason.trim();
		if (reason.length < MIN_REASON || reason.length > MAX_REASON) {
			throw new ValidationFailed(
				`Tell staff what happened in ${MIN_REASON} to ${MAX_REASON} characters.`,
			);
		}
		const evidence = input.evidence?.trim() || null;
		if (evidence && evidence.length > MAX_EVIDENCE) {
			throw new ValidationFailed(`Evidence must be ${MAX_EVIDENCE} characters or fewer.`);
		}
		if (input.targetUserId === input.reporterId) {
			throw new ValidationFailed("You cannot report yourself.");
		}
		if (input.targetUserId === api.botUserId()) {
			throw new ValidationFailed("You cannot report Loop. Talk to the staff team instead.");
		}
		const staffChannelId = (await config.get(input.guildId)).reportChannelId;
		if (!staffChannelId) throw new NotConfigured("Reports channel");

		const used = await store.incrWithTtl(
			`report:rate:${input.guildId}:${input.reporterId}`,
			RATE_WINDOW_MS,
		);
		if (used !== null && used > RATE_LIMIT) throw new CooldownActive(RATE_WINDOW_MS / 1000);
		await this.#assertNotDuplicate(input);

		const report = await db.transaction(async (tx) => {
			const reportNumber = await nextSequence(tx, input.guildId, "report");
			const [row] = await tx
				.insert(reports)
				.values({
					guildId: input.guildId,
					reportNumber,
					type: input.type,
					reporterId: input.reporterId,
					targetUserId: input.targetUserId ?? null,
					messageId: input.messageId ?? null,
					channelId: input.channelId ?? null,
					messageContent: input.messageContent ? truncate(input.messageContent, 2000) : null,
					reason,
					evidence,
				})
				.returning();
			await tx.insert(reportEvents).values({
				reportId: row!.id,
				type: "submitted",
				actorId: input.reporterId,
				data: { type: input.type },
			});
			return row!;
		});

		const posted = await this.#postToStaff(staffChannelId, report);
		return posted ? { ...report, staffChannelId, staffMessageId: posted } : report;
	}

	async claim(reportId: string, actor: ActorContext): Promise<Report> {
		const report = await this.#authorized(reportId, actor);
		if (isClosed(report.status)) {
			throw new ValidationFailed(`Report #${report.reportNumber} is already closed.`);
		}
		if (report.assignedTo) {
			throw new ValidationFailed(
				`Report #${report.reportNumber} is already claimed by <@${report.assignedTo}>.`,
			);
		}
		return await this.#apply(report, actor, "claimed", {
			status: "in_review",
			assignedTo: actor.actor.userId,
		});
	}

	resolve(reportId: string, actor: ActorContext, resolution: string): Promise<Report> {
		return this.#close(reportId, actor, "resolved", resolution);
	}

	dismiss(reportId: string, actor: ActorContext, resolution: string): Promise<Report> {
		return this.#close(reportId, actor, "dismissed", resolution);
	}

	async linkCase(reportId: string, actor: ActorContext, caseNumber: number): Promise<Report> {
		const report = await this.#authorized(reportId, actor);
		const linked = await this.deps.cases.getByNumber(report.guildId, caseNumber);
		return await this.#apply(report, actor, "case_linked", { caseId: linked.id }, {
			caseNumber,
		});
	}

	async get(guildId: bigint, reportNumber: number): Promise<Report> {
		const [row] = await this.deps.db
			.select()
			.from(reports)
			.where(and(eq(reports.guildId, guildId), eq(reports.reportNumber, reportNumber)));
		if (!row) throw new NotFound(`Report #${reportNumber}`);
		return row;
	}

	async listOpen(guildId: bigint, limit = 25): Promise<Report[]> {
		return await this.deps.db
			.select()
			.from(reports)
			.where(and(eq(reports.guildId, guildId), inArray(reports.status, OPEN_STATUSES)))
			.orderBy(desc(reports.reportNumber))
			.limit(limit);
	}

	async mine(guildId: bigint, reporterId: bigint, limit = 10): Promise<Report[]> {
		return await this.deps.db
			.select()
			.from(reports)
			.where(and(eq(reports.guildId, guildId), eq(reports.reporterId, reporterId)))
			.orderBy(desc(reports.reportNumber))
			.limit(limit);
	}

	async #close(
		reportId: string,
		actor: ActorContext,
		status: Extract<ReportStatus, "resolved" | "dismissed">,
		resolution: string,
	): Promise<Report> {
		const report = await this.#authorized(reportId, actor);
		if (isClosed(report.status)) {
			throw new ValidationFailed(`Report #${report.reportNumber} is already closed.`);
		}
		const text = resolution.trim();
		if (!text) throw new ValidationFailed("Say what you did so the record makes sense later.");
		if (text.length > MAX_REASON) {
			throw new ValidationFailed(`Resolution must be ${MAX_REASON} characters or fewer.`);
		}
		const updated = await this.#apply(report, actor, status, {
			status,
			resolution: text,
			assignedTo: report.assignedTo ?? actor.actor.userId,
		});
		await this.#notifyReporter(updated, status);
		return updated;
	}

	async #authorized(reportId: string, actor: ActorContext): Promise<Report> {
		await this.deps.permissions.require(actor.actor, "reports.manage");
		const [row] = await this.deps.db.select().from(reports).where(eq(reports.id, reportId));
		if (!row || row.guildId !== actor.actor.guildId) throw new NotFound("That report");
		return row;
	}

	async #apply(
		report: Report,
		actor: ActorContext,
		event: string,
		patch: Partial<typeof reports.$inferInsert>,
		data: Record<string, unknown> = {},
	): Promise<Report> {
		const { db, discordLog, audit } = this.deps;
		const [updated] = await db
			.update(reports)
			.set(patch)
			.where(eq(reports.id, report.id))
			.returning();
		const next = updated!;
		await db.insert(reportEvents).values({
			reportId: next.id,
			type: event,
			actorId: actor.actor.userId,
			data: { ...data, status: next.status },
		});
		await this.#refreshStaffMessage(next);
		await discordLog.embed(next.guildId, "reports", {
			title: `Report #${next.reportNumber} · ${event.replaceAll("_", " ")}`,
			color: STATUS_COLOR[next.status],
			fields: [
				{ name: "Staff", value: userMention(actor.actor.userId), inline: true },
				{ name: "Status", value: STATUS_LABEL[next.status], inline: true },
				...(next.resolution
					? [{ name: "Resolution", value: truncate(next.resolution, 1000), inline: false }]
					: []),
			],
		});
		await audit.record({
			guildId: next.guildId,
			actorId: actor.actor.userId,
			action: `report.${event}`,
			target: String(next.reportNumber),
			data,
		});
		return next;
	}

	async #assertNotDuplicate(input: SubmitReportInput): Promise<void> {
		const scope = input.messageId
			? eq(reports.messageId, input.messageId)
			: input.targetUserId
			? eq(reports.targetUserId, input.targetUserId)
			: null;
		if (!scope) return;
		const [existing] = await this.deps.db
			.select({ id: reports.id })
			.from(reports)
			.where(
				and(
					eq(reports.guildId, input.guildId),
					eq(reports.reporterId, input.reporterId),
					inArray(reports.status, OPEN_STATUSES),
					scope,
				),
			)
			.limit(1);
		if (existing) {
			throw new ValidationFailed("You already reported this. Staff will review it.");
		}
	}

	async #postToStaff(staffChannelId: bigint, report: Report): Promise<bigint | null> {
		try {
			const sent = await this.deps.api.sendMessage(staffChannelId, {
				embeds: [reportEmbed(report)],
				components: reportComponents(report),
			});
			if (!sent) return null;
			await this.deps.db
				.update(reports)
				.set({ staffChannelId, staffMessageId: sent.id })
				.where(eq(reports.id, report.id));
			return sent.id;
		} catch (error) {
			this.deps.logger.warn("report staff post failed", {
				guildId: report.guildId,
				reportNumber: report.reportNumber,
				error,
			});
			return null;
		}
	}

	async #refreshStaffMessage(report: Report): Promise<void> {
		if (!report.staffMessageId) return;
		const staffChannelId = report.staffChannelId ??
			(await this.deps.config.get(report.guildId)).reportChannelId;
		if (!staffChannelId) return;
		try {
			await this.deps.api.editMessage(staffChannelId, report.staffMessageId, {
				embeds: [reportEmbed(report)],
				components: reportComponents(report),
			});
		} catch (error) {
			this.deps.logger.warn("report staff message edit failed", {
				guildId: report.guildId,
				reportNumber: report.reportNumber,
				error,
			});
		}
	}

	async #notifyReporter(report: Report, status: ReportStatus): Promise<void> {
		try {
			await this.deps.api.sendDirectMessage(report.reporterId, {
				content: `Your report #${report.reportNumber} was ${STATUS_LABEL[status].toLowerCase()}. ` +
					"Thank you.",
			});
		} catch (error) {
			this.deps.logger.debug("report reporter dm failed", {
				reporterId: report.reporterId,
				error,
			});
		}
	}
}
