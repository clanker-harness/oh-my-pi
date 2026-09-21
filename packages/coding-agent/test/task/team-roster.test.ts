import { describe, expect, it } from "bun:test";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { collectIrcPeerRoster } from "@oh-my-pi/pi-coding-agent/task/executor";

// Contract: a team member always sees its whole team. The peer roster is
// capped at DEFAULT_HUB_LIST_LIMIT, so without an exemption a large session
// silently truncates the very peers the member must coordinate with — and a
// teammate must never appear twice (once as teammate, once as peer).

function registryWith(members: Array<{ id: string; team?: string; role?: string }>): AgentRegistry {
	const registry = new AgentRegistry();
	for (const member of members) {
		registry.register({
			id: member.id,
			displayName: member.id,
			kind: "sub",
			session: null,
			status: "running",
			...(member.team ? { team: member.team } : {}),
			...(member.role ? { role: member.role } : {}),
		});
	}
	return registry;
}

describe("team-scoped peer roster", () => {
	it("lists teammates separately from peers with no duplication", () => {
		const registry = registryWith([
			{ id: "Self", team: "refactor", role: "lead" },
			{ id: "Mate", team: "refactor", role: "backend" },
			{ id: "Stranger" },
		]);
		const roster = collectIrcPeerRoster(registry, "Self", undefined, "refactor");
		expect(roster.team).toBe("refactor");
		expect(roster.teammates.map(row => row.id)).toEqual(["Mate"]);
		expect(roster.teammates[0].role).toBe("backend");
		expect(roster.peers.map(row => row.id)).toEqual(["Stranger"]);
	});

	it("keeps every teammate when the peer cap truncates the rest", () => {
		const crowd = Array.from({ length: 40 }, (_, index) => ({ id: `Peer${index}` }));
		const registry = registryWith([{ id: "Self", team: "refactor" }, { id: "Mate", team: "refactor" }, ...crowd]);
		const roster = collectIrcPeerRoster(registry, "Self", undefined, "refactor");
		expect(roster.teammates.map(row => row.id)).toEqual(["Mate"]);
		expect(roster.omittedCount).toBeGreaterThan(0);
		expect(roster.peers.some(row => row.id === "Mate")).toBe(false);
	});

	it("reports no team when the caller has none", () => {
		const registry = registryWith([{ id: "Self" }, { id: "Other", team: "refactor" }]);
		const roster = collectIrcPeerRoster(registry, "Self");
		expect(roster.team).toBeUndefined();
		expect(roster.teammates).toEqual([]);
		expect(roster.peers.map(row => row.id)).toEqual(["Other"]);
	});
});

describe("registry group addressing", () => {
	it("returns live group members excluding the caller", () => {
		const registry = registryWith([
			{ id: "Self", team: "refactor" },
			{ id: "Mate", team: "refactor" },
			{ id: "Elsewhere", team: "docs" },
		]);
		expect(registry.listGroup("refactor", "Self").map(ref => ref.id)).toEqual(["Mate"]);
		expect(registry.listGroup("docs").map(ref => ref.id)).toEqual(["Elsewhere"]);
		expect(registry.listGroup("missing")).toEqual([]);
	});

	it("excludes parked members so a broadcast cannot revive the whole team", () => {
		const registry = registryWith([
			{ id: "Self", team: "refactor" },
			{ id: "Mate", team: "refactor" },
		]);
		registry.setStatus("Mate", "parked");
		expect(registry.listGroup("refactor", "Self")).toEqual([]);
	});
});
