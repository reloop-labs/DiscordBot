import { assertEquals, assertRejects } from "@std/assert";
import { DiscordLogService } from "../../src/discord/logging/discord-log.ts";
import { AuditService } from "../../src/domains/audit/service.ts";
import { GuildConfigService } from "../../src/domains/guild-config/service.ts";
import { CaseService } from "../../src/domains/moderation/case-service.ts";
import { ReportService } from "../../src/domains/reports/report-service.ts";
import { silentLogger } from "../../src/logging/logger.ts";
import { resolveActor } from "../../src/permissions/actor.ts";
import { PermissionService } from "../../src/permissions/service.ts";
import { createMemoryStore } from "../../src/redis/client.ts";
import {
	CaseNotFound,
	CooldownActive,
	NotConfigured,
	ValidationFailed,
} from "../../src/shared/errors.ts";
import { dbTest } from "../helpers/database.ts";
import {
	BOT_ID,
	FakeDiscordApi,
	MOD_ID,
	MOD_ROLE,
	OWNER_ID,
	TARGET_ID,
} from "../helpers/fake-discord.ts";

const REPORT_CHANNEL = 300000000000000001n;
const REPORTER = TARGET_ID;
const OFFENDER = 100000000000000009n;

async function setup(
	db: Parameters<Parameters<typeof dbTest>[1]>[0],
	guildId: bigint,
	options: { channel?: boolean } = {},
) {
	const api = new FakeDiscordApi();
	api.guildSnapshot.id = guildId;
	for (const m of api.members.values()) m.guildId = guildId;
	const config = new GuildConfigService(db);
	const permissions = new PermissionService(db);
	const cases = new CaseService(db);
	const store = createMemoryStore();
	if (options.channel !== false) {
		await config.update(guildId, { reportChannelId: REPORT_CHANNEL });
	}
	await permissions.grant(guildId, MOD_ROLE, "reports.manage", OWNER_ID);
	const reports = new ReportService({
		api,
		db,
		store,
		config,
		permissions,
		cases,
		discordLog: new DiscordLogService(api, config, silentLogger),
		audit: new AuditService(db, silentLogger),
		logger: silentLogger,
	});
	const actor = await resolveActor(api, guildId, MOD_ID);
	return { api, reports, cases, actor, config };
}

function submitUserReport(
	reports: ReportService,
	guildId: bigint,
	overrides: Partial<Parameters<ReportService["submit"]>[0]> = {},
) {
	return reports.submit({
		guildId,
		reporterId: REPORTER,
		type: "user",
		targetUserId: OFFENDER,
		reason: "They keep spamming links in general chat.",
		...overrides,
	});
}

dbTest("submit posts to the staff channel and numbers reports in order", async (db, guildId) => {
	const { api, reports } = await setup(db, guildId);
	const first = await submitUserReport(reports, guildId, {
		reason: "Pinging @everyone with junk links over and over.",
	});
	const second = await submitUserReport(reports, guildId, { targetUserId: MOD_ID });

	assertEquals([first.reportNumber, second.reportNumber], [1, 2]);
	assertEquals(api.sentMessages.length, 2);
	assertEquals(api.sentMessages[0]!.channelId, REPORT_CHANNEL);
	assertEquals(first.staffMessageId !== null, true);

	const embed = api.sentMessages[0]!.message.embeds![0]!;
	assertEquals(embed.title, "Report #1");
	const reason = embed.fields!.find((field) => field.name === "Reason")!.value;
	assertEquals(reason.includes("@everyone"), false);
	assertEquals(reason.includes("everyone"), true);
	const target = embed.fields!.find((field) => field.name === "Reported user")!.value;
	assertEquals(target.includes(String(OFFENDER)), true);
});

dbTest("a message report keeps a truncated, neutralized excerpt", async (db, guildId) => {
	const { api, reports } = await setup(db, guildId);
	await reports.submit({
		guildId,
		reporterId: REPORTER,
		type: "message",
		targetUserId: OFFENDER,
		messageId: 400000000000000001n,
		channelId: 500000000000000001n,
		messageContent: `@everyone ${"x".repeat(900)}`,
		reason: "Mass ping in a public channel.",
	});
	const embed = api.sentMessages[0]!.message.embeds![0]!;
	const link = embed.fields!.find((field) => field.name === "Message")!.value;
	assertEquals(
		link,
		`https://discord.com/channels/${guildId}/500000000000000001/400000000000000001`,
	);
	const content = embed.fields!.find((field) => field.name === "Message content")!.value;
	assertEquals(content.includes("@everyone"), false);
	assertEquals(content.length < 520, true);
});

dbTest("a fourth report inside the window is rate limited", async (db, guildId) => {
	const { reports } = await setup(db, guildId);
	for (const targetUserId of [OFFENDER, MOD_ID, BOT_ID + 1000n]) {
		await submitUserReport(reports, guildId, { targetUserId });
	}
	await assertRejects(
		() => submitUserReport(reports, guildId, { targetUserId: BOT_ID + 2000n }),
		CooldownActive,
	);
});

dbTest("the same reporter cannot open two reports on one target", async (db, guildId) => {
	const { reports } = await setup(db, guildId);
	await submitUserReport(reports, guildId);
	await assertRejects(() => submitUserReport(reports, guildId), ValidationFailed);
});

dbTest("self reports, bot reports and thin reasons are rejected", async (db, guildId) => {
	const { reports, api } = await setup(db, guildId);
	await assertRejects(
		() => submitUserReport(reports, guildId, { targetUserId: REPORTER }),
		ValidationFailed,
	);
	await assertRejects(
		() => submitUserReport(reports, guildId, { targetUserId: BOT_ID }),
		ValidationFailed,
	);
	await assertRejects(
		() => submitUserReport(reports, guildId, { reason: "bad" }),
		ValidationFailed,
	);
	assertEquals(api.sentMessages.length, 0);
});

dbTest("submitting without a reports channel is refused", async (db, guildId) => {
	const { reports } = await setup(db, guildId, { channel: false });
	await assertRejects(() => submitUserReport(reports, guildId), NotConfigured);
});

dbTest(
	"claim, resolve and dismiss move the report and edit the staff message",
	async (db, guildId) => {
		const { api, reports, actor } = await setup(db, guildId);
		const report = await submitUserReport(reports, guildId);

		const claimed = await reports.claim(report.id, actor);
		assertEquals(claimed.status, "in_review");
		assertEquals(claimed.assignedTo, MOD_ID);
		await assertRejects(() => reports.claim(report.id, actor), ValidationFailed);

		const resolved = await reports.resolve(report.id, actor, "Timed out for 1h.");
		assertEquals(resolved.status, "resolved");
		assertEquals(resolved.resolution, "Timed out for 1h.");
		await assertRejects(() => reports.dismiss(report.id, actor, "too late"), ValidationFailed);

		const edits = api.calledWith("editMessage");
		assertEquals(edits.length, 2);
		const lastEdit = edits[1]!.args[2] as { components: { components: { disabled: boolean }[] }[] };
		assertEquals(lastEdit.components[0]!.components.every((button) => button.disabled), true);
		assertEquals(api.dms.length, 1);
		assertEquals(api.dms[0]!.message.content?.includes("resolved"), true);

		assertEquals((await reports.listOpen(guildId)).length, 0);
		assertEquals((await reports.mine(guildId, REPORTER)).length, 1);
		assertEquals((await reports.get(guildId, report.reportNumber)).status, "resolved");
	},
);

dbTest("dismiss records the resolution and notifies the reporter", async (db, guildId) => {
	const { api, reports, actor } = await setup(db, guildId);
	const report = await submitUserReport(reports, guildId);
	const dismissed = await reports.dismiss(report.id, actor, "No rule was broken.");
	assertEquals(dismissed.status, "dismissed");
	assertEquals(api.dms[0]!.message.content?.includes("dismissed"), true);
	await assertRejects(() => reports.resolve(report.id, actor, ""), ValidationFailed);
});

dbTest("a failing reporter DM does not fail the resolve", async (db, guildId) => {
	const { api, reports, actor } = await setup(db, guildId);
	const report = await submitUserReport(reports, guildId);
	api.failNext = { method: "sendDirectMessage", error: new Error("closed dms") };
	const resolved = await reports.resolve(report.id, actor, "Warned them.");
	assertEquals(resolved.status, "resolved");
	assertEquals(api.dms.length, 0);
});

dbTest("linking a case validates the case number", async (db, guildId) => {
	const { reports, cases, actor } = await setup(db, guildId);
	const report = await submitUserReport(reports, guildId);
	await assertRejects(() => reports.linkCase(report.id, actor, 99), CaseNotFound);
	const created = await cases.create({
		guildId,
		action: "warn",
		targetUserId: OFFENDER,
		moderatorUserId: MOD_ID,
		reason: "spam",
	});
	const linked = await reports.linkCase(report.id, actor, created.caseNumber);
	assertEquals(linked.caseId, created.id);
});
