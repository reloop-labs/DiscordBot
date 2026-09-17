import { InteractionTypes } from "@discordeno/bot";
import type { LoopInteraction } from "../bot.ts";
import type { Logger } from "../../logging/logger.ts";
import { errorId } from "../../logging/logger.ts";
import { isLoopError } from "../../shared/errors.ts";
import { InteractionContext } from "./context.ts";
import { decodeCustomId } from "./custom-id.ts";

export type Handler = (ctx: InteractionContext) => Promise<void>;

export interface CommandModule {
	name: string;
	handle: Handler;
	autocomplete?: Handler;
}

export interface ComponentModule {
	domain: string;
	handle: Handler;
}

export class InteractionRouter {
	#commands = new Map<string, CommandModule>();
	#components = new Map<string, ComponentModule>();
	#logger: Logger;

	constructor(logger: Logger) {
		this.#logger = logger;
	}

	command(module: CommandModule): this {
		if (this.#commands.has(module.name)) throw new Error(`duplicate command ${module.name}`);
		this.#commands.set(module.name, module);
		return this;
	}

	component(module: ComponentModule): this {
		if (this.#components.has(module.domain)) {
			throw new Error(`duplicate component domain ${module.domain}`);
		}
		this.#components.set(module.domain, module);
		return this;
	}

	async dispatch(interaction: LoopInteraction): Promise<void> {
		if (interaction.type === InteractionTypes.Ping) return;
		if (!interaction.guildId) {
			await interaction.respond("Loop only works inside a server.", { isPrivate: true }).catch(
				() => {},
			);
			return;
		}
		const logger = this.#logger.child({
			interactionId: interaction.id,
			guildId: interaction.guildId,
			userId: interaction.user.id,
			command: interaction.data?.name,
			customId: interaction.data?.customId,
		});
		const ctx = new InteractionContext(interaction, logger);
		try {
			await this.#route(ctx);
		} catch (error) {
			await this.#fail(ctx, error);
		}
	}

	async #route(ctx: InteractionContext): Promise<void> {
		const { interaction } = ctx;
		switch (interaction.type) {
			case InteractionTypes.ApplicationCommand: {
				const module = this.#commands.get(ctx.commandName);
				if (!module) throw new Error(`unknown command ${ctx.commandName}`);
				return module.handle(ctx);
			}
			case InteractionTypes.ApplicationCommandAutocomplete: {
				const module = this.#commands.get(ctx.commandName);
				if (!module?.autocomplete) {
					await interaction.respond({ choices: [] });
					return;
				}
				return module.autocomplete(ctx);
			}
			case InteractionTypes.MessageComponent:
			case InteractionTypes.ModalSubmit: {
				const decoded = decodeCustomId(ctx.customId);
				const module = decoded ? this.#components.get(decoded.domain) : undefined;
				if (!module) throw new Error(`unknown component ${ctx.customId}`);
				return module.handle(ctx);
			}
		}
	}

	async #fail(ctx: InteractionContext, error: unknown): Promise<void> {
		let message: string;
		if (isLoopError(error)) {
			ctx.logger.info("interaction rejected", { code: error.code, reason: error.message });
			message = error.userMessage;
		} else {
			const id = errorId();
			ctx.logger.error("interaction failed", { errorId: id, error });
			message = `Something went wrong on our side. Error ID: \`${id}\``;
		}
		try {
			await ctx.reply({ content: message, ephemeral: true });
		} catch (replyError) {
			ctx.logger.warn("failed to deliver error response", { error: replyError });
		}
	}
}
