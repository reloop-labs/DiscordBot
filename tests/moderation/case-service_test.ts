import { assertEquals, assertRejects } from "@std/assert";
import { CaseService } from "../../src/domains/moderation/case-service.ts";
import { ValidationFailed } from "../../src/shared/errors.ts";
import { dbTest } from "../helpers/database.ts";
import { MOD_ID, TARGET_ID } from "../helpers/fake-discord.ts";

dbTest("case numbers are unique under concurrency", async (db, guildId) => {
	const cases = new CaseService(db);
	const created = await Promise.all(
		Array.from(
			{ length: 25 },
			() =>
				cases.create({
					guildId,
					action: "warn",
					targetUserId: TARGET_ID,
					moderatorUserId: MOD_ID,
					reason: "spam",
				}),
		),
	);
	const numbers = created.map((c) => c.caseNumber).sort((a, b) => a - b);
	assertEquals(numbers, Array.from({ length: 25 }, (_, i) => i + 1));
});

dbTest("voiding keeps the record and rejects double void", async (db, guildId) => {
	const cases = new CaseService(db);
	const c = await cases.create({
		guildId,
		action: "warn",
		targetUserId: TARGET_ID,
		moderatorUserId: MOD_ID,
		reason: "x",
	});
	const voided = await cases.void(guildId, c.caseNumber, MOD_ID, "mistake");
	assertEquals(voided.status, "voided");
	assertEquals(voided.voidReason, "mistake");
	assertEquals((await cases.historyFor(guildId, TARGET_ID)).length, 1);
	await assertRejects(() => cases.void(guildId, c.caseNumber, MOD_ID, null), ValidationFailed);
});

dbTest("reasons are trimmed and bounded", async (db, guildId) => {
	const cases = new CaseService(db);
	const c = await cases.create({
		guildId,
		action: "warn",
		targetUserId: TARGET_ID,
		moderatorUserId: MOD_ID,
		reason: "  hi  ",
	});
	assertEquals(c.reason, "hi");
	await assertRejects(
		() =>
			cases.create({
				guildId,
				action: "warn",
				targetUserId: TARGET_ID,
				moderatorUserId: MOD_ID,
				reason: "x".repeat(600),
			}),
		ValidationFailed,
	);
});

dbTest("staff notes soft delete by prefix", async (db, guildId) => {
	const cases = new CaseService(db);
	const note = await cases.addStaffNote(guildId, TARGET_ID, MOD_ID, "watch this one");
	assertEquals((await cases.staffNotes(guildId, TARGET_ID)).length, 1);
	assertEquals(await cases.deleteStaffNoteByPrefix(guildId, note.id.slice(0, 8), MOD_ID), true);
	assertEquals((await cases.staffNotes(guildId, TARGET_ID)).length, 0);
	assertEquals(await cases.deleteStaffNoteByPrefix(guildId, "zz", MOD_ID), false);
});
