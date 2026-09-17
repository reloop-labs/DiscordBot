import { assertEquals, assertRejects } from "@std/assert";
import { DiscordLogService } from "../../src/discord/logging/discord-log.ts";
import { AuditService } from "../../src/domains/audit/service.ts";
import { GuildConfigService } from "../../src/domains/guild-config/service.ts";
import {
	canTransition,
	renderEmbed,
	SuggestionService,
	type SuggestionStatus,
} from "../../src/domains/suggestions/suggestion-service.ts";
import { silentLogger } from "../../src/logging/logger.ts";
import { resolveActor } from "../../src/permissions/actor.ts";
import { PermissionService } from "../../src/permissions/service.ts";
import { createMemoryStore } from "../../src/redis/client.ts";
import { CooldownActive, NotConfigured, ValidationFailed } from "../../src/shared/errors.ts";
import { dbTest } from "../helpers/database.ts";
import { FakeDiscordApi, MOD_ID, MOD_ROLE, OWNER_ID, TARGET_ID } from "../helpers/fake-discord.ts";

const SUGGESTION_CHANNEL = 300000000000000002n;
const AUTHOR = TARGET_ID;
const VOTER_A = 100000000000000021n;
const VOTER_B = 100000000000000022n;
const CONTENT = "Split general chat into two channels so help requests stop getting buried.";

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
	if (options.channel !== false) {
		await config.update(guildId, { suggestionChannelId: SUGGESTION_CHANNEL });
	}
	await permissions.grant(guildId, MOD_ROLE, "suggestions.manage", OWNER_ID);
	const suggestions = new SuggestionService({
		api,
		db,
		store: createMemoryStore(),
		config,
		permissions,
		discordLog: new DiscordLogService(api, config, silentLogger),
		audit: new AuditService(db, silentLogger),
		logger: silentLogger,
	});
	const actor = await resolveActor(api, guildId, MOD_ID);
	return { api, suggestions, actor };
}

Deno.test("canTransition follows the suggestion lifecycle", () => {
	const allowed: [SuggestionStatus, SuggestionStatus][] = [
		["open", "under_review"],
		["open", "planned"],
		["open", "accepted"],
		["open", "declined"],
		["under_review", "planned"],
		["under_review", "accepted"],
		["under_review", "declined"],
		["planned", "implemented"],
		["planned", "declined"],
		["accepted", "implemented"],
	];
	const refused: [SuggestionStatus, SuggestionStatus][] = [
		["open", "implemented"],
		["open", "open"],
		["under_review", "implemented"],
		["accepted", "declined"],
		["declined", "open"],
		["declined", "implemented"],
		["implemented", "declined"],
		["implemented", "open"],
	];
	for (const [from, to] of allowed) assertEquals(canTransition(from, to), true, `${from}->${to}`);
	for (const [from, to] of refused) assertEquals(canTransition(from, to), false, `${from}->${to}`);
});

dbTest(
	"submit posts an embed and holds the author to one every five minutes",
	async (db, guildId) => {
		const { api, suggestions } = await setup(db, guildId);
		const suggestion = await suggestions.submit(guildId, AUTHOR, "Split general chat", CONTENT);
		assertEquals(suggestion.suggestionNumber, 1);
		assertEquals(api.sentMessages[0]!.channelId, SUGGESTION_CHANNEL);
		const embed = api.sentMessages[0]!.message.embeds![0]!;
		assertEquals(embed.title, "#1 · Split general chat");
		assertEquals(embed.fields!.find((field) => field.name === "Votes")!.value, "👍 0 · 👎 0");
		assertEquals(embed.fields!.find((field) => field.name === "Status")!.value, "Open");
		assertEquals(suggestion.messageId !== null, true);

		await assertRejects(
			() => suggestions.submit(guildId, AUTHOR, "Another idea", CONTENT),
			CooldownActive,
		);
		await assertRejects(
			() => suggestions.submit(guildId, VOTER_A, "Too short", "nope"),
			ValidationFailed,
		);
	},
);

dbTest("submitting without a suggestions channel is refused", async (db, guildId) => {
	const { suggestions } = await setup(db, guildId, { channel: false });
	await assertRejects(
		() => suggestions.submit(guildId, AUTHOR, "Split general chat", CONTENT),
		NotConfigured,
	);
});

dbTest("votes are upserted, switched and retracted from the votes table", async (db, guildId) => {
	const { api, suggestions } = await setup(db, guildId);
	const suggestion = await suggestions.submit(guildId, AUTHOR, "Split general chat", CONTENT);

	let current = await suggestions.vote(guildId, suggestion.id, VOTER_A, 1);
	assertEquals([current.upvotes, current.downvotes], [1, 0]);

	current = await suggestions.vote(guildId, suggestion.id, VOTER_A, 1);
	assertEquals([current.upvotes, current.downvotes], [1, 0]);

	current = await suggestions.vote(guildId, suggestion.id, VOTER_B, -1);
	assertEquals([current.upvotes, current.downvotes], [1, 1]);

	current = await suggestions.vote(guildId, suggestion.id, VOTER_A, -1);
	assertEquals([current.upvotes, current.downvotes], [0, 2]);

	current = await suggestions.vote(guildId, suggestion.id, VOTER_A, 0);
	assertEquals([current.upvotes, current.downvotes], [0, 1]);

	const lastEdit = api.calledWith("editMessage").at(-1)!;
	const edited = lastEdit.args[2] as { embeds: { fields: { name: string; value: string }[] }[] };
	assertEquals(edited.embeds[0]!.fields.find((f) => f.name === "Votes")!.value, "👍 0 · 👎 1");
});

dbTest("the author cannot vote on their own suggestion", async (db, guildId) => {
	const { suggestions } = await setup(db, guildId);
	const suggestion = await suggestions.submit(guildId, AUTHOR, "Split general chat", CONTENT);
	await assertRejects(() => suggestions.vote(guildId, suggestion.id, AUTHOR, 1), ValidationFailed);
});

dbTest("setStatus edits the message, answers the author and closes voting", async (db, guildId) => {
	const { api, suggestions, actor } = await setup(db, guildId);
	const suggestion = await suggestions.submit(guildId, AUTHOR, "Split general chat", CONTENT);
	await suggestions.vote(guildId, suggestion.id, VOTER_A, 1);

	const reviewed = await suggestions.setStatus(suggestion.id, actor, "under_review", "Looking.");
	assertEquals(reviewed.status, "under_review");
	assertEquals(reviewed.officialResponse, "Looking.");
	assertEquals(reviewed.respondedBy, MOD_ID);

	await assertRejects(
		() => suggestions.setStatus(suggestion.id, actor, "implemented"),
		ValidationFailed,
	);

	const declined = await suggestions.setStatus(suggestion.id, actor, "declined", "Not this year.");
	assertEquals(declined.status, "declined");
	assertEquals(renderEmbed(declined).color, 0xed4245);

	const edited = api.calledWith("editMessage").at(-1)!.args[2] as {
		embeds: { fields: { name: string; value: string }[] }[];
		components: { components: { disabled: boolean }[] }[];
	};
	assertEquals(
		edited.embeds[0]!.fields.find((f) => f.name === "Response from staff")!.value,
		"Not this year.",
	);
	assertEquals(edited.components[0]!.components.every((button) => button.disabled), true);

	assertEquals(api.dms.filter((dm) => dm.userId === AUTHOR).length, 2);
	assertEquals(api.dms.at(-1)!.message.content?.includes("Declined"), true);

	await assertRejects(() => suggestions.vote(guildId, suggestion.id, VOTER_B, 1), ValidationFailed);
});

dbTest("lookups by number, status and message id", async (db, guildId) => {
	const { suggestions } = await setup(db, guildId);
	const suggestion = await suggestions.submit(guildId, AUTHOR, "Split general chat", CONTENT);
	assertEquals((await suggestions.get(guildId, 1)).id, suggestion.id);
	assertEquals((await suggestions.list(guildId)).length, 1);
	assertEquals((await suggestions.list(guildId, "declined")).length, 0);
	assertEquals((await suggestions.byMessage(suggestion.messageId!))!.id, suggestion.id);
});
