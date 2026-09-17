import {
	ApplicationCommandOptionTypes,
	ApplicationCommandTypes,
	DiscordInteractionContextType,
} from "@discordeno/bot";
import type { CreateApplicationCommand, CreateSlashApplicationCommand } from "@discordeno/bot";
import type { DiscordApi } from "../adapters/discord-api.ts";
import type { InteractionContext } from "../interactions/context.ts";
import { type ActorContext, resolveActor } from "../../permissions/actor.ts";
import type { ModerationTarget } from "../../domains/moderation/moderation-service.ts";
import { ValidationFailed } from "../../shared/errors.ts";
import { parseSnowflake } from "../../shared/snowflake.ts";

export const Opt = ApplicationCommandOptionTypes;
export const CmdType = ApplicationCommandTypes;

type Option = NonNullable<CreateSlashApplicationCommand["options"]>[number];

export function slash(
	name: string,
	description: string,
	options: Option[] = [],
	extra: Partial<CreateApplicationCommand> = {},
): CreateApplicationCommand {
	return {
		name,
		description,
		type: CmdType.ChatInput,
		options,
		contexts: [DiscordInteractionContextType.Guild],
		...extra,
	};
}

export function contextMenu(
	name: string,
	type: typeof CmdType.User | typeof CmdType.Message,
): CreateApplicationCommand {
	return { name, description: "", type, contexts: [DiscordInteractionContextType.Guild] };
}

export function sub(name: string, description: string, options: Option[] = []): Option {
	return { type: Opt.SubCommand, name, description, options };
}

export function group(name: string, description: string, options: Option[]): Option {
	return { type: Opt.SubCommandGroup, name, description, options };
}

export function str(name: string, description: string, extra: Partial<Option> = {}): Option {
	return { type: Opt.String, name, description, ...extra };
}

export function int(name: string, description: string, extra: Partial<Option> = {}): Option {
	return { type: Opt.Integer, name, description, ...extra };
}

export function bool(name: string, description: string, extra: Partial<Option> = {}): Option {
	return { type: Opt.Boolean, name, description, ...extra };
}

export function user(name: string, description: string, extra: Partial<Option> = {}): Option {
	return { type: Opt.User, name, description, ...extra };
}

export function role(name: string, description: string, extra: Partial<Option> = {}): Option {
	return { type: Opt.Role, name, description, ...extra };
}

export function channel(name: string, description: string, extra: Partial<Option> = {}): Option {
	return { type: Opt.Channel, name, description, ...extra };
}

export function actorOf(api: DiscordApi, ctx: InteractionContext): Promise<ActorContext> {
	return resolveActor(api, ctx.guildId, ctx.userId);
}

export async function targetOf(
	api: DiscordApi,
	ctx: InteractionContext,
	optionName = "user",
): Promise<ModerationTarget> {
	const option = ctx.userOption(optionName);
	if (option) {
		const member = await api.getMember(ctx.guildId, option.id);
		return { userId: option.id, username: option.username, member };
	}
	const raw = ctx.string(optionName);
	if (!raw) throw new ValidationFailed("Provide a user.");
	let userId: bigint;
	try {
		userId = parseSnowflake(raw.replace(/[<@!>]/g, ""));
	} catch {
		throw new ValidationFailed("That is not a valid user or user ID.");
	}
	const [member, userInfo] = await Promise.all([
		api.getMember(ctx.guildId, userId),
		api.getUser(userId),
	]);
	if (!member && !userInfo) throw new ValidationFailed("No Discord user exists with that ID.");
	return { userId, username: member?.username ?? userInfo?.username ?? String(userId), member };
}

export function requireSubcommand(ctx: InteractionContext): string {
	const path = ctx.subcommandPath;
	return path[path.length - 1] ?? "";
}
