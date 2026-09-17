import type { Logger } from "../logging/logger.ts";

type Step = { name: string; run: () => Promise<void> | void };

export class Lifecycle {
	#steps: Step[] = [];
	#shuttingDown = false;
	#logger: Logger;

	constructor(logger: Logger) {
		this.#logger = logger;
	}

	onShutdown(name: string, run: Step["run"]): void {
		this.#steps.push({ name, run });
	}

	get shuttingDown(): boolean {
		return this.#shuttingDown;
	}

	listenForSignals(): void {
		for (const signal of ["SIGTERM", "SIGINT"] as const) {
			Deno.addSignalListener(signal, () => {
				this.#logger.info("signal received", { signal });
				this.shutdown().then(() => Deno.exit(0));
			});
		}
	}

	async shutdown(): Promise<void> {
		if (this.#shuttingDown) return;
		this.#shuttingDown = true;
		for (const step of [...this.#steps].reverse()) {
			try {
				await Promise.race([
					step.run(),
					new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 10_000)),
				]);
				this.#logger.info("shutdown step complete", { step: step.name });
			} catch (error) {
				this.#logger.error("shutdown step failed", { step: step.name, error });
			}
		}
	}
}
