import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { MessageSnapshot } from "../../src/discord/adapters/discord-api.ts";
import { DiscordLogService } from "../../src/discord/logging/discord-log.ts";
import { AuditService } from "../../src/domains/audit/service.ts";
import { GuildConfigService } from "../../src/domains/guild-config/service.ts";
import { TicketService } from "../../src/domains/tickets/ticket-service.ts";
import type { TicketCategory } from "../../src/domains/tickets/ticket-service.ts";
import { TranscriptService } from "../../src/domains/tickets/transcript-service.ts";
import type { TranscriptStore } from "../../src/domains/tickets/transcript-store.ts";
import { silentLogger } from "../../src/logging/logger.ts";
import { resolveActor } from "../../src/permissions/actor.ts";
import { PermissionService } from "../../src/permissions/service.ts";
import { createMemoryStore, type KeyValueStore } from "../../src/redis/client.ts";
import { PermissionDenied, TicketAlreadyOpen, ValidationFailed } from "../../src/shared/errors.ts";
import { dbTest } from "../helpers/database.ts";
import {
	FakeDiscordApi,
	member,
	MEMBER_ROLE,
	MOD_ID,
	MOD_ROLE,
	OWNER_ID,
	TARGET_ID,
} from "../helpers/fake-discord.ts";

const OUTSIDER_ID = 100000000000000009n;
const PARENT_CHANNEL = 300000000000000001n;
const ARCHIVE_CATEGORY = 300000000000000002n;

type Db = Parameters<Parameters<typeof dbTest>[1]>[0];

function memoryTranscriptStore(): TranscriptStore & { items: Map<string, string> } {
	const items = new Map<string, string>();
	return {
		items,
		put(key, body) {
			const text = typeof body === "string" ? body : new TextDecoder().decode(body);
			items.set(key, text);
			return Promise.resolve({ sizeBytes: new TextEncoder().encode(text).byteLength });
		},
		get(key) {
			const found = items.get(key);
			return Promise.resolve(found === undefined ? null : new TextEncoder().encode(found));
		},
	};
}

async function setup(db: Db, guildId: bigint, store: KeyValueStore = createMemoryStore()) {
	const api = new FakeDiscordApi();
	api.guildSnapshot.id = guildId;
	api.members.set(
		String(OUTSIDER_ID),
		member(OUTSIDER_ID, [MEMBER_ROLE], { username: "outsider" }),
	);
	for (const m of api.members.values()) m.guildId = guildId;

	const config = new GuildConfigService(db);
	const permissions = new PermissionService(db);
	const transcriptStore = memoryTranscriptStore();
	const transcripts = new TranscriptService(api, db, transcriptStore, silentLogger);
	const tickets = new TicketService({
		api,
		db,
		store,
		config,
		permissions,
		audit: new AuditService(db, silentLogger),
		discordLog: new DiscordLogService(api, config, silentLogger),
		transcripts,
		logger: silentLogger,
	});
	for (const key of ["tickets.view", "tickets.claim"] as const) {
		await permissions.grant(guildId, MOD_ROLE, key, OWNER_ID);
	}
	const category = await tickets.createCategory(guildId, {
		name: "support",
		staffRoleIds: [MOD_ROLE],
	}, OWNER_ID);
	const actorOf = (userId: bigint) => resolveActor(api, guildId, userId);
	return { api, config, permissions, tickets, transcripts, transcriptStore, category, actorOf };
}

function messageIn(channelId: bigint, id: bigint, content: string): MessageSnapshot {
	return {
		id,
		channelId,
		authorId: TARGET_ID,
		authorUsername: "target",
		authorIsBot: false,
		content,
		createdAt: new Date("2025-02-02T10:00:00Z"),
		editedAt: null,
		attachments: [],
		embeds: [],
		referencedMessageId: null,
		pinned: false,
	};
}

dbTest("open creates a channel, ticket, participant and opening message", async (db, guildId) => {
	const { api, tickets, category } = await setup(db, guildId);
	const ticket = await tickets.open(guildId, TARGET_ID, category.id);

	assertEquals(ticket.ticketNumber, 1);
	assertEquals(ticket.status, "open");
	assertEquals(api.calledWith("createTextChannel").length, 1);

	const participants = await tickets.listParticipants(ticket.id);
	assertEquals(participants.map((p) => p.userId), [TARGET_ID]);

	const events = await tickets.listEvents(ticket.id);
	assertEquals(events.map((e) => e.type), ["opened"]);

	const opening = api.sentMessages.find((sent) => sent.channelId === ticket.channelId);
	assertEquals(opening?.message.allowedMentions, { users: [TARGET_ID], roles: [MOD_ROLE] });
	assertEquals(opening?.message.allowedMentions?.parse, undefined);
	assertStringIncludes(opening?.message.content ?? "", `<@${TARGET_ID}>`);
});

dbTest("a second ticket in the same category is refused", async (db, guildId) => {
	const { tickets, category } = await setup(db, guildId);
	await tickets.open(guildId, TARGET_ID, category.id);
	await assertRejects(() => tickets.open(guildId, TARGET_ID, category.id), TicketAlreadyOpen);
});

dbTest("other categories are allowed until the per-user cap", async (db, guildId) => {
	const { tickets, category } = await setup(db, guildId);
	const extra: TicketCategory[] = [];
	for (const name of ["billing", "appeals", "other"]) {
		extra.push(
			await tickets.createCategory(guildId, { name, staffRoleIds: [MOD_ROLE] }, OWNER_ID),
		);
	}
	await tickets.open(guildId, TARGET_ID, category.id);
	await tickets.open(guildId, TARGET_ID, extra[0]!.id);
	await tickets.open(guildId, TARGET_ID, extra[1]!.id);
	await assertRejects(
		() => tickets.open(guildId, TARGET_ID, extra[2]!.id),
		ValidationFailed,
		"3 open tickets",
	);
});

dbTest(
	"concurrent opens leave exactly one ticket and delete the extra channel",
	async (db, guildId) => {
		const unlockedStore: KeyValueStore = {
			...createMemoryStore(),
			acquireLock: () => Promise.resolve(true),
		};
		const { api, tickets, category } = await setup(db, guildId, unlockedStore);
		await Promise.all([db.execute("select 1"), db.execute("select 1"), db.execute("select 1")]);

		const results = await Promise.allSettled([
			tickets.open(guildId, TARGET_ID, category.id),
			tickets.open(guildId, TARGET_ID, category.id),
		]);
		const fulfilled = results.filter((r) => r.status === "fulfilled");
		const rejected = results.filter((r) => r.status === "rejected");
		assertEquals(fulfilled.length, 1);
		assertEquals(rejected.length, 1);
		assertEquals(rejected[0]!.reason instanceof TicketAlreadyOpen, true);
		assertEquals((await tickets.listOpen(guildId)).length, 1);
		assertEquals(api.calledWith("deleteChannel").length, 1);
	},
);

dbTest("claiming follows the claim and manage rules", async (db, guildId) => {
	const { permissions, tickets, category, actorOf } = await setup(db, guildId);
	await permissions.grant(guildId, MEMBER_ROLE, "tickets.claim", OWNER_ID);
	const ticket = await tickets.open(guildId, TARGET_ID, category.id);

	const mod = await actorOf(MOD_ID);
	const opener = await actorOf(TARGET_ID);
	const owner = await actorOf(OWNER_ID);

	const claimed = await tickets.claim(ticket.id, mod);
	assertEquals(claimed.claimedBy, MOD_ID);

	await assertRejects(() => tickets.claim(ticket.id, mod), ValidationFailed, "already claimed");
	await assertRejects(() => tickets.claim(ticket.id, opener), PermissionDenied);

	const stolen = await tickets.claim(ticket.id, owner);
	assertEquals(stolen.claimedBy, OWNER_ID);

	const released = await tickets.unclaim(ticket.id, owner);
	assertEquals(released.claimedBy, null);
	await assertRejects(() => tickets.unclaim(ticket.id, owner), ValidationFailed);
});

dbTest("participants are added and removed with channel overwrites", async (db, guildId) => {
	const { api, tickets, category, actorOf } = await setup(db, guildId);
	const ticket = await tickets.open(guildId, TARGET_ID, category.id);
	const owner = await actorOf(OWNER_ID);

	await tickets.addParticipant(ticket.id, owner, OUTSIDER_ID);
	assertEquals((await tickets.listParticipants(ticket.id)).length, 2);
	const added = api.calledWith("setChannelPermission").at(-1);
	assertEquals((added?.args[1] as { id: bigint }).id, OUTSIDER_ID);
	await assertRejects(
		() => tickets.addParticipant(ticket.id, owner, OUTSIDER_ID),
		ValidationFailed,
	);

	await tickets.removeParticipant(ticket.id, owner, OUTSIDER_ID);
	assertEquals((await tickets.listParticipants(ticket.id)).length, 1);
	assertEquals(api.calledWith("deleteChannelPermission").at(-1)?.args[1], OUTSIDER_ID);
	await assertRejects(
		() => tickets.removeParticipant(ticket.id, owner, TARGET_ID),
		ValidationFailed,
		"cannot be removed",
	);
});

dbTest("transfer moves the channel to the new category parent", async (db, guildId) => {
	const { api, tickets, category, actorOf } = await setup(db, guildId);
	const destination = await tickets.createCategory(guildId, {
		name: "billing",
		staffRoleIds: [MEMBER_ROLE],
		parentChannelId: PARENT_CHANNEL,
	}, OWNER_ID);
	const ticket = await tickets.open(guildId, TARGET_ID, category.id);

	const moved = await tickets.transfer(ticket.id, await actorOf(OWNER_ID), destination.id);
	assertEquals(moved.categoryId, destination.id);
	const edit = api.calledWith("editChannel").at(-1);
	assertEquals((edit?.args[1] as { parentId: bigint }).parentId, PARENT_CHANNEL);
	assertEquals(
		api.calledWith("setChannelPermission").some((call) =>
			(call.args[1] as { id: bigint }).id === MEMBER_ROLE
		),
		true,
	);
});

dbTest("closing stores an escaped transcript and deletes the channel", async (db, guildId) => {
	const { api, tickets, transcripts, transcriptStore, category, actorOf } = await setup(
		db,
		guildId,
	);
	const ticket = await tickets.open(guildId, TARGET_ID, category.id);
	api.messages.set(String(ticket.channelId), [
		messageIn(ticket.channelId, 950000000000000001n, "<script>alert('xss')</script> **bold**"),
	]);

	const closed = await tickets.close(ticket.id, await actorOf(OWNER_ID), "resolved");
	assertEquals(closed.status, "closed");
	assertEquals(closed.closedBy, OWNER_ID);
	assertEquals(closed.closeReason, "resolved");

	const html = transcriptStore.items.get(`${guildId}/${ticket.ticketNumber}.html`);
	assertEquals(typeof html, "string");
	assertStringIncludes(html!, "&lt;script&gt;");
	assertStringIncludes(html!, "<strong>bold</strong>");
	assertEquals(html!.includes("<script>"), false);

	assertEquals((await transcripts.latest(ticket.id))?.messageCount, 1);
	assertEquals(api.calledWith("deleteChannel").length, 1);
	assertEquals(api.dms.at(-1)?.userId, TARGET_ID);
});

dbTest(
	"closing archives instead of deleting when an archive category is set",
	async (db, guildId) => {
		const { api, config, tickets, category, actorOf } = await setup(db, guildId);
		await config.update(guildId, { ticketArchiveCategoryId: ARCHIVE_CATEGORY });
		const ticket = await tickets.open(guildId, TARGET_ID, category.id);

		await tickets.close(ticket.id, await actorOf(OWNER_ID), null);
		assertEquals(api.calledWith("deleteChannel").length, 0);
		const edit = api.calledWith("editChannel").at(-1);
		assertEquals((edit?.args[1] as { parentId: bigint }).parentId, ARCHIVE_CATEGORY);

		const reopened = await tickets.reopen(ticket.id, await actorOf(OWNER_ID));
		assertEquals(reopened.status, "open");
		assertEquals(reopened.closedAt, null);
	},
);

dbTest("reopen fails once the ticket channel is gone", async (db, guildId) => {
	const { api, tickets, category, actorOf } = await setup(db, guildId);
	const ticket = await tickets.open(guildId, TARGET_ID, category.id);
	await tickets.close(ticket.id, await actorOf(OWNER_ID), null);
	const owner = await actorOf(OWNER_ID);
	api.getChannel = () => Promise.resolve(null);
	await assertRejects(() => tickets.reopen(ticket.id, owner), ValidationFailed, "no longer exists");
});

dbTest("the opener may close their own ticket without staff permissions", async (db, guildId) => {
	const { tickets, category, actorOf } = await setup(db, guildId);
	const ticket = await tickets.open(guildId, TARGET_ID, category.id);
	const closed = await tickets.close(ticket.id, await actorOf(TARGET_ID), "sorted it out");
	assertEquals(closed.status, "closed");
});

dbTest("only the opener, participants or tickets.view may read a ticket", async (db, guildId) => {
	const { tickets, category, actorOf } = await setup(db, guildId);
	const ticket = await tickets.open(guildId, TARGET_ID, category.id);

	const outsider = await actorOf(OUTSIDER_ID);
	await tickets.assertCanView(ticket, await actorOf(TARGET_ID));
	await tickets.assertCanView(ticket, await actorOf(MOD_ID));
	await assertRejects(() => tickets.assertCanView(ticket, outsider), PermissionDenied);

	await tickets.addParticipant(ticket.id, await actorOf(OWNER_ID), OUTSIDER_ID);
	await tickets.assertCanView(ticket, outsider);
});

dbTest("a panel posts one message per category button", async (db, guildId) => {
	const { api, tickets, category } = await setup(db, guildId);
	const panel = await tickets.createPanel(guildId, {
		channelId: PARENT_CHANNEL,
		title: "Need help?",
		style: "buttons",
		categoryIds: [category.id],
	}, OWNER_ID);

	assertEquals(panel.messageId !== null, true);
	const sent = api.sentMessages.at(-1);
	assertEquals(sent?.channelId, PARENT_CHANNEL);
	assertStringIncludes(JSON.stringify(sent?.message.components), `loop:ticket:open:${category.id}`);

	await tickets.refreshPanel(panel.id);
	assertEquals(api.calledWith("editMessage").length, 1);
});

dbTest("stale tickets are listed by the configured inactivity window", async (db, guildId) => {
	const { tickets, category, actorOf } = await setup(db, guildId);
	const ticket = await tickets.open(guildId, TARGET_ID, category.id);
	assertEquals((await tickets.staleTickets(guildId, 72)).length, 0);
	assertEquals(await tickets.staleHours(guildId), 72);
	assertEquals((await tickets.staleTickets(guildId, 0)).length, 1);
	await tickets.close(ticket.id, await actorOf(OWNER_ID), null);
	assertEquals((await tickets.staleTickets(guildId, 0)).length, 0);
});

dbTest("deleting a category that has tickets disables it instead", async (db, guildId) => {
	const { tickets, category } = await setup(db, guildId);
	const unused = await tickets.createCategory(guildId, {
		name: "unused",
		staffRoleIds: [MOD_ROLE],
	}, OWNER_ID);
	await tickets.open(guildId, TARGET_ID, category.id);

	assertEquals((await tickets.deleteCategory(guildId, category.id, OWNER_ID)).disabled, true);
	assertEquals((await tickets.deleteCategory(guildId, unused.id, OWNER_ID)).disabled, false);
	assertEquals((await tickets.listCategories(guildId)).map((c) => c.enabled), [false]);
});

dbTest("staff notes stay out of the channel and are readable by staff", async (db, guildId) => {
	const { api, tickets, category, actorOf } = await setup(db, guildId);
	const ticket = await tickets.open(guildId, TARGET_ID, category.id);
	const before = api.sentMessages.length;

	const mod = await actorOf(MOD_ID);
	await tickets.addNote(ticket.id, await actorOf(OWNER_ID), "watch this one");
	assertEquals(api.sentMessages.length, before);
	assertEquals((await tickets.listNotes(ticket.id)).map((n) => n.content), ["watch this one"]);
	await assertRejects(() => tickets.addNote(ticket.id, mod, "nope"), PermissionDenied);
});
