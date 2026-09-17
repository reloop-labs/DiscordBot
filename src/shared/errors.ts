export class LoopError extends Error {
	readonly code: string;
	readonly userMessage: string;

	constructor(code: string, userMessage: string, options?: { cause?: unknown; message?: string }) {
		super(options?.message ?? userMessage, { cause: options?.cause });
		this.name = new.target.name;
		this.code = code;
		this.userMessage = userMessage;
	}
}

export class PermissionDenied extends LoopError {
	constructor(permission?: string) {
		super(
			"permission_denied",
			permission
				? `You need the \`${permission}\` permission to do that.`
				: "You are not allowed to do that.",
		);
	}
}

export class HierarchyViolation extends LoopError {
	constructor(userMessage: string) {
		super("hierarchy_violation", userMessage);
	}
}

export class BotMissingPermission extends LoopError {
	constructor(permission: string) {
		super("bot_missing_permission", `Loop is missing the **${permission}** permission.`);
	}
}

export class MemberNotFound extends LoopError {
	constructor() {
		super("member_not_found", "That member is not in this server.");
	}
}

export class NotFound extends LoopError {
	constructor(what: string) {
		super("not_found", `${what} was not found.`);
	}
}

export class CaseNotFound extends NotFound {
	constructor(caseNumber: number) {
		super(`Case #${caseNumber}`);
	}
}

export class TicketNotFound extends NotFound {
	constructor() {
		super("This ticket");
	}
}

export class TicketAlreadyOpen extends LoopError {
	constructor(channelId: bigint) {
		super("ticket_already_open", `You already have an open ticket: <#${channelId}>.`);
	}
}

export class InvalidConfiguration extends LoopError {
	constructor(userMessage: string) {
		super("invalid_configuration", userMessage);
	}
}

export class NotConfigured extends LoopError {
	constructor(what: string) {
		super("not_configured", `${what} is not configured. Ask an admin to run \`/config\`.`);
	}
}

export class ValidationFailed extends LoopError {
	constructor(userMessage: string) {
		super("validation_failed", userMessage);
	}
}

export class CooldownActive extends LoopError {
	constructor(seconds: number) {
		super("cooldown", `Slow down. Try again in ${seconds}s.`);
	}
}

export class DatabaseUnavailable extends LoopError {
	constructor(cause?: unknown) {
		super("database_unavailable", "Loop cannot reach its database right now. Try again shortly.", {
			cause,
		});
	}
}

export function isLoopError(error: unknown): error is LoopError {
	return error instanceof LoopError;
}
