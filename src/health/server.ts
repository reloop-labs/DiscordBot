import type { Logger } from "../logging/logger.ts";

export interface ReadinessProbe {
	gatewayConnected(): boolean;
	databaseReachable(): Promise<boolean>;
	redisAvailable(): boolean;
	shuttingDown(): boolean;
}

export function startHealthServer(
	options: { host: string; port: number; probe: ReadinessProbe; logger: Logger },
): { close(): Promise<void> } {
	const { probe, logger } = options;
	const json = (status: number, body: Record<string, unknown>) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json", "cache-control": "no-store" },
		});

	const server = Deno.serve(
		{
			hostname: options.host,
			port: options.port,
			onListen: ({ hostname, port }) => logger.info("health server listening", { hostname, port }),
		},
		async (request) => {
			const path = new URL(request.url).pathname;
			if (request.method !== "GET") return json(405, { error: "method not allowed" });
			if (path === "/healthz") return json(200, { status: "ok" });
			if (path === "/readyz") {
				if (probe.shuttingDown()) return json(503, { status: "shutting_down" });
				const database = await probe.databaseReachable();
				const gateway = probe.gatewayConnected();
				const redis = probe.redisAvailable();
				const ready = database && gateway;
				return json(ready ? 200 : 503, {
					status: ready ? (redis ? "ready" : "degraded") : "not_ready",
					checks: { gateway, database, redis },
				});
			}
			return json(404, { error: "not found" });
		},
	);

	return {
		close: () => server.shutdown(),
	};
}
