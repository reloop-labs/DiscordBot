import { createBot, Intents } from "@discordeno/bot";
import type { Logger } from "../logging/logger.ts";

export const desiredProperties = {
	user: {
		id: true,
		username: true,
		globalName: true,
		discriminator: true,
		avatar: true,
		bot: true,
		toggles: true,
	},
	member: {
		id: true,
		guildId: true,
		user: true,
		nick: true,
		avatar: true,
		roles: true,
		joinedAt: true,
		communicationDisabledUntil: true,
		permissions: true,
		toggles: true,
	},
	guild: { id: true, name: true, ownerId: true, roles: true, toggles: true },
	role: {
		id: true,
		guildId: true,
		name: true,
		position: true,
		permissions: true,
		managed: true,
		toggles: true,
	},
	channel: {
		id: true,
		guildId: true,
		name: true,
		type: true,
		parentId: true,
		rateLimitPerUser: true,
		permissionOverwrites: true,
		toggles: true,
		internalOverwrites: true,
		internalThreadMetadata: true,
	},
	message: {
		id: true,
		channelId: true,
		guildId: true,
		author: true,
		member: true,
		content: true,
		timestamp: true,
		editedTimestamp: true,
		attachments: true,
		embeds: true,
		mentions: true,
		mentionedRoleIds: true,
		mentionedUserIds: true,
		mentionEveryone: true,
		messageReference: true,
		referencedMessage: true,
		type: true,
		pinned: true,
		bitfield: true,
		flags: true,
	},
	attachment: {
		id: true,
		filename: true,
		url: true,
		proxyUrl: true,
		size: true,
		contentType: true,
	},
	messageReference: { messageId: true, channelId: true, guildId: true },
	interaction: {
		id: true,
		applicationId: true,
		type: true,
		guildId: true,
		channelId: true,
		channel: true,
		member: true,
		user: true,
		token: true,
		data: true,
		message: true,
		appPermissions: true,
		locale: true,
	},
	invite: { code: true, guildId: true },
	interactionCallbackResponse: { interaction: true, resource: true },
	interactionCallback: { id: true, type: true },
	interactionResource: { type: true, message: true },
} as const;

export const intents = Intents.Guilds |
	Intents.GuildMembers |
	Intents.GuildModeration |
	Intents.GuildMessages |
	Intents.MessageContent;

export function createLoopBot(options: { token: string; logger: Logger }) {
	const { logger } = options;
	return createBot({
		token: options.token,
		intents,
		desiredProperties,
		loggerFactory: (name) => {
			const child = logger.child({ component: name.toLowerCase() });
			return {
				debug: (...args: unknown[]) => child.debug(String(args[0]), { args: args.slice(1) }),
				info: (...args: unknown[]) => child.info(String(args[0]), { args: args.slice(1) }),
				warn: (...args: unknown[]) => child.warn(String(args[0]), { args: args.slice(1) }),
				error: (...args: unknown[]) => child.error(String(args[0]), { args: args.slice(1) }),
				fatal: (...args: unknown[]) => child.error(String(args[0]), { args: args.slice(1) }),
			};
		},
	});
}

export type LoopBot = ReturnType<typeof createLoopBot>;
export type LoopInteraction = LoopBot["transformers"]["$inferredTypes"]["interaction"];
export type LoopMessage = LoopBot["transformers"]["$inferredTypes"]["message"];
export type LoopMember = LoopBot["transformers"]["$inferredTypes"]["member"];
export type LoopUser = LoopBot["transformers"]["$inferredTypes"]["user"];
export type LoopRole = LoopBot["transformers"]["$inferredTypes"]["role"];
export type LoopChannel = LoopBot["transformers"]["$inferredTypes"]["channel"];
export type LoopGuild = LoopBot["transformers"]["$inferredTypes"]["guild"];
