import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	describeSpawnModelAuthorization,
	spawnModelAuthorization,
	unauthorizedSpawnModelReason,
} from "@oh-my-pi/pi-coding-agent/task/spawn-model-policy";
import { getTaskSchema } from "@oh-my-pi/pi-coding-agent/task/types";

// Contract: the agent may choose a subagent's model, but only from the
// vocabulary the user already controls — role aliases, models the user tagged
// with `^model` this session, and `task.allowedSpawnModels`. An unauthorized
// selector must fail loudly: `resolveConfiguredModelPatterns` yields [] for an
// unresolvable pattern and the resolver then silently falls back to the
// session default, so a missing rejection runs the spawn on the wrong model.

function auth(options: { mentioned?: string[]; allowlist?: string[] } = {}) {
	return spawnModelAuthorization({
		settings: Settings.isolated({ "task.allowedSpawnModels": options.allowlist ?? [] }),
		getAuthorizedModelSelectors: () => options.mentioned ?? [],
	});
}

describe("spawn model authorization", () => {
	it("accepts built-in role aliases", () => {
		expect(unauthorizedSpawnModelReason("@smol", auth())).toBeUndefined();
		expect(unauthorizedSpawnModelReason("@slow", auth())).toBeUndefined();
	});

	it("accepts a role alias carrying a thinking suffix", () => {
		expect(unauthorizedSpawnModelReason("@slow:xhigh", auth())).toBeUndefined();
	});

	it("rejects an unknown role alias", () => {
		expect(unauthorizedSpawnModelReason("@nonesuch", auth())).toContain("unknown model role");
	});

	it("rejects a concrete selector the user never authorized", () => {
		const reason = unauthorizedSpawnModelReason("anthropic/claude-opus-5", auth());
		expect(reason).toContain("not authorized");
	});

	it("accepts a selector the user tagged this session", () => {
		const session = auth({ mentioned: ["anthropic/claude-opus-5"] });
		expect(unauthorizedSpawnModelReason("anthropic/claude-opus-5", session)).toBeUndefined();
		expect(unauthorizedSpawnModelReason("anthropic/claude-opus-5:high", session)).toBeUndefined();
	});

	it("accepts a pre-authorized selector from settings", () => {
		expect(unauthorizedSpawnModelReason("openai/gpt-5.6", auth({ allowlist: ["openai/gpt-5.6"] }))).toBeUndefined();
	});

	it("rejects a fallback chain when any entry is unauthorized", () => {
		const session = auth({ mentioned: ["anthropic/claude-opus-5"] });
		expect(unauthorizedSpawnModelReason("@smol,anthropic/claude-opus-5", session)).toBeUndefined();
		expect(unauthorizedSpawnModelReason("@smol,openai/gpt-5.6", session)).toContain("not authorized");
	});

	it("rejects an empty selector", () => {
		expect(unauthorizedSpawnModelReason("   ", auth())).toBe("empty model selector");
	});

	it("names the authorized vocabulary so the model can self-correct", () => {
		const text = describeSpawnModelAuthorization(auth({ mentioned: ["anthropic/claude-opus-5"] }));
		expect(text).toContain("@smol");
		expect(text).toContain("anthropic/claude-opus-5");
	});
});

describe("task wire schema model/team gating", () => {
	it("drops a caller model when per-spawn model selection is off", () => {
		const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: false, modelEnabled: false });
		const parsed = schema({ agent: "scout", task: "Map the auth module.", model: "@smol" });
		expect(parsed instanceof type.errors).toBe(false);
		if (parsed && typeof parsed === "object" && !(parsed instanceof type.errors)) {
			expect("model" in parsed).toBe(false);
		}
	});

	it("carries a caller model when enabled", () => {
		const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: false, modelEnabled: true });
		const parsed = schema({ agent: "scout", task: "Map the auth module.", model: "@smol" });
		expect(parsed instanceof type.errors).toBe(false);
		if (parsed && typeof parsed === "object" && !(parsed instanceof type.errors)) {
			expect((parsed as { model?: string }).model).toBe("@smol");
		}
	});

	it("carries team and per-item role in the batch shape when teams are on", () => {
		const schema = getTaskSchema({
			isolationEnabled: false,
			batchEnabled: true,
			modelEnabled: true,
			teamsEnabled: true,
		});
		const parsed = schema({
			context: "Refactor the auth module.",
			team: "refactor",
			tasks: [{ agent: "task", task: "Port the token store.", role: "backend", model: "@slow" }],
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (parsed && typeof parsed === "object" && !(parsed instanceof type.errors)) {
			const batch = parsed as { team?: string; tasks: Array<{ role?: string; model?: string }> };
			expect(batch.team).toBe("refactor");
			expect(batch.tasks[0].role).toBe("backend");
			expect(batch.tasks[0].model).toBe("@slow");
		}
	});

	it("drops team and role when teams are off", () => {
		const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: true, teamsEnabled: false });
		const parsed = schema({
			context: "Refactor the auth module.",
			team: "refactor",
			tasks: [{ agent: "task", task: "Port the token store.", role: "backend" }],
		});
		expect(parsed instanceof type.errors).toBe(false);
		if (parsed && typeof parsed === "object" && !(parsed instanceof type.errors)) {
			const batch = parsed as { team?: string; tasks: Array<{ role?: string }> };
			expect("team" in batch).toBe(false);
			expect("role" in batch.tasks[0]).toBe(false);
		}
	});
});
