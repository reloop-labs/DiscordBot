import type { Env } from "../config/env.ts";
import { createDatabase, type DatabaseHandle } from "../database/client.ts";
import type { DiscordApi } from "../discord/adapters/discord-api.ts";
import { DiscordLogService } from "../discord/logging/discord-log.ts";
import { AuditService } from "../domains/audit/service.ts";
import { AutomodService } from "../domains/automod/engine.ts";
import { RaidService } from "../domains/automod/raid-service.ts";
import { GuildConfigService } from "../domains/guild-config/service.ts";
import { MemberService } from "../domains/members/member-service.ts";
import { WelcomeCardRenderer } from "../domains/members/welcome-card.ts";
import { ReportService } from "../domains/reports/report-service.ts";
import { RoleMenuService } from "../domains/roles/role-menu-service.ts";
import { SuggestionService } from "../domains/suggestions/suggestion-service.ts";
import { TicketService } from "../domains/tickets/ticket-service.ts";
import { TranscriptService } from "../domains/tickets/transcript-service.ts";
import { createLocalTranscriptStore } from "../domains/tickets/transcript-store.ts";
import { CaseService } from "../domains/moderation/case-service.ts";
import { ModerationService } from "../domains/moderation/moderation-service.ts";
import type { Logger } from "../logging/logger.ts";
import { PermissionService } from "../permissions/service.ts";
import type { KeyValueStore } from "../redis/client.ts";

export interface Container {
	env: Env;
	logger: Logger;
	database: DatabaseHandle;
	store: KeyValueStore;
	api: DiscordApi;
	config: GuildConfigService;
	audit: AuditService;
	discordLog: DiscordLogService;
	permissions: PermissionService;
	cases: CaseService;
	moderation: ModerationService;
	members: MemberService;
	roleMenus: RoleMenuService;
	reports: ReportService;
	suggestions: SuggestionService;
	automod: AutomodService;
	raid: RaidService;
	transcripts: TranscriptService;
	tickets: TicketService;
}

export function buildContainer(
	input: {
		env: Env;
		logger: Logger;
		store: KeyValueStore;
		api: DiscordApi;
		database?: DatabaseHandle;
	},
): Container {
	const { env, logger, store, api } = input;
	const database = input.database ?? createDatabase(env.DATABASE_URL);
	const db = database.db;
	const config = new GuildConfigService(db);
	const audit = new AuditService(db, logger.child({ component: "audit" }));
	const discordLog = new DiscordLogService(api, config, logger.child({ component: "discord-log" }));
	const permissions = new PermissionService(db);
	const cases = new CaseService(db);
	const moderation = new ModerationService(
		api,
		cases,
		permissions,
		config,
		discordLog,
		logger.child({ component: "moderation" }),
	);
	const members = new MemberService(
		api,
		db,
		config,
		discordLog,
		logger.child({ component: "members" }),
		new WelcomeCardRenderer(env.ASSETS_DIR, logger.child({ component: "cards" })),
	);
	const roleMenus = new RoleMenuService(api, db, audit, logger.child({ component: "rolemenus" }));
	const reports = new ReportService({
		api,
		db,
		store,
		config,
		permissions,
		cases,
		discordLog,
		audit,
		logger: logger.child({ component: "reports" }),
	});
	const suggestions = new SuggestionService({
		api,
		db,
		store,
		config,
		permissions,
		discordLog,
		audit,
		logger: logger.child({ component: "suggestions" }),
	});
	const automod = new AutomodService(
		api,
		db,
		store,
		cases,
		config,
		permissions,
		discordLog,
		logger.child({ component: "automod" }),
	);
	const raid = new RaidService(store, config, discordLog, logger.child({ component: "raid" }));
	const transcripts = new TranscriptService(
		api,
		db,
		createLocalTranscriptStore(env.TRANSCRIPT_DIR),
		logger.child({ component: "transcripts" }),
	);
	const tickets = new TicketService({
		api,
		db,
		store,
		config,
		permissions,
		audit,
		discordLog,
		transcripts,
		logger: logger.child({ component: "tickets" }),
	});
	return {
		env,
		logger,
		database,
		store,
		api,
		config,
		audit,
		discordLog,
		permissions,
		cases,
		moderation,
		members,
		roleMenus,
		reports,
		suggestions,
		automod,
		raid,
		transcripts,
		tickets,
	};
}
