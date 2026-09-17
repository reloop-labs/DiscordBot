import { commandOptionsParser, InteractionTypes, MessageFlags } from "@discordeno/bot";
import type { LoopInteraction } from "../bot.ts";
import type { Embed, OutboundMessage } from "../adapters/discord-api.ts";
import type { Logger } from "../../logging/logger.ts";
import { NO_MENTIONS } from "../../shared/text.ts";

export type Reply = OutboundMessage & { ephemeral?: boolean };

export class InteractionContext {
	readonly interaction: LoopInteraction;
	readonly logger: Logger;
	readonly guildId: bigint;
	readonly userId: bigint;
	readonly channelId: bigint | null;
	#deferred = false;
	#replied = false;

	constructor(interaction: LoopInteraction, logger: Logger) {
		this.interaction = interaction;
		this.logger = logger;
		if (!interaction.guildId) throw new Error("interaction outside guild");
		this.guildId = interaction.guildId;
		this.userId = interaction.user.id;
		this.channelId = interaction.channelId ?? null;
	}

	get member() {
		return this.interaction.member;
	}

	get commandName(): string {
		return this.interaction.data?.name ?? "";
	}

	get subcommandPath(): string[] {
		const path: string[] = [];
		let options = this.interaction.data?.options;
		while (options?.[0] && (options[0].type === 1 || options[0].type === 2)) {
			path.push(options[0].name);
			options = options[0].options;
		}
		return path;
	}

	options<T extends Record<string, unknown> = Record<string, unknown>>(): T {
		let options = this.interaction.data?.options;
		while (options?.[0] && (options[0].type === 1 || options[0].type === 2)) {
			options = options[0].options;
		}
		return commandOptionsParser(this.interaction, options) as unknown as T;
	}

	string(name: string): string | undefined {
		const value = this.options()[name];
		return typeof value === "string" ? value : undefined;
	}

	requireString(name: string): string {
		const value = this.string(name);
		if (value === undefined) throw new Error(`missing option ${name}`);
		return value;
	}

	integer(name: string): number | undefined {
		const value = this.options()[name];
		return typeof value === "number" ? value : undefined;
	}

	boolean(name: string): boolean | undefined {
		const value = this.options()[name];
		return typeof value === "boolean" ? value : undefined;
	}

	userOption(name: string): { id: bigint; username: string; isBot: boolean } | undefined {
		const value = this.options()[name] as
			| { user?: { id: bigint; username: string; bot: boolean } }
			| undefined;
		if (!value?.user) return undefined;
		return { id: value.user.id, username: value.user.username, isBot: value.user.bot };
	}

	roleOption(name: string): bigint | undefined {
		const value = this.options()[name] as { id?: bigint } | undefined;
		return value?.id;
	}

	channelOption(name: string): bigint | undefined {
		const value = this.options()[name] as { id?: bigint } | undefined;
		return value?.id;
	}

	get targetUserId(): bigint | undefined {
		return this.interaction.data?.targetId;
	}

	get customId(): string {
		return this.interaction.data?.customId ?? "";
	}

	get selectedValues(): string[] {
		return this.interaction.data?.values ?? [];
	}

	modalValue(customId: string): string {
		for (const row of this.interaction.data?.components ?? []) {
			for (const component of row.components ?? []) {
				if (component.customId === customId) return component.value ?? "";
			}
		}
		return "";
	}

	get isComponent(): boolean {
		return this.interaction.type === InteractionTypes.MessageComponent;
	}

	get isModal(): boolean {
		return this.interaction.type === InteractionTypes.ModalSubmit;
	}

	async defer(ephemeral = true): Promise<void> {
		if (this.#deferred || this.#replied) return;
		this.#deferred = true;
		await this.interaction.defer(ephemeral);
	}

	async deferUpdate(): Promise<void> {
		if (this.#deferred || this.#replied) return;
		this.#deferred = true;
		await this.interaction.deferEdit();
	}

	async reply(reply: Reply | string): Promise<void> {
		const payload = typeof reply === "string" ? { content: reply, ephemeral: true } : reply;
		const { ephemeral = true, ...rest } = payload;
		const data = {
			...rest,
			allowedMentions: rest.allowedMentions ?? NO_MENTIONS,
			flags: ephemeral ? MessageFlags.Ephemeral : undefined,
		};
		if (this.#deferred || this.#replied) {
			await this.interaction.edit(data);
			return;
		}
		this.#replied = true;
		await this.interaction.respond(data, { isPrivate: ephemeral });
	}

	async update(reply: OutboundMessage): Promise<void> {
		const data = { ...reply, allowedMentions: reply.allowedMentions ?? NO_MENTIONS };
		if (this.#deferred || this.#replied) {
			await this.interaction.edit(data);
			return;
		}
		this.#replied = true;
		await this.interaction.edit(data);
	}

	async showModal(
		modal: { title: string; customId: string; components: OutboundMessage["components"] },
	): Promise<void> {
		this.#replied = true;
		await this.interaction.respond({
			title: modal.title,
			customId: modal.customId,
			components: modal.components,
		});
	}

	get acknowledged(): boolean {
		return this.#deferred || this.#replied;
	}

	embed(embed: Embed): Embed {
		return { color: 0x5865f2, ...embed };
	}
}
