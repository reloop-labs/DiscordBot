import { assertEquals, assertThrows } from "@std/assert";
import {
	resolveSelection,
	type SelectionMenu,
	type SelectionOption,
} from "../../src/domains/roles/role-menu-service.ts";
import { HierarchyViolation, ValidationFailed } from "../../src/shared/errors.ts";

const RED = 300000000000000001n;
const BLUE = 300000000000000002n;
const GREEN = 300000000000000003n;
const OUTSIDE = 300000000000000009n;

function option(roleId: bigint, extra: Partial<SelectionOption> = {}): SelectionOption {
	return { roleId, requiresRoleId: null, conflictsWithRoleIds: [], ...extra };
}

function menu(extra: Partial<SelectionMenu> = {}): SelectionMenu {
	return { exclusive: false, maxSelections: null, requiredRoleId: null, ...extra };
}

Deno.test("toggle adds a role the member does not hold", () => {
	const result = resolveSelection({
		menu: menu(),
		options: [option(RED), option(BLUE)],
		memberRoleIds: [OUTSIDE],
		selected: [RED],
		mode: "toggle",
	});
	assertEquals(result, { added: [RED], removed: [] });
});

Deno.test("toggle removes a role the member holds", () => {
	const result = resolveSelection({
		menu: menu(),
		options: [option(RED), option(BLUE)],
		memberRoleIds: [OUTSIDE, RED],
		selected: [RED],
		mode: "toggle",
	});
	assertEquals(result, { added: [], removed: [RED] });
});

Deno.test("exclusive menus swap the held role", () => {
	const result = resolveSelection({
		menu: menu({ exclusive: true }),
		options: [option(RED), option(BLUE)],
		memberRoleIds: [RED, OUTSIDE],
		selected: [BLUE],
		mode: "toggle",
	});
	assertEquals(result, { added: [BLUE], removed: [RED] });
});

Deno.test("exclusive menus reject picking two roles at once", () => {
	assertThrows(
		() =>
			resolveSelection({
				menu: menu({ exclusive: true }),
				options: [option(RED), option(BLUE)],
				memberRoleIds: [],
				selected: [RED, BLUE],
				mode: "set",
			}),
		ValidationFailed,
	);
});

Deno.test("max selections caps additions", () => {
	assertThrows(
		() =>
			resolveSelection({
				menu: menu({ maxSelections: 2 }),
				options: [option(RED), option(BLUE), option(GREEN)],
				memberRoleIds: [RED, BLUE],
				selected: [GREEN],
				mode: "toggle",
			}),
		ValidationFailed,
	);
});

Deno.test("max selections still allows removing down to the cap", () => {
	const result = resolveSelection({
		menu: menu({ maxSelections: 1 }),
		options: [option(RED), option(BLUE), option(GREEN)],
		memberRoleIds: [RED, BLUE, GREEN],
		selected: [GREEN],
		mode: "toggle",
	});
	assertEquals(result, { added: [], removed: [GREEN] });
});

Deno.test("a prerequisite role is required before adding", () => {
	assertThrows(
		() =>
			resolveSelection({
				menu: menu(),
				options: [option(RED, { requiresRoleId: OUTSIDE })],
				memberRoleIds: [],
				selected: [RED],
				mode: "toggle",
			}),
		ValidationFailed,
	);
	const result = resolveSelection({
		menu: menu(),
		options: [option(RED, { requiresRoleId: OUTSIDE })],
		memberRoleIds: [OUTSIDE],
		selected: [RED],
		mode: "toggle",
	});
	assertEquals(result.added, [RED]);
});

Deno.test("conflicting roles block the addition", () => {
	assertThrows(
		() =>
			resolveSelection({
				menu: menu(),
				options: [option(RED, { conflictsWithRoleIds: [BLUE] }), option(BLUE)],
				memberRoleIds: [BLUE],
				selected: [RED],
				mode: "toggle",
			}),
		ValidationFailed,
	);
});

Deno.test("a conflict removed in the same operation is allowed", () => {
	const result = resolveSelection({
		menu: menu(),
		options: [option(RED, { conflictsWithRoleIds: [BLUE] }), option(BLUE)],
		memberRoleIds: [BLUE],
		selected: [RED],
		mode: "set",
	});
	assertEquals(result, { added: [RED], removed: [BLUE] });
});

Deno.test("set mode leaves roles outside the menu alone", () => {
	const result = resolveSelection({
		menu: menu(),
		options: [option(RED), option(BLUE), option(GREEN)],
		memberRoleIds: [OUTSIDE, RED, BLUE],
		selected: [BLUE, GREEN],
		mode: "set",
	});
	assertEquals(result.added, [GREEN]);
	assertEquals(result.removed, [RED]);
});

Deno.test("the required role gates the whole menu", () => {
	assertThrows(
		() =>
			resolveSelection({
				menu: menu({ requiredRoleId: OUTSIDE }),
				options: [option(RED)],
				memberRoleIds: [],
				selected: [RED],
				mode: "toggle",
			}),
		ValidationFailed,
	);
});

Deno.test("roles the bot cannot manage are rejected", () => {
	assertThrows(
		() =>
			resolveSelection({
				menu: menu(),
				options: [option(RED)],
				memberRoleIds: [],
				selected: [RED],
				mode: "toggle",
				assertManageable: () => {
					throw new HierarchyViolation("Loop's role must be above **Red** to assign it.");
				},
			}),
		HierarchyViolation,
	);
});

Deno.test("selecting a role outside the menu is rejected", () => {
	assertThrows(
		() =>
			resolveSelection({
				menu: menu(),
				options: [option(RED)],
				memberRoleIds: [],
				selected: [OUTSIDE],
				mode: "toggle",
			}),
		ValidationFailed,
	);
});
