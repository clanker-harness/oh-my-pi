import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	describeSpawnModelAuthorization,
	spawnModelAuthorization,
	unauthorizedSpawnModelReason,
} from "@oh-my-pi/pi-coding-agent/task/spawn-model-policy";
import { getTaskSchema } from "@oh-my-pi/pi-coding-agent/task/types";

// Contract: any model the session can reach is spawnable, plus every model
// role alias. The one rejection that matters is an unresolvable selector:
// `resolveConfiguredModelPatterns` yields [] for it and the resolver then
// silently falls back to the session default, so without this check a typo
// runs the spawn on the wrong model with no signal to anyone.

function auth(options: { available?: string[]; allowlist?: string[] } = {}) {
	const available = new Set(options.available ?? ["anthropic/claude-opus-5", "openai/gpt-5.6"]);
	const base = spawnModelAuthorization({
		settings: Settings.isolated({ "task.allowedSpawnModels": options.allowlist ?? [] }),
	});
	return { ...base, resolve: (pattern: string) => available.has(pattern) };
}

describe("spawn model validation", () => {
	it("accepts any reachable model by name, with no prior tagging", () => {
		expect(unauthorizedSpawnModelReason("anthropic/claude-opus-5", auth())).toBeUndefined();
	});

	it("accepts role aliases", () => {
		expect(unauthorizedSpawnModelReason("@smol", auth())).toBeUndefined();
		expect(unauthorizedSpawnModelReason("@slow:xhigh", auth())).toBeUndefined();
	});

	it("rejects an unknown role alias", () => {
		expect(unauthorizedSpawnModelReason("@nonesuch", auth())).toContain("unknown model role");
	});

	it("rejects a selector no available model matches", () => {
		// The bug this guards: an unresolvable selector otherwise falls through
		// to the session default and runs on a model nobody asked for.
		expect(unauthorizedSpawnModelReason("anthropic/claude-opus-55", auth())).toContain("no available model matches");
	});

	it("rejects an empty selector", () => {
		expect(unauthorizedSpawnModelReason("   ", auth())).toBe("empty model selector");
	});

	it("restricts to task.allowedSpawnModels once that list is set", () => {
		const locked = auth({ allowlist: ["openai/gpt-5.6"] });
		expect(unauthorizedSpawnModelReason("openai/gpt-5.6", locked)).toBeUndefined();
		expect(unauthorizedSpawnModelReason("anthropic/claude-opus-5", locked)).toContain("task.allowedSpawnModels");
		// Role aliases stay usable under lockdown — they resolve to whatever the
		// operator configured, so the list does not need to enumerate them.
		expect(unauthorizedSpawnModelReason("@smol", locked)).toBeUndefined();
	});

	it("rejects a fallback chain when any entry is unusable", () => {
		expect(unauthorizedSpawnModelReason("@smol,openai/gpt-5.6", auth())).toBeUndefined();
		expect(unauthorizedSpawnModelReason("@smol,openai/nope", auth())).toContain("no available model matches");
	});

	it("describes an unrestricted session as accepting any available model", () => {
		expect(describeSpawnModelAuthorization(auth())).toContain("any available model");
	});

	it("describes a locked-down session by listing its allowlist", () => {
		const text = describeSpawnModelAuthorization(auth({ allowlist: ["openai/gpt-5.6"] }));
		expect(text).toContain("openai/gpt-5.6");
		expect(text).not.toContain("any available model");
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
