export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = Record<string, unknown>;

export interface Logger {
	debug(message: string, context?: LogContext): void;
	info(message: string, context?: LogContext): void;
	warn(message: string, context?: LogContext): void;
	error(message: string, context?: LogContext): void;
	child(context: LogContext): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LoggerOptions {
	level: LogLevel;
	base?: LogContext;
	secrets?: string[];
	write?: (line: string) => void;
}

export function createLogger(options: LoggerOptions): Logger {
	const threshold = LEVEL_ORDER[options.level];
	const secrets = (options.secrets ?? []).filter((secret) => secret.length >= 8);
	const write = options.write ?? ((line: string) => console.log(line));

	const redact = (value: string): string => {
		let out = value;
		for (const secret of secrets) out = out.replaceAll(secret, "[redacted]");
		return out;
	};

	const build = (bound: LogContext): Logger => {
		const emit = (level: LogLevel, message: string, context?: LogContext) => {
			if (LEVEL_ORDER[level] < threshold) return;
			const record = { time: new Date().toISOString(), level, message, ...bound, ...context };
			write(redact(JSON.stringify(record, replacer)));
		};
		return {
			debug: (message, context) => emit("debug", message, context),
			info: (message, context) => emit("info", message, context),
			warn: (message, context) => emit("warn", message, context),
			error: (message, context) => emit("error", message, context),
			child: (context) => build({ ...bound, ...context }),
		};
	};

	return build(options.base ?? {});
}

function replacer(_key: string, value: unknown): unknown {
	if (typeof value === "bigint") return value.toString();
	if (value instanceof Error) {
		return { name: value.name, message: value.message, stack: value.stack, cause: value.cause };
	}
	return value;
}

export function errorId(): string {
	return crypto.randomUUID().slice(0, 8);
}

export const silentLogger: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	child: () => silentLogger,
};
