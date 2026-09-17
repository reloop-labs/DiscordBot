import { sql } from "drizzle-orm";
import type { Transaction } from "./client.ts";
import { guildSequences } from "./schema/index.ts";

export type SequenceKind = "case" | "ticket" | "report" | "suggestion";

export async function nextSequence(
	tx: Transaction,
	guildId: bigint,
	kind: SequenceKind,
): Promise<number> {
	const [row] = await tx
		.insert(guildSequences)
		.values({ guildId, kind, value: 1 })
		.onConflictDoUpdate({
			target: [guildSequences.guildId, guildSequences.kind],
			set: { value: sql`${guildSequences.value} + 1` },
		})
		.returning({ value: guildSequences.value });
	return row!.value;
}
