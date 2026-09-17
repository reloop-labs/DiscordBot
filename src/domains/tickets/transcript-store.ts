import { ValidationFailed } from "../../shared/errors.ts";

export interface TranscriptStore {
	put(key: string, body: Uint8Array | string): Promise<{ sizeBytes: number }>;
	get(key: string): Promise<Uint8Array | null>;
}

const ALLOWED_KEY = /^[A-Za-z0-9_./-]+$/;

export function assertTranscriptKey(key: string): string {
	if (!ALLOWED_KEY.test(key) || key.split("/").includes("..") || key.startsWith("/")) {
		throw new ValidationFailed("That transcript key is not valid.");
	}
	return key;
}

export function createLocalTranscriptStore(rootDir: string): TranscriptStore {
	const pathFor = (key: string) => `${rootDir}/${assertTranscriptKey(key)}`;
	return {
		async put(key, body) {
			const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
			const path = pathFor(key);
			const directory = path.slice(0, path.lastIndexOf("/"));
			if (directory) await Deno.mkdir(directory, { recursive: true });
			await Deno.writeFile(path, bytes);
			return { sizeBytes: bytes.byteLength };
		},
		async get(key) {
			try {
				return await Deno.readFile(pathFor(key));
			} catch (error) {
				if (error instanceof Deno.errors.NotFound) return null;
				throw error;
			}
		},
	};
}
