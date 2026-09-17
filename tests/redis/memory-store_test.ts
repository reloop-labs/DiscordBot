import { assertEquals } from "@std/assert";
import { createMemoryStore } from "../../src/redis/client.ts";

Deno.test("memory store locks, windows and counters", async () => {
	const store = createMemoryStore();
	assertEquals(await store.acquireLock("l", 1000), true);
	assertEquals(await store.acquireLock("l", 1000), false);
	await store.releaseLock("l");
	assertEquals(await store.acquireLock("l", 1000), true);

	assertEquals(await store.incrWithTtl("c", 1000), 1);
	assertEquals(await store.incrWithTtl("c", 1000), 2);

	assertEquals(await store.slidingWindowAdd("w", 1000), 1);
	assertEquals(await store.slidingWindowAdd("w", 1000), 2);
});
