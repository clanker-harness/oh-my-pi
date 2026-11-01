import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { KIND_ROLE_IDS } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { invalidModelSelectorReason } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import { getTaskSchema } from "@oh-my-pi/pi-coding-agent/task/types";

// Contract: with the default `task.perCallModel: on`, a spawn may name any exact
// provider/model-id or a model role alias, with no tagging step. The rejection
// that matters is a selector that cannot name one model: resolving it later would
// silently fall back to another model, the failure that once got per-call model removed.

function reason(model: unknown, settings: Record<string, unknown> = {}, invocationKind: "task" | "eval" = "task") {
	return invalidModelSelectorReason(model, "The call", { settings: Settings.isolated(settings), invocationKind });
}

describe("per-call model selectors", () => {
	it("accepts any exact provider/model-id by default, with no prior tagging", () => {
		expect(reason("anthropic/claude-opus-5")).toBeUndefined();
		expect(reason("anthropic/claude-opus-5:xhigh")).toBeUndefined();
	});

	it("accepts model role aliases, with or without a thinking level", () => {
		expect(reason("@smol")).toBeUndefined();
		expect(reason("@slow:xhigh")).toBeUndefined();
		expect(reason("@review", { modelRoles: { review: "mock/target" } })).toBeUndefined();
		expect(reason("pi/review", { modelRoles: { review: "mock/target" } })).toBeUndefined();
	});

	it("rejects an unknown role alias, naming the known roles", () => {
		const text = reason("@nonesuch");
		expect(text).toContain("unknown model role");
		expect(text).toContain("@smol");
	});

	it("rejects a role that routes a non-chat model", () => {
		const kind = KIND_ROLE_IDS[0];
		expect(reason(`@${kind}`, { modelRoles: { [kind]: "mock/painter" } })).toContain("non-chat model");
	});

	it("rejects candidate lists, globs, partial ids and blanks", () => {
		for (const model of ["@smol,openai/gpt-5.6", "anthropic/*", "opus", "   ", ["anthropic/claude-opus-5"]]) {
			expect(reason(model)).toContain("invalid `model` value");
		}
	});

	it("reports a disabled gate before judging the selector", () => {
		expect(reason("@nonesuch", { "task.perCallModel": "off" })).toContain("task.perCallModel: off");
		expect(reason("anthropic/claude-opus-5", { "task.perCallModel": "eval" }, "task")).toContain(
			"task.perCallModel: eval",
		);
		expect(reason("anthropic/claude-opus-5", { "task.perCallModel": "eval" }, "eval")).toBeUndefined();
	});
});

describe("task wire schema model/team fields", () => {
	it("always carries a caller model; preflight decides whether it is allowed", () => {
		const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: false });
		const parsed = schema({
			agent: "scout",
			task: "Map the auth module.",
			solutionSpace: "map only",
			model: "@smol",
		});
		expect(parsed instanceof type.errors).toBe(false);
		expect(parsed).toMatchObject({ model: "@smol" });
	});

	it("carries team and per-item role in the batch shape when teams are on", () => {
		const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: true, teamsEnabled: true });
		const parsed = schema({
			context: "Refactor the auth module.",
			team: "refactor",
			tasks: [
				{
					agent: "task",
					task: "Port the token store.",
					solutionSpace: "one port, API given",
					role: "backend",
					model: "@slow",
				},
			],
		});
		expect(parsed instanceof type.errors).toBe(false);
		expect(parsed).toMatchObject({ team: "refactor", tasks: [{ role: "backend", model: "@slow" }] });
	});

	it("drops team and role when teams are off", () => {
		const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: true, teamsEnabled: false });
		const parsed = schema({
			context: "Refactor the auth module.",
			team: "refactor",
			tasks: [
				{ agent: "task", task: "Port the token store.", solutionSpace: "one port, API given", role: "backend" },
			],
		});
		expect(parsed instanceof type.errors).toBe(false);
		expect(parsed).not.toHaveProperty("team");
		expect(parsed).not.toHaveProperty("tasks.0.role");
	});

	it("never carries a role in the flat shape, which spawns one agent", () => {
		const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: false, teamsEnabled: true });
		const parsed = schema({ agent: "task", task: "Port it.", solutionSpace: "one port", role: "backend" });
		expect(parsed instanceof type.errors).toBe(false);
		expect(parsed).not.toHaveProperty("role");
	});
});
