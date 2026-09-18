import type { LoopBot } from "../bot.ts";
import { avatarUrl } from "@discordeno/bot";
import { toMemberSnapshot } from "../adapters/discordeno-api.ts";
import type { RaidService } from "../../domains/automod/raid-service.ts";
import type { MemberService } from "../../domains/members/member-service.ts";
import type { Logger } from "../../logging/logger.ts";
import { snowflakeCreatedAt } from "../../shared/snowflake.ts";

export interface MemberEventDeps {
	members: MemberService;
	raid: RaidService;
	logger: Logger;
}

export function attachMemberEvents(bot: LoopBot, deps: MemberEventDeps): void {
	const { members, raid, logger } = deps;

	bot.events.guildMemberAdd = async (member, user) => {
		try {
			await members.onJoin(toMemberSnapshot(member), user.bot);
			if (!user.bot) await raid.recordJoin(member.guildId, user.id, snowflakeCreatedAt(user.id));
		} catch (error) {
			logger.error("guild member add failed", { guildId: member.guildId, userId: user.id, error });
		}
	};

	bot.events.guildMemberRemove = async (user, guildId) => {
		try {
			await members.onLeave(
				guildId,
				user.id,
				user.username,
				members.cached(guildId, user.id)?.roleIds ?? null,
				avatarUrl(user.id, user.discriminator, { avatar: user.avatar }),
			);
		} catch (error) {
			logger.error("guild member remove failed", { guildId, userId: user.id, error });
		}
	};

	bot.events.guildMemberUpdate = async (member, user) => {
		try {
			await members.onUpdate(
				members.cached(member.guildId, user.id),
				toMemberSnapshot(member),
			);
		} catch (error) {
			logger.error("guild member update failed", {
				guildId: member.guildId,
				userId: user.id,
				error,
			});
		}
	};
}
