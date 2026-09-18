import { and, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import type { Database, Transaction } from "../../database/client.ts";
import { nextSequence } from "../../database/sequences.ts";
import {
	type CaseEvidence,
	moderationCaseNotes,
	moderationCases,
	staffNotes,
} from "../../database/schema/index.ts";
import { CaseNotFound, ValidationFailed } from "../../shared/errors.ts";

export type ModerationCase = typeof moderationCases.$inferSelect;
export type CaseAction = ModerationCase["action"];

export interface CreateCaseInput {
	guildId: bigint;
	action: CaseAction;
	targetUserId: bigint;
	moderatorUserId: bigint;
	reason: string | null;
	durationMs?: number | null;
	evidence?: Partial<CaseEvidence>;
	metadata?: Record<string, unknown>;
}

export const MAX_REASON_LENGTH = 512;

export function normalizeReason(reason: string | null | undefined): string | null {
	const trimmed = reason?.trim() ?? "";
	if (!trimmed) return null;
	if (trimmed.length > MAX_REASON_LENGTH) {
		throw new ValidationFailed(`Reason must be ${MAX_REASON_LENGTH} characters or fewer.`);
	}
	return trimmed;
}

export class CaseService {
	#db: Database;

	constructor(db: Database) {
		this.#db = db;
	}

	create(input: CreateCaseInput, tx?: Transaction): Promise<ModerationCase> {
		const run = async (t: Transaction) => {
			const caseNumber = await nextSequence(t, input.guildId, "case");
			const [row] = await t
				.insert(moderationCases)
				.values({
					guildId: input.guildId,
					caseNumber,
					action: input.action,
					targetUserId: input.targetUserId,
					moderatorUserId: input.moderatorUserId,
					reason: normalizeReason(input.reason),
					durationMs: input.durationMs ?? null,
					expiresAt: input.durationMs ? new Date(Date.now() + input.durationMs) : null,
					evidence: { urls: [], messageIds: [], attachments: [], ...input.evidence },
					metadata: input.metadata ?? {},
				})
				.returning();
			return row!;
		};
		return tx ? run(tx) : this.#db.transaction(run);
	}

	async getByNumber(guildId: bigint, caseNumber: number): Promise<ModerationCase> {
		const [row] = await this.#db
			.select()
			.from(moderationCases)
			.where(and(eq(moderationCases.guildId, guildId), eq(moderationCases.caseNumber, caseNumber)));
		if (!row) throw new CaseNotFound(caseNumber);
		return row;
	}

	async historyFor(guildId: bigint, targetUserId: bigint, limit = 25): Promise<ModerationCase[]> {
		return await this.#db
			.select()
			.from(moderationCases)
			.where(
				and(eq(moderationCases.guildId, guildId), eq(moderationCases.targetUserId, targetUserId)),
			)
			.orderBy(desc(moderationCases.caseNumber))
			.limit(limit);
	}

	async countActive(guildId: bigint, targetUserId: bigint, action: CaseAction): Promise<number> {
		const [row] = await this.#db
			.select({ count: sql<number>`count(*)::int` })
			.from(moderationCases)
			.where(
				and(
					eq(moderationCases.guildId, guildId),
					eq(moderationCases.targetUserId, targetUserId),
					eq(moderationCases.action, action),
					eq(moderationCases.status, "active"),
				),
			);
		return row?.count ?? 0;
	}

	async updateReason(
		guildId: bigint,
		caseNumber: number,
		reason: string | null,
	): Promise<ModerationCase> {
		const existing = await this.getByNumber(guildId, caseNumber);
		const [row] = await this.#db
			.update(moderationCases)
			.set({ reason: normalizeReason(reason) })
			.where(eq(moderationCases.id, existing.id))
			.returning();
		return row!;
	}

	async setLogMessage(caseId: string, logMessageId: bigint | null): Promise<void> {
		await this.#db.update(moderationCases).set({ logMessageId }).where(
			eq(moderationCases.id, caseId),
		);
	}

	async setDmStatus(caseId: string, dmDelivered: ModerationCase["dmDelivered"]): Promise<void> {
		await this.#db.update(moderationCases).set({ dmDelivered }).where(
			eq(moderationCases.id, caseId),
		);
	}

	async void(
		guildId: bigint,
		caseNumber: number,
		voidedBy: bigint,
		reason: string | null,
	): Promise<ModerationCase> {
		const existing = await this.getByNumber(guildId, caseNumber);
		if (existing.status === "voided") {
			throw new ValidationFailed(`Case #${caseNumber} is already voided.`);
		}
		const [row] = await this.#db
			.update(moderationCases)
			.set({
				status: "voided",
				voidedBy,
				voidedAt: new Date(),
				voidReason: normalizeReason(reason),
			})
			.where(eq(moderationCases.id, existing.id))
			.returning();
		return row!;
	}

	async expireDue(now = new Date()): Promise<ModerationCase[]> {
		return await this.#db
			.update(moderationCases)
			.set({ status: "expired" })
			.where(
				and(
					eq(moderationCases.status, "active"),
					isNotNull(moderationCases.expiresAt),
					lte(moderationCases.expiresAt, now),
				),
			)
			.returning();
	}

	async addCaseNote(caseId: string, authorId: bigint, content: string): Promise<void> {
		await this.#db.insert(moderationCaseNotes).values({
			caseId,
			authorId,
			content: requireContent(content),
		});
	}

	async caseNotes(caseId: string) {
		return await this.#db
			.select()
			.from(moderationCaseNotes)
			.where(eq(moderationCaseNotes.caseId, caseId))
			.orderBy(moderationCaseNotes.createdAt);
	}

	async addStaffNote(guildId: bigint, userId: bigint, authorId: bigint, content: string) {
		const [row] = await this.#db
			.insert(staffNotes)
			.values({ guildId, userId, authorId, content: requireContent(content) })
			.returning();
		return row!;
	}

	async staffNotes(guildId: bigint, userId: bigint) {
		return await this.#db
			.select()
			.from(staffNotes)
			.where(
				and(
					eq(staffNotes.guildId, guildId),
					eq(staffNotes.userId, userId),
					sql`${staffNotes.deletedAt} is null`,
				),
			)
			.orderBy(desc(staffNotes.createdAt))
			.limit(25);
	}

	async deleteStaffNoteByPrefix(
		guildId: bigint,
		idPrefix: string,
		deletedBy: bigint,
	): Promise<boolean> {
		if (!/^[0-9a-f-]{4,36}$/i.test(idPrefix)) return false;
		const rows = await this.#db
			.update(staffNotes)
			.set({ deletedAt: new Date(), deletedBy })
			.where(
				and(
					eq(staffNotes.guildId, guildId),
					sql`${staffNotes.id}::text like ${`${idPrefix.toLowerCase()}%`}`,
					sql`${staffNotes.deletedAt} is null`,
				),
			)
			.returning({ id: staffNotes.id });
		return rows.length > 0;
	}
}

function requireContent(content: string): string {
	const trimmed = content.trim();
	if (!trimmed) throw new ValidationFailed("Note content cannot be empty.");
	if (trimmed.length > 1000) throw new ValidationFailed("Notes must be 1000 characters or fewer.");
	return trimmed;
}
