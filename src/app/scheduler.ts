import type { Logger } from "../logging/logger.ts";

export interface Job {
	name: string;
	intervalMs: number;
	run: () => Promise<void>;
}

export class Scheduler {
	#timers: ReturnType<typeof setInterval>[] = [];
	#running = new Set<string>();
	#logger: Logger;

	constructor(logger: Logger) {
		this.#logger = logger;
	}

	add(job: Job): void {
		const tick = async () => {
			if (this.#running.has(job.name)) return;
			this.#running.add(job.name);
			try {
				await job.run();
			} catch (error) {
				this.#logger.error("job failed", { job: job.name, error });
			} finally {
				this.#running.delete(job.name);
			}
		};
		this.#timers.push(setInterval(tick, job.intervalMs));
		setTimeout(tick, Math.min(job.intervalMs, 15_000));
	}

	stop(): void {
		for (const timer of this.#timers) clearInterval(timer);
		this.#timers = [];
	}
}
