const DISCORD_EPOCH = 1420070400000n;

export function parseSnowflake(value: string | bigint | number): bigint {
	if (typeof value === "bigint") return value;
	const text = String(value).trim();
	if (!/^\d{17,20}$/.test(text)) throw new RangeError(`Not a Discord snowflake: ${text}`);
	return BigInt(text);
}

export function isSnowflake(value: unknown): value is string {
	return typeof value === "string" && /^\d{17,20}$/.test(value);
}

export function snowflakeCreatedAt(id: bigint): Date {
	return new Date(Number((id >> 22n) + DISCORD_EPOCH));
}

export function accountAgeMs(id: bigint, now: Date = new Date()): number {
	return now.getTime() - snowflakeCreatedAt(id).getTime();
}
