import { assertEquals } from "@std/assert";
import { createCanvas } from "@napi-rs/canvas";
import { WelcomeCardRenderer } from "../../src/domains/members/welcome-card.ts";
import { silentLogger } from "../../src/logging/logger.ts";

async function assetsDir(withBackground: boolean): Promise<string> {
	const dir = await Deno.makeTempDir();
	await Deno.mkdir(`${dir}/fonts`);
	await Deno.mkdir(`${dir}/cards`);
	await Deno.copyFile("assets/fonts/Inter.ttf", `${dir}/fonts/Inter.ttf`);
	if (withBackground) {
		const canvas = createCanvas(512, 200);
		const ctx = canvas.getContext("2d");
		ctx.fillStyle = "#123456";
		ctx.fillRect(0, 0, 512, 200);
		await Deno.writeFile(`${dir}/cards/welcome.png`, await canvas.encode("png"));
	}
	return dir;
}

Deno.test("renders a png card when a background exists", async () => {
	const renderer = new WelcomeCardRenderer(await assetsDir(true), silentLogger);
	const png = await renderer.render({
		kind: "welcome",
		displayName: "luna",
		username: "luna",
		serverName: "Reloop",
		avatarUrl: null,
		memberCount: 1204,
	});
	assertEquals(png !== null, true);
	assertEquals([...png!.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
	assertEquals(png!.length > 5000, true);
});

Deno.test("returns null without a background so text-only announcements still work", async () => {
	const renderer = new WelcomeCardRenderer(await assetsDir(false), silentLogger);
	assertEquals(
		await renderer.render({
			kind: "leave",
			displayName: "x",
			username: "x",
			serverName: "Reloop",
			avatarUrl: null,
		}),
		null,
	);
});
