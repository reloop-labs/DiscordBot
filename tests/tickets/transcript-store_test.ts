import { assertEquals, assertRejects } from "@std/assert";
import { createLocalTranscriptStore } from "../../src/domains/tickets/transcript-store.ts";
import { ValidationFailed } from "../../src/shared/errors.ts";

async function withTempStore(
	fn: (store: ReturnType<typeof createLocalTranscriptStore>) => Promise<void>,
) {
	const root = await Deno.makeTempDir({ prefix: "loop-transcripts-" });
	try {
		await fn(createLocalTranscriptStore(root));
	} finally {
		await Deno.remove(root, { recursive: true });
	}
}

Deno.test("local transcript store round-trips a document and creates directories", async () => {
	await withTempStore(async (store) => {
		const html = "<html>hi</html>";
		const { sizeBytes } = await store.put("700000000000000000/12.html", html);
		assertEquals(sizeBytes, new TextEncoder().encode(html).byteLength);
		const read = await store.get("700000000000000000/12.html");
		assertEquals(read ? new TextDecoder().decode(read) : null, html);
	});
});

Deno.test("local transcript store returns null for a missing key", async () => {
	await withTempStore(async (store) => {
		assertEquals(await store.get("1/999.html"), null);
	});
});

Deno.test("transcript keys with traversal or odd characters are rejected", async () => {
	await withTempStore(async (store) => {
		for (const key of ["../escape.html", "1/../../etc/passwd", "/absolute.html", "1/a b.html"]) {
			await assertRejects(() => store.put(key, "x"), ValidationFailed);
			await assertRejects(() => store.get(key), ValidationFailed);
		}
	});
});
