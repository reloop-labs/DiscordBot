import type { CreateApplicationCommand } from "@discordeno/bot";
import type { CommandModule, ComponentModule } from "../interactions/router.ts";

export interface CommandDefinition extends CommandModule {
	definition: CreateApplicationCommand;
	components?: ComponentModule[];
}

export interface CommandSet {
	commands: CommandDefinition[];
	components: ComponentModule[];
}

export function collect(...sets: (CommandDefinition | CommandDefinition[])[]): CommandSet {
	const commands = sets.flat();
	const components = commands.flatMap((command) => command.components ?? []);
	return { commands, components };
}
