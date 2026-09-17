import type { DiscordApi, GuildSnapshot, MemberSnapshot } from "../discord/adapters/discord-api.ts";
import { MemberNotFound } from "../shared/errors.ts";
import { ADMINISTRATOR, basePermissions } from "./hierarchy.ts";
import type { Actor } from "./service.ts";

export interface ActorContext {
	actor: Actor;
	guild: GuildSnapshot;
	member: MemberSnapshot;
	botMember: MemberSnapshot;
}

export async function resolveActor(
	api: DiscordApi,
	guildId: bigint,
	userId: bigint,
): Promise<ActorContext> {
	const guild = await api.getGuild(guildId);
	if (!guild) throw new MemberNotFound();
	const [member, botMember] = await Promise.all([
		api.getMember(guildId, userId),
		api.getMember(guildId, api.botUserId()),
	]);
	if (!member || !botMember) throw new MemberNotFound();
	const bits = basePermissions(guild, member);
	return {
		guild,
		member,
		botMember,
		actor: {
			guildId,
			userId,
			roleIds: member.roleIds,
			isGuildOwner: guild.ownerId === userId,
			hasDiscordAdministrator: (bits & ADMINISTRATOR) === ADMINISTRATOR,
		},
	};
}
