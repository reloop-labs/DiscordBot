export const NO_MENTIONS = { parse: [] as never[] };

export function escapeMarkdown(text: string): string {
	return text.replaceAll(/([\\`*_~|>#\-[\]()])/g, "\\$1");
}

export function neutralizeMentions(text: string): string {
	return text.replaceAll("@everyone", "@​everyone").replaceAll("@here", "@​here").replaceAll(
		/<@&(\d+)>/g,
		"<@​&$1>",
	);
}

export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function userMention(id: bigint): string {
	return `<@${id}>`;
}

export function channelMention(id: bigint): string {
	return `<#${id}>`;
}

export function roleMention(id: bigint): string {
	return `<@&${id}>`;
}

export function codeInline(text: string): string {
	return `\`${text.replaceAll("`", "'")}\``;
}
