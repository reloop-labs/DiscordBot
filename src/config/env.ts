import { z } from "zod";

const snowflake = z.string().regex(/^\d{17,20}$/, "must be a Discord snowflake");

const schema = z.object({
	DISCORD_TOKEN: z.string().min(50, "must be a bot token"),
	DISCORD_APPLICATION_ID: snowflake,
	DISCORD_DEV_GUILD_ID: snowflake.optional(),
	DISCORD_REGISTER_COMMANDS: z.string().regex(
		/^(global|guild:\d{17,20}|off)$/,
		"must be global, guild:<id> or off",
	).default("guild:1390212514658123836"),
	DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
	REDIS_URL: z.url({ protocol: /^rediss?$/ }),
	PORT: z.coerce.number().int().min(1).max(65535).default(8080),
	HEALTH_HOST: z.string().min(1).default("127.0.0.1"),
	LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
	ENVIRONMENT: z.enum(["development", "production", "test"]).default("development"),
	TRANSCRIPT_DIR: z.string().min(1).default("./data/transcripts"),
	ASSETS_DIR: z.string().min(1).default("./assets"),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: Record<string, string | undefined> = Deno.env.toObject()): Env {
	const present = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""));
	const result = schema.safeParse(present);
	if (!result.success) {
		const issues = result.error.issues.map((issue) =>
			`  ${issue.path.join(".")}: ${issue.message}`
		);
		throw new Error(`Invalid environment configuration:\n${issues.join("\n")}`);
	}
	return result.data;
}

export function secretsOf(env: Env): string[] {
	const secrets = [env.DISCORD_TOKEN];
	for (const url of [env.DATABASE_URL, env.REDIS_URL]) {
		const password = URL.parse(url)?.password;
		if (password) secrets.push(decodeURIComponent(password));
	}
	return secrets;
}
