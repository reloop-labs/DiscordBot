import { createClient } from "redis";
import type { Logger } from "../logging/logger.ts";

export interface KeyValueStore {
	available(): boolean;
	get(key: string): Promise<string | null>;
	set(key: string, value: string, ttlMs?: number): Promise<void>;
	del(...keys: string[]): Promise<void>;
	incrWithTtl(key: string, ttlMs: number): Promise<number | null>;
	slidingWindowAdd(key: string, windowMs: number, member?: string): Promise<number | null>;
	acquireLock(key: string, ttlMs: number): Promise<boolean>;
	releaseLock(key: string): Promise<void>;
	close(): Promise<void>;
}

export function createRedisStore(
	url: string,
	logger: Logger,
): KeyValueStore & { connect(): Promise<void> } {
	const client = createClient({
		url,
		socket: {
			reconnectStrategy: (retries) => Math.min(1000 * 2 ** retries, 30_000),
			connectTimeout: 5_000,
		},
		disableOfflineQueue: true,
	});
	let ready = false;
	client.on("ready", () => {
		ready = true;
		logger.info("redis ready");
	});
	client.on("end", () => {
		ready = false;
	});
	client.on("error", (error: unknown) => {
		ready = false;
		logger.warn("redis error", { error });
	});

	const guarded = async <T>(operation: () => Promise<T>, fallback: T): Promise<T> => {
		if (!ready) return fallback;
		try {
			return await operation();
		} catch (error) {
			logger.warn("redis operation failed", { error });
			return fallback;
		}
	};

	return {
		async connect() {
			try {
				await client.connect();
			} catch (error) {
				logger.warn("redis unavailable at startup, continuing degraded", { error });
			}
		},
		available: () => ready,
		get: (key) => guarded(() => client.get(key), null),
		set: (key, value, ttlMs) =>
			guarded(async () => {
				await client.set(key, value, ttlMs ? { PX: ttlMs } : {});
			}, undefined),
		del: (...keys) =>
			guarded(async () => {
				if (keys.length) await client.del(keys);
			}, undefined),
		incrWithTtl: (key, ttlMs) =>
			guarded(async () => {
				const value = await client.incr(key);
				if (value === 1) await client.pExpire(key, ttlMs);
				return value;
			}, null),
		slidingWindowAdd: (key, windowMs, member) =>
			guarded(async () => {
				const now = Date.now();
				const id = member ?? `${now}-${crypto.randomUUID().slice(0, 8)}`;
				const results = await client
					.multi()
					.zAdd(key, { score: now, value: id })
					.zRemRangeByScore(key, 0, now - windowMs)
					.zCard(key)
					.pExpire(key, windowMs)
					.exec();
				const count = results[2];
				return typeof count === "number" ? count : Number(count);
			}, null),
		acquireLock: (key, ttlMs) =>
			guarded(async () => (await client.set(key, "1", { NX: true, PX: ttlMs })) === "OK", true),
		releaseLock: (key) =>
			guarded(async () => {
				await client.del(key);
			}, undefined),
		async close() {
			if (client.isOpen) await client.quit().catch(() => client.destroy());
		},
	};
}

export function createMemoryStore(): KeyValueStore & { connect(): Promise<void> } {
	const values = new Map<string, { value: string; expiresAt: number | null }>();
	const windows = new Map<string, { id: string; at: number }[]>();
	const live = (key: string) => {
		const entry = values.get(key);
		if (!entry) return null;
		if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
			values.delete(key);
			return null;
		}
		return entry;
	};
	return {
		connect: () => Promise.resolve(),
		available: () => true,
		get: (key) => Promise.resolve(live(key)?.value ?? null),
		set: (key, value, ttlMs) => {
			values.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null });
			return Promise.resolve();
		},
		del: (...keys) => {
			for (const key of keys) values.delete(key);
			return Promise.resolve();
		},
		incrWithTtl: (key, ttlMs) => {
			const current = live(key);
			const next = (current ? Number(current.value) : 0) + 1;
			values.set(key, { value: String(next), expiresAt: current?.expiresAt ?? Date.now() + ttlMs });
			return Promise.resolve(next);
		},
		slidingWindowAdd: (key, windowMs, member) => {
			const now = Date.now();
			const id = member ?? `${now}-${crypto.randomUUID().slice(0, 8)}`;
			const kept = (windows.get(key) ?? []).filter((entry) =>
				entry.at > now - windowMs && entry.id !== id
			);
			kept.push({ id, at: now });
			windows.set(key, kept);
			return Promise.resolve(kept.length);
		},
		acquireLock: (key, ttlMs) => {
			if (live(key)) return Promise.resolve(false);
			values.set(key, { value: "1", expiresAt: Date.now() + ttlMs });
			return Promise.resolve(true);
		},
		releaseLock: (key) => {
			values.delete(key);
			return Promise.resolve();
		},
		close: () => Promise.resolve(),
	};
}
