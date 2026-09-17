import { and, eq } from "drizzle-orm";
import type { Database } from "../database/client.ts";
import { permissionGrants } from "../database/schema/index.ts";
import { PermissionDenied } from "../shared/errors.ts";
import { type Permission, PERMISSIONS } from "./keys.ts";

export interface Actor {
	guildId: bigint;
	userId: bigint;
	roleIds: bigint[];
	isGuildOwner: boolean;
	hasDiscordAdministrator: boolean;
}

export class PermissionService {
	#db: Database;

	constructor(db: Database) {
		this.#db = db;
	}

	async permissionsFor(actor: Actor): Promise<Set<Permission>> {
		if (actor.isGuildOwner || actor.hasDiscordAdministrator) return new Set(PERMISSIONS);
		if (actor.roleIds.length === 0) return new Set();
		const rows = await this.#db
			.select({ roleId: permissionGrants.roleId, permission: permissionGrants.permission })
			.from(permissionGrants)
			.where(eq(permissionGrants.guildId, actor.guildId));
		const held = new Set(actor.roleIds.map(String));
		return new Set(
			rows.filter((row) => held.has(String(row.roleId))).map((row) => row.permission as Permission),
		);
	}

	async has(actor: Actor, permission: Permission): Promise<boolean> {
		return (await this.permissionsFor(actor)).has(permission);
	}

	async require(actor: Actor, permission: Permission): Promise<void> {
		if (!(await this.has(actor, permission))) throw new PermissionDenied(permission);
	}

	async grant(
		guildId: bigint,
		roleId: bigint,
		permission: Permission,
		grantedBy: bigint,
	): Promise<boolean> {
		const inserted = await this.#db
			.insert(permissionGrants)
			.values({ guildId, roleId, permission, grantedBy })
			.onConflictDoNothing()
			.returning({ id: permissionGrants.id });
		return inserted.length > 0;
	}

	async revoke(guildId: bigint, roleId: bigint, permission: Permission): Promise<boolean> {
		const deleted = await this.#db
			.delete(permissionGrants)
			.where(
				and(
					eq(permissionGrants.guildId, guildId),
					eq(permissionGrants.roleId, roleId),
					eq(permissionGrants.permission, permission),
				),
			)
			.returning({ id: permissionGrants.id });
		return deleted.length > 0;
	}

	async listGrants(guildId: bigint): Promise<{ roleId: bigint; permission: Permission }[]> {
		const rows = await this.#db
			.select({ roleId: permissionGrants.roleId, permission: permissionGrants.permission })
			.from(permissionGrants)
			.where(eq(permissionGrants.guildId, guildId));
		return rows.map((row) => ({ roleId: row.roleId, permission: row.permission as Permission }));
	}
}
