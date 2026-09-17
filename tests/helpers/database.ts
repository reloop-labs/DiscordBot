import { sql } from "drizzle-orm";
import { createDatabase, type DatabaseHandle } from "../../src/database/client.ts";
import { guilds } from "../../src/database/schema/index.ts";

export const TEST_DATABASE_URL = Deno.env.get("TEST_DATABASE_URL") ??
	"postgres://loop:loop@localhost:5432/loop";

let handle: DatabaseHandle | null = null;
let reachable: boolean | null = null;

export async function testDatabase(): Promise<DatabaseHandle | null> {
	if (reachable === false) return null;
	if (!handle) handle = createDatabase(TEST_DATABASE_URL, { max: 4 });
	if (reachable === null) reachable = await handle.ping();
	return reachable ? handle : null;
}

let counter = 0n;

export async function freshGuild(db: DatabaseHandle["db"], name = "test"): Promise<bigint> {
	counter += 1n;
	const id = 700000000000000000n + BigInt(Date.now() % 1_000_000) * 1000n + counter;
	await db.insert(guilds).values({ id, name });
	return id;
}

export async function dropGuild(db: DatabaseHandle["db"], id: bigint): Promise<void> {
	await db.execute(sql`delete from guilds where id = ${id}`);
}

export function dbTest(
	name: string,
	fn: (db: DatabaseHandle["db"], guildId: bigint) => Promise<void>,
): void {
	Deno.test({
		name,
		sanitizeOps: false,
		sanitizeResources: false,
		fn: async () => {
			const handle = await testDatabase();
			if (!handle) {
				console.warn(`skipping ${name}: database not reachable`);
				return;
			}
			const guildId = await freshGuild(handle.db);
			try {
				await fn(handle.db, guildId);
			} finally {
				await dropGuild(handle.db, guildId);
			}
		},
	});
}
