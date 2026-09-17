const SEPARATOR = ":";
const PREFIX = "loop";

export function encodeCustomId(
	domain: string,
	action: string,
	...args: (string | number | bigint)[]
): string {
	const id = [PREFIX, domain, action, ...args.map(String)].join(SEPARATOR);
	if (id.length > 100) throw new RangeError(`custom id exceeds 100 characters: ${id}`);
	return id;
}

export interface DecodedCustomId {
	domain: string;
	action: string;
	args: string[];
}

export function decodeCustomId(customId: string): DecodedCustomId | null {
	const parts = customId.split(SEPARATOR);
	if (parts.length < 3 || parts[0] !== PREFIX) return null;
	return { domain: parts[1]!, action: parts[2]!, args: parts.slice(3) };
}
