import { desc, eq } from "drizzle-orm";
import type { Database } from "../../database/client.ts";
import {
	ticketCategories,
	ticketEvents,
	ticketNotes,
	tickets,
	ticketTranscripts,
} from "../../database/schema/index.ts";
import type { DiscordApi, Embed, MessageSnapshot } from "../../discord/adapters/discord-api.ts";
import type { Logger } from "../../logging/logger.ts";
import type { TranscriptStore } from "./transcript-store.ts";

export type Ticket = typeof tickets.$inferSelect;
export type TicketEvent = typeof ticketEvents.$inferSelect;
export type TicketTranscript = typeof ticketTranscripts.$inferSelect;

export interface GeneratedTranscript {
	key: string;
	messageCount: number;
	sizeBytes: number;
	html: string;
}

const MESSAGE_PAGE = 100;
const MAX_MESSAGES = 5000;

export function transcriptKey(guildId: bigint, ticketNumber: number): string {
	return `${guildId}/${ticketNumber}.html`;
}

export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

export function renderMarkdown(content: string): string {
	return escapeHtml(content)
		.replaceAll(
			/```[A-Za-z0-9+#.-]*\n?([\s\S]*?)```/g,
			(_match, code: string) => `<pre>${code}</pre>`,
		)
		.replaceAll(/`([^`\n]+)`/g, "<code>$1</code>")
		.replaceAll(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replaceAll(/\*([^*\n]+)\*/g, "<em>$1</em>")
		.replaceAll("\n", "<br>");
}

function formatBytes(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function stamp(at: Date): string {
	return at.toISOString().replace("T", " ").slice(0, 19);
}

function renderEmbed(embed: Embed): string {
	const parts: string[] = [];
	if (embed.title) parts.push(`<div class="embed-title">${escapeHtml(embed.title)}</div>`);
	if (embed.description) {
		parts.push(`<div class="embed-body">${renderMarkdown(embed.description)}</div>`);
	}
	for (const field of embed.fields ?? []) {
		parts.push(
			`<div class="embed-field"><span>${escapeHtml(field.name)}</span>${
				renderMarkdown(field.value)
			}</div>`,
		);
	}
	return `<div class="embed">${parts.join("")}</div>`;
}

function renderMessage(message: MessageSnapshot): string {
	const parts: string[] = [];
	if (message.referencedMessageId) {
		parts.push(
			`<div class="reply">↳ replying to ${escapeHtml(String(message.referencedMessageId))}</div>`,
		);
	}
	parts.push(
		`<div class="meta"><span class="author">${escapeHtml(message.authorUsername)}</span>` +
			`<span class="id">${escapeHtml(String(message.authorId))}</span>` +
			`<span class="time">${escapeHtml(stamp(message.createdAt))}</span>` +
			`${message.editedAt ? '<span class="tag">edited</span>' : ""}</div>`,
	);
	if (message.content) parts.push(`<div class="content">${renderMarkdown(message.content)}</div>`);
	for (const attachment of message.attachments) {
		parts.push(
			`<div class="attachment"><a href="${escapeHtml(attachment.url)}" rel="noreferrer">${
				escapeHtml(attachment.name)
			}</a> <span class="id">${escapeHtml(formatBytes(attachment.size))}</span></div>`,
		);
	}
	for (const embed of message.embeds) parts.push(renderEmbed(embed));
	return `<div class="message">${parts.join("")}</div>`;
}

function eventLine(event: TicketEvent): string {
	const actor = event.actorId ? `user ${event.actorId}` : "system";
	const data = event.data;
	const subject = typeof data.userId === "string" ? ` user ${data.userId}` : "";
	switch (event.type) {
		case "opened":
			return `Ticket opened by ${actor}`;
		case "claimed":
			return `Claimed by ${actor}`;
		case "unclaimed":
			return `Unclaimed by ${actor}`;
		case "participant_added":
			return `${actor} added${subject}`;
		case "participant_removed":
			return `${actor} removed${subject}`;
		case "transferred":
			return `${actor} transferred this ticket to ${
				String(data.categoryName ?? "another category")
			}`;
		case "closed":
			return `Closed by ${actor}${data.reason ? `: ${String(data.reason)}` : ""}`;
		case "reopened":
			return `Reopened by ${actor}`;
		case "note_added":
			return `${actor} added a staff note`;
		default:
			return `${event.type.replaceAll("_", " ")} by ${actor}`;
	}
}

const STYLE = `
:root { color-scheme: dark; }
body { margin: 0; padding: 24px; background: #16181d; color: #dbdee1;
	font: 14px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif; }
main { max-width: 860px; margin: 0 auto; }
header { border-bottom: 1px solid #2c2f36; padding-bottom: 16px; margin-bottom: 24px; }
h1 { font-size: 20px; margin: 0 0 12px; color: #fff; }
dl { display: grid; grid-template-columns: 140px 1fr; gap: 4px 16px; margin: 0; }
dt { color: #949ba4; } dd { margin: 0; }
.message { padding: 8px 0; border-bottom: 1px solid #202329; }
.meta { display: flex; gap: 8px; align-items: baseline; }
.author { font-weight: 600; color: #fff; }
.id, .time { color: #6d6f78; font-size: 12px; }
.tag { color: #6d6f78; font-size: 11px; text-transform: uppercase; }
.reply { color: #949ba4; font-size: 12px; margin-bottom: 2px; }
.content { white-space: pre-wrap; word-wrap: break-word; }
.system { padding: 6px 0; color: #949ba4; font-style: italic; border-bottom: 1px solid #202329; }
.embed { border-left: 4px solid #5865f2; background: #1e2026; padding: 8px 12px; margin: 6px 0;
	border-radius: 4px; }
.embed-title { font-weight: 600; color: #fff; }
.embed-field span { display: block; color: #949ba4; font-size: 12px; margin-top: 6px; }
.attachment { margin-top: 4px; }
a { color: #00a8fc; }
code, pre { background: #101114; border-radius: 4px; font-family: ui-monospace, monospace; }
code { padding: 1px 4px; }
pre { display: block; padding: 8px; overflow-x: auto; white-space: pre-wrap; }
.notes { margin-top: 24px; border-top: 1px solid #2c2f36; padding-top: 16px; }
.notes h2 { font-size: 15px; color: #fff; }
footer { margin-top: 24px; color: #6d6f78; font-size: 12px; }
`;

export class TranscriptService {
	#api: DiscordApi;
	#db: Database;
	#store: TranscriptStore;
	#logger: Logger;

	constructor(api: DiscordApi, db: Database, store: TranscriptStore, logger: Logger) {
		this.#api = api;
		this.#db = db;
		this.#store = store;
		this.#logger = logger;
	}

	async generate(
		ticket: Ticket,
		events: TicketEvent[],
		notesForStaff: boolean,
	): Promise<GeneratedTranscript> {
		const messages = await this.#collect(ticket.channelId);
		const [category] = ticket.categoryId
			? await this.#db.select().from(ticketCategories).where(
				eq(ticketCategories.id, ticket.categoryId),
			)
			: [];
		const notes = notesForStaff
			? await this.#db
				.select()
				.from(ticketNotes)
				.where(eq(ticketNotes.ticketId, ticket.id))
				.orderBy(ticketNotes.createdAt)
			: [];

		const rows = [
			...messages.map((message) => ({
				at: message.createdAt,
				html: renderMessage(message),
			})),
			...events.map((event) => ({
				at: event.createdAt,
				html: `<div class="system">${escapeHtml(stamp(event.createdAt))} — ${
					escapeHtml(eventLine(event))
				}</div>`,
			})),
		].sort((a, b) => a.at.getTime() - b.at.getTime());

		const html = this.#document(ticket, category?.name ?? "Uncategorised", rows, notes);
		const key = transcriptKey(ticket.guildId, ticket.ticketNumber);
		const { sizeBytes } = await this.#store.put(key, html);
		await this.#db.insert(ticketTranscripts).values({
			ticketId: ticket.id,
			storageKey: key,
			format: "html",
			messageCount: messages.length,
			sizeBytes,
		});
		this.#logger.info("transcript generated", {
			ticketId: ticket.id,
			messageCount: messages.length,
			sizeBytes,
		});
		return { key, messageCount: messages.length, sizeBytes, html };
	}

	async latest(ticketId: string): Promise<TicketTranscript | null> {
		const [row] = await this.#db
			.select()
			.from(ticketTranscripts)
			.where(eq(ticketTranscripts.ticketId, ticketId))
			.orderBy(desc(ticketTranscripts.createdAt))
			.limit(1);
		return row ?? null;
	}

	async #collect(channelId: bigint): Promise<MessageSnapshot[]> {
		const collected: MessageSnapshot[] = [];
		let before: bigint | undefined;
		while (collected.length < MAX_MESSAGES) {
			const page = await this.#api.getMessages(channelId, {
				limit: MESSAGE_PAGE,
				...(before === undefined ? {} : { before }),
			});
			if (page.length === 0) break;
			collected.push(...page);
			let oldest = page[0]!.id;
			for (const message of page) if (message.id < oldest) oldest = message.id;
			before = oldest;
		}
		return collected
			.slice(0, MAX_MESSAGES)
			.sort((a, b) => (a.id === b.id ? 0 : a.id < b.id ? -1 : 1));
	}

	#document(
		ticket: Ticket,
		categoryName: string,
		rows: { html: string }[],
		notes: { authorId: bigint; content: string; createdAt: Date }[],
	): string {
		const title = `Ticket #${ticket.ticketNumber}`;
		const notesHtml = notes.length
			? `<section class="notes"><h2>Staff notes</h2>${
				notes.map((note) =>
					`<div class="message"><div class="meta"><span class="author">${
						escapeHtml(String(note.authorId))
					}</span><span class="time">${escapeHtml(stamp(note.createdAt))}</span></div>` +
					`<div class="content">${renderMarkdown(note.content)}</div></div>`
				).join("")
			}</section>`
			: "";
		return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main><header><h1>${escapeHtml(title)}</h1><dl>
<dt>Category</dt><dd>${escapeHtml(categoryName)}</dd>
<dt>Opened by</dt><dd>${escapeHtml(String(ticket.openerUserId))}</dd>
<dt>Opened</dt><dd>${escapeHtml(stamp(ticket.createdAt))}</dd>
<dt>Closed</dt><dd>${ticket.closedAt ? escapeHtml(stamp(ticket.closedAt)) : "still open"}</dd>
<dt>Close reason</dt><dd>${escapeHtml(ticket.closeReason ?? "—")}</dd>
</dl></header>${rows.map((row) => row.html).join("")}${notesHtml}
<footer>Generated ${escapeHtml(stamp(new Date()))} by Loop.</footer></main></body></html>`;
	}
}
