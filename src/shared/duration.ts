const UNITS: Record<string, number> = {
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
	w: 604_800_000,
};

export const MAX_TIMEOUT_MS = 28 * UNITS.d!;

export function parseDuration(input: string): number | null {
	const text = input.trim().toLowerCase().replaceAll(/\s+/g, "");
	if (!/^(\d+[smhdw])+$/.test(text)) return null;
	let total = 0;
	for (const [, amount, unit] of text.matchAll(/(\d+)([smhdw])/g)) {
		total += Number(amount) * UNITS[unit!]!;
	}
	return total > 0 ? total : null;
}

export function formatDuration(ms: number): string {
	if (ms <= 0) return "0s";
	const parts: string[] = [];
	let rest = Math.floor(ms / 1000);
	for (
		const [label, seconds] of [["w", 604_800], ["d", 86_400], ["h", 3_600], ["m", 60], [
			"s",
			1,
		]] as const
	) {
		const count = Math.floor(rest / seconds);
		if (count > 0) {
			parts.push(`${count}${label}`);
			rest -= count * seconds;
		}
	}
	return parts.slice(0, 3).join(" ");
}

export function discordTimestamp(date: Date, style: "R" | "f" | "F" | "d" = "f"): string {
	return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}
