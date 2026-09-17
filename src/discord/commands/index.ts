import type { Container } from "../../app/container.ts";
import { automodCommands } from "./automod.ts";
import { configCommands } from "./config.ts";
import { moderationCommands } from "./moderation.ts";
import { collect, type CommandSet } from "./registry.ts";
import { reportCommands } from "./report.ts";
import { roleMenuCommands } from "./rolemenu.ts";
import { suggestionCommands } from "./suggest.ts";
import { ticketCommands } from "./ticket.ts";

export function buildCommands(c: Container): CommandSet {
	return collect(
		moderationCommands({
			api: c.api,
			moderation: c.moderation,
			cases: c.cases,
			permissions: c.permissions,
			audit: c.audit,
		}),
		configCommands({ api: c.api, config: c.config, permissions: c.permissions, audit: c.audit }),
		roleMenuCommands({ api: c.api, roleMenus: c.roleMenus, permissions: c.permissions }),
		reportCommands({ api: c.api, reports: c.reports, permissions: c.permissions, store: c.store }),
		suggestionCommands({ api: c.api, suggestions: c.suggestions, permissions: c.permissions }),
		ticketCommands({
			api: c.api,
			tickets: c.tickets,
			transcripts: c.transcripts,
			permissions: c.permissions,
		}),
		automodCommands({
			api: c.api,
			automod: c.automod,
			raid: c.raid,
			permissions: c.permissions,
			audit: c.audit,
		}),
	);
}
