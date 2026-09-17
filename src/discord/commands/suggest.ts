import { MessageComponentTypes, TextStyles } from "@discordeno/bot";
import type { MessageComponents } from "@discordeno/bot";
import type { DiscordApi } from "../adapters/discord-api.ts";
import type { InteractionContext } from "../interactions/context.ts";
import { decodeCustomId, encodeCustomId } from "../interactions/custom-id.ts";
import type { ComponentModule } from "../interactions/router.ts";
import { LOG_COLORS } from "../logging/discord-log.ts";
import type {
	Suggestion,
	SuggestionService,
	SuggestionStatus,
} from "../../domains/suggestions/suggestion-service.ts";
import {
	renderEmbed,
	statusLabel,
	SUGGESTION_STATUSES,
} from "../../domains/suggestions/suggestion-service.ts";
import { ValidationFailed } from "../../shared/errors.ts";
import { truncate } from "../../shared/text.ts";
import type { PermissionService } from "../../permissions/service.ts";
import type { CommandDefinition } from "./registry.ts";
import { actorOf, int, requireSubcommand, slash, str, sub } from "./helpers.ts";

export interface SuggestionCommandDeps {
	api: DiscordApi;
	suggestions: SuggestionService;
	permissions: PermissionService;
}

const statusChoices = SUGGESTION_STATUSES.map((status) => ({
	name: statusLabel(status),
	value: status,
}));

const newSuggestionModal = {
	title: "New suggestion",
	customId: encodeCustomId("suggest", "new"),
	components: [
		{
			type: MessageComponentTypes.ActionRow,
			components: [{
				type: MessageComponentTypes.InputText,
				customId: "title",
				label: "Short title",
				style: TextStyles.Short,
				minLength: 5,
				maxLength: 100,
				required: true,
			}],
		},
		{
			type: MessageComponentTypes.ActionRow,
			components: [{
				type: MessageComponentTypes.InputText,
				customId: "content",
				label: "What should change, and why?",
				style: TextStyles.Paragraph,
				minLength: 20,
				maxLength: 2000,
				required: true,
			}],
		},
	] as MessageComponents,
};

function toStatus(value: string): SuggestionStatus {
	const status = SUGGESTION_STATUSES.find((candidate) => candidate === value);
	if (!status) throw new ValidationFailed("Pick one of the offered statuses.");
	return status;
}

function suggestionLine(suggestion: Suggestion): string {
	return `**#${suggestion.suggestionNumber}** ${
		statusLabel(suggestion.status)
	} · 👍 ${suggestion.upvotes} · 👎 ${suggestion.downvotes} · ${truncate(suggestion.title, 60)}`;
}

export function suggestionCommands(deps: SuggestionCommandDeps): CommandDefinition[] {
	const { api, suggestions, permissions } = deps;

	const components: ComponentModule = {
		domain: "suggest",
		handle: async (ctx: InteractionContext) => {
			const decoded = decodeCustomId(ctx.customId);
			if (!decoded) throw new ValidationFailed("That button is no longer valid.");
			if (decoded.action === "new") {
				await ctx.defer(true);
				const suggestion = await suggestions.submit(
					ctx.guildId,
					ctx.userId,
					ctx.modalValue("title"),
					ctx.modalValue("content"),
				);
				await ctx.reply(
					suggestion.messageId
						? `Posted: https://discord.com/channels/${suggestion.guildId}/${suggestion.channelId}/${suggestion.messageId}`
						: `Suggestion #${suggestion.suggestionNumber} recorded.`,
				);
				return;
			}
			if (decoded.action !== "up" && decoded.action !== "down" && decoded.action !== "none") {
				throw new ValidationFailed("That button is no longer valid.");
			}
			const vote = decoded.action === "up" ? 1 : decoded.action === "down" ? -1 : 0;
			await ctx.defer(true);
			await suggestions.vote(ctx.guildId, decoded.args[0]!, ctx.userId, vote);
			await ctx.reply(vote === 0 ? "Vote retracted" : "Vote recorded");
		},
	};

	return [
		{
			name: "suggest",
			definition: slash("suggest", "Suggest an idea for the server"),
			handle: (ctx) => ctx.showModal(newSuggestionModal),
			components: [components],
		},

		{
			name: "suggestion",
			definition: slash("suggestion", "Manage suggestions", [
				sub("status", "Set the status of a suggestion", [
					int("number", "Suggestion number", { required: true, minValue: 1 }),
					str("status", "New status", { required: true, choices: statusChoices }),
					str("response", "Official response shown on the suggestion", { maxLength: 1000 }),
				]),
				sub("view", "Show one suggestion", [
					int("number", "Suggestion number", { required: true, minValue: 1 }),
				]),
				sub("list", "List suggestions", [
					str("status", "Only this status", { choices: statusChoices }),
				]),
			], { defaultMemberPermissions: ["MANAGE_GUILD"] }),
			handle: async (ctx) => {
				await ctx.defer(true);
				const actor = await actorOf(api, ctx);
				await permissions.require(actor.actor, "suggestions.manage");
				switch (requireSubcommand(ctx)) {
					case "status": {
						const suggestion = await suggestions.get(ctx.guildId, ctx.integer("number")!);
						const updated = await suggestions.setStatus(
							suggestion.id,
							actor,
							toStatus(ctx.requireString("status")),
							ctx.string("response"),
						);
						await ctx.reply(
							`Suggestion #${updated.suggestionNumber} is now ${statusLabel(updated.status)}.`,
						);
						return;
					}
					case "view": {
						const suggestion = await suggestions.get(ctx.guildId, ctx.integer("number")!);
						await ctx.reply({ embeds: [renderEmbed(suggestion)] });
						return;
					}
					case "list": {
						const raw = ctx.string("status");
						const status = raw ? toStatus(raw) : undefined;
						const rows = await suggestions.list(ctx.guildId, status);
						await ctx.reply({
							embeds: [{
								title: status ? `Suggestions · ${statusLabel(status)}` : "Suggestions",
								color: LOG_COLORS.info,
								description: rows.length
									? rows.map(suggestionLine).join("\n")
									: "No suggestions yet.",
							}],
						});
						return;
					}
				}
			},
		},
	];
}
