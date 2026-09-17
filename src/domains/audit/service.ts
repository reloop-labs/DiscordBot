import type { Database } from "../../database/client.ts";
import { auditEvents } from "../../database/schema/index.ts";
import type { Logger } from "../../logging/logger.ts";

export interface AuditEntry {
	guildId: bigint;
	actorId: bigint | null;
	action: string;
	target?: string;
	data?: Record<string, unknown>;
}

export class AuditService {
	#db: Database;
	#logger: Logger;

	constructor(db: Database, logger: Logger) {
		this.#db = db;
		this.#logger = logger;
	}

	async record(entry: AuditEntry): Promise<void> {
		try {
			await this.#db.insert(auditEvents).values({
				guildId: entry.guildId,
				actorId: entry.actorId,
				action: entry.action,
				target: entry.target ?? null,
				data: sanitize(entry.data ?? {}),
			});
		} catch (error) {
			this.#logger.error("audit write failed", { action: entry.action, error });
		}
	}
}

function sanitize(data: Record<string, unknown>): Record<string, unknown> {
	return JSON.parse(
		JSON.stringify(data, (_key, value) => (typeof value === "bigint" ? value.toString() : value)),
	);
}
