export const PERMISSIONS = [
	"moderation.warn",
	"moderation.timeout",
	"moderation.kick",
	"moderation.ban",
	"moderation.purge",
	"moderation.channels",
	"moderation.nickname",
	"moderation.history",
	"moderation.cases",
	"moderation.notes",
	"tickets.view",
	"tickets.claim",
	"tickets.manage",
	"tickets.admin",
	"roles.manage",
	"reports.view",
	"reports.manage",
	"suggestions.manage",
	"automod.manage",
	"config.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: string): value is Permission {
	return (PERMISSIONS as readonly string[]).includes(value);
}

export const PERMISSION_GROUPS: Record<string, Permission[]> = {
	moderator: [
		"moderation.warn",
		"moderation.timeout",
		"moderation.kick",
		"moderation.purge",
		"moderation.channels",
		"moderation.nickname",
		"moderation.history",
		"moderation.cases",
		"moderation.notes",
		"reports.view",
		"reports.manage",
		"tickets.view",
		"tickets.claim",
		"tickets.manage",
	],
	"senior-moderator": ["moderation.ban", "automod.manage", "tickets.admin", "suggestions.manage"],
	admin: [...PERMISSIONS],
};
