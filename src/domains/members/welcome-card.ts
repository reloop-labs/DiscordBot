import { createCanvas, GlobalFonts, type Image, loadImage } from "@napi-rs/canvas";
import { join } from "@std/path";
import type { Logger } from "../../logging/logger.ts";

export type CardKind = "welcome" | "leave";

export interface CardInput {
	kind: CardKind;
	displayName: string;
	username: string;
	serverName: string;
	avatarUrl: string | null;
	memberCount?: number;
}

const WIDTH = 1024;
const HEIGHT = 400;
const FONT = "Inter";

export class WelcomeCardRenderer {
	#assetsDir: string;
	#logger: Logger;
	#fontReady = false;
	#backgrounds = new Map<CardKind, Image>();

	constructor(assetsDir: string, logger: Logger) {
		this.#assetsDir = assetsDir;
		this.#logger = logger;
	}

	async render(input: CardInput): Promise<Uint8Array | null> {
		const background = await this.#background(input.kind);
		if (!background) return null;
		this.#ensureFont();
		const [avatar] = await Promise.all([this.#avatar(input.avatarUrl)]);

		const canvas = createCanvas(WIDTH, HEIGHT);
		const ctx = canvas.getContext("2d");
		drawCover(ctx, background);
		const shade = ctx.createLinearGradient(0, 0, WIDTH, 0);
		shade.addColorStop(0, "rgba(0,0,0,0.72)");
		shade.addColorStop(0.55, "rgba(0,0,0,0.55)");
		shade.addColorStop(1, "rgba(0,0,0,0.25)");
		ctx.fillStyle = shade;
		ctx.fillRect(0, 0, WIDTH, HEIGHT);

		const avatarSize = 200;
		const avatarX = 72;
		const avatarY = (HEIGHT - avatarSize) / 2;
		ctx.save();
		ctx.beginPath();
		ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2 + 6, 0, Math.PI * 2);
		ctx.fillStyle = input.kind === "welcome" ? "#ffffff" : "#737373";
		ctx.fill();
		ctx.beginPath();
		ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
		ctx.clip();
		if (avatar) ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);
		else {
			ctx.fillStyle = "#262626";
			ctx.fillRect(avatarX, avatarY, avatarSize, avatarSize);
		}
		ctx.restore();

		const textX = avatarX + avatarSize + 56;
		const maxTextWidth = WIDTH - textX - 56;
		ctx.fillStyle = "#a3a3a3";
		ctx.font = `500 26px ${FONT}`;
		ctx.fillText(
			input.kind === "welcome" ? `Welcome to ${input.serverName}` : `Left ${input.serverName}`,
			textX,
			150,
		);
		ctx.fillStyle = "#ffffff";
		ctx.font = `700 60px ${FONT}`;
		ctx.fillText(fitText(ctx, input.displayName, maxTextWidth), textX, 222);
		ctx.fillStyle = "#a3a3a3";
		ctx.font = `400 26px ${FONT}`;
		const footer = [
			`@${input.username}`,
			input.memberCount !== undefined && input.kind === "welcome"
				? `Member #${input.memberCount.toLocaleString("en-US")}`
				: null,
		].filter(Boolean).join("   ·   ");
		ctx.fillText(fitText(ctx, footer, maxTextWidth), textX, 272);

		return new Uint8Array(await canvas.encode("png"));
	}

	#ensureFont(): void {
		if (this.#fontReady) return;
		const path = join(this.#assetsDir, "fonts", "Inter.ttf");
		try {
			GlobalFonts.registerFromPath(path, FONT);
		} catch (error) {
			this.#logger.warn("card font missing, falling back to system fonts", { path, error });
		}
		this.#fontReady = true;
	}

	async #background(kind: CardKind): Promise<Image | null> {
		if (this.#backgrounds.has(kind)) return this.#backgrounds.get(kind) ?? null;
		const path = join(this.#assetsDir, "cards", `${kind}.png`);
		let image: Image | null = null;
		try {
			image = await loadImage(await Deno.readFile(path));
		} catch (error) {
			if (!(error instanceof Deno.errors.NotFound)) {
				this.#logger.warn("card background unreadable", { path, error });
			}
		}
		if (image) this.#backgrounds.set(kind, image);
		return image;
	}

	async #avatar(url: string | null): Promise<Image | null> {
		if (!url) return null;
		try {
			const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}size=256`, {
				signal: AbortSignal.timeout(5000),
			});
			if (!response.ok) return null;
			return await loadImage(new Uint8Array(await response.arrayBuffer()));
		} catch (error) {
			this.#logger.debug("avatar fetch failed", { error });
			return null;
		}
	}

	invalidate(): void {
		this.#backgrounds.clear();
	}
}

function drawCover(
	ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
	image: Image,
): void {
	const scale = Math.max(WIDTH / image.width, HEIGHT / image.height);
	const w = image.width * scale;
	const h = image.height * scale;
	ctx.drawImage(image, (WIDTH - w) / 2, (HEIGHT - h) / 2, w, h);
}

function fitText(
	ctx: { measureText(text: string): { width: number } },
	text: string,
	maxWidth: number,
): string {
	if (ctx.measureText(text).width <= maxWidth) return text;
	let out = text;
	while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
	return `${out}…`;
}
