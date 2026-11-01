import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { parseModelPattern } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { isKindRole } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import {
	assertPerCallModelApproved,
	getPerCallModelAdvertisement,
	PerCallModelError,
	PerCallModelUnavailableError,
} from "@oh-my-pi/pi-coding-agent/task/model-approval";
import { cfgTaskPerCallModelAllow, perCallModelEnabled } from "@oh-my-pi/pi-coding-agent/task/settings";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const target = createMockModel({ id: "target" });
const other = createMockModel({ id: "other" });
const image = { ...createMockModel({ id: "painter" }), kind: "image" as const };
const routerModel = (provider: string, id: string, baseUrl: string) =>
	buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
const sonnet = routerModel("openrouter", "anthropic/claude-sonnet-4.5", "https://openrouter.ai/api/v1");
const pinnedSonnet = parseModelPattern("openrouter/anthropic/claude-sonnet-4.5@anthropic", [sonnet]).model!;
// Separate catalog models: a literal `:low` id is its own identity, never the base id at a level.
const codingRouter = routerModel("nanogpt", "nanogpt/coding-router", "https://nano-gpt.com/api/v1");
const codingRouterLow = routerModel("nanogpt", "nanogpt/coding-router:low", "https://nano-gpt.com/api/v1");
const chat = [target, other, sonnet, codingRouter, codingRouterLow];
const registry = {
	getAll: () => [...chat, image],
	getAvailable: (kind?: string) => (kind === "chat" ? chat : [...chat, image]),
};

function approved(
	model: Model,
	settings: Settings,
	modelRegistry: Parameters<typeof assertPerCallModelApproved>[2] = registry,
): boolean {
	try {
		assertPerCallModelApproved(model, { settings, agentName: "worker" }, modelRegistry);
		return true;
	} catch (error) {
		if (!(error instanceof PerCallModelError)) throw error;
		return false;
	}
}

interface Row {
	name: string;
	settings?: Record<string, unknown>;
	/** Settings injected by a subagent overlay on top of `settings`. */
	overlay?: Record<string, unknown>;
	model?: Model;
	unavailable?: Model;
	approved: boolean;
}

const allowPinned = { "task.perCallModelAllow": ["openrouter/anthropic/claude-sonnet-4.5@anthropic"] };
const allowLowRouter = { "task.perCallModelAllow": ["nanogpt/nanogpt/coding-router:low"] };

const rows: Row[] = [
	// No grant step: naming an available chat model is enough.
	{ name: "any available chat model with nothing configured", approved: true },
	{ name: "a model no role names", settings: { modelRoles: { review: "mock/other" } }, approved: true },
	{ name: "an aggregator route no role names", model: sonnet, approved: true },
	{ name: "an unavailable model", unavailable: target, approved: false },
	{ name: "a non-chat model never qualifies", model: image, approved: false },
	{ name: "an allowlist listing the model", settings: { "task.perCallModelAllow": ["mock/target"] }, approved: true },
	{
		name: "an allowlist that omits the model restricts it",
		settings: { "task.perCallModelAllow": ["mock/other"] },
		approved: false,
	},
	{
		name: "a role value does not widen a set allowlist",
		settings: { modelRoles: { review: "mock/target" }, "task.perCallModelAllow": ["mock/other"] },
		approved: false,
	},
	{ name: "the allowlist never expands a glob", settings: { "task.perCallModelAllow": ["mock/*"] }, approved: false },
	{
		name: "the allowlist trims literal entries",
		settings: { "task.perCallModelAllow": [" mock/target "] },
		approved: true,
	},
	{ name: "the allowlist keeps an upstream pin", settings: allowPinned, model: sonnet, approved: false },
	{
		name: "an allowlisted pinned route admits that route",
		settings: allowPinned,
		model: pinnedSonnet,
		approved: true,
	},
	{
		name: "an allowlisted id with a level-shaped suffix admits that id",
		settings: allowLowRouter,
		model: codingRouterLow,
		approved: true,
	},
	{
		name: "an allowlisted id with a level-shaped suffix never admits the base id",
		settings: allowLowRouter,
		model: codingRouter,
		approved: false,
	},
	{
		name: "a subagent overlay's allowlist narrows",
		overlay: { "task.perCallModelAllow": ["mock/other"] },
		approved: false,
	},
	{
		name: "a subagent overlay's allowlist cannot replace the operator's",
		settings: { "task.perCallModelAllow": ["mock/other"] },
		overlay: { "task.perCallModelAllow": ["mock/target"] },
		approved: false,
	},
];

describe("per-call model approval", () => {
	it.each(rows)("$name", row => {
		const settings = row.overlay
			? Settings.isolated(row.settings ?? {}).overlay(row.overlay, { derived: true })
			: Settings.isolated(row.settings ?? {});
		const available = chat.filter(model => model !== row.unavailable);
		const modelRegistry = { ...registry, getAvailable: () => available };
		expect(approved(row.model ?? target, settings, modelRegistry)).toBe(row.approved);
	});

	it("reports an unavailable model apart from an allowlist refusal", () => {
		const settings = Settings.isolated({ "task.perCallModelAllow": ["mock/other"] });
		const modelRegistry = { ...registry, getAvailable: () => [other] };
		expect(() => assertPerCallModelApproved(target, { settings, agentName: "worker" }, modelRegistry)).toThrow(
			PerCallModelUnavailableError,
		);
		expect(() => assertPerCallModelApproved(target, { settings, agentName: "worker" }, registry)).toThrow(
			'Per-call model mock/target is not listed in task.perCallModelAllow, so agent "worker" cannot run on it.',
		);
	});

	it("reads allowlist edits live on every request", () => {
		const settings = Settings.isolated();
		expect(approved(target, settings)).toBe(true);
		cfgTaskPerCallModelAllow.override(settings, ["mock/other"]);
		expect(approved(target, settings)).toBe(false);
		cfgTaskPerCallModelAllow.override(settings, []);
		expect(approved(target, settings)).toBe(true);
	});

	it("honors an allowlist configured by an SDK host overlay", () => {
		const settings = Settings.isolated().overlay({ "task.perCallModelAllow": ["mock/target"] });
		expect(approved(target, settings)).toBe(true);
		expect(approved(other, settings)).toBe(false);
	});

	it("rejects a non-string task.perCallModelAllow entry from a config file and a runtime write", async () => {
		const tempDir = TempDir.createSync("@pi-per-call-allow-");
		try {
			const overlay = tempDir.join("overlay.yml");
			await Bun.write(overlay, "task:\n  perCallModelAllow:\n    - mock/target\n    - 42\n");
			await expect(Settings.loadIsolated({ inMemory: true, configFiles: [overlay] })).rejects.toThrow(
				"Invalid task.perCallModelAllow[1]",
			);
		} finally {
			tempDir.removeSync();
		}
		expect(() => Settings.isolated({ "task.perCallModelAllow": [{ id: "mock/target" }] })).toThrow(
			"Invalid task.perCallModelAllow[0]",
		);
	});
});

describe("per-call model advertisement", () => {
	it("lists every chat role alias and no allowlist by default", () => {
		const advertisement = getPerCallModelAdvertisement(Settings.isolated());
		expect(advertisement.allowlist).toEqual([]);
		expect(advertisement.roles.map(entry => entry.role)).toContain("smol");
		expect(advertisement.roles.every(entry => !isKindRole(entry.role))).toBe(true);
	});

	it("names each role's configured exact selectors, skipping globs, aliases and inherit markers", () => {
		const settings = Settings.isolated({
			modelRoles: {
				smol: "anthropic/claude-haiku-4-5",
				alias: "@smol",
				legacyAlias: "pi/slow",
				starAlias: "*",
				defaulted: "default",
				inherited: "inherit",
				slow: "unavailable/model@upstream:high",
				custom: "anthropic/*, @slow, default, mock/target, anthropic/*, inherit",
			},
		});
		const patterns = Object.fromEntries(
			getPerCallModelAdvertisement(settings).roles.map(entry => [entry.role, entry.patterns]),
		);
		expect(patterns.smol).toEqual(["anthropic/claude-haiku-4-5"]);
		expect(patterns.slow).toEqual(["unavailable/model@upstream:high"]);
		expect(patterns.custom).toEqual(["mock/target"]);
		for (const role of ["alias", "legacyAlias", "starAlias", "defaulted", "inherited"]) {
			expect(patterns[role]).toEqual([]);
		}
	});

	it("keeps role selectors when an allowlist is set, since role aliases stay usable", () => {
		const settings = Settings.isolated({
			modelRoles: { smol: "mock/target" },
			"task.perCallModelAllow": ["mock/other", " mock/other "],
		});
		const advertisement = getPerCallModelAdvertisement(settings);
		expect(advertisement.roles.find(entry => entry.role === "smol")?.patterns).toEqual(["mock/target"]);
		expect(advertisement.allowlist).toEqual(["mock/other"]);
	});

	it("resolves a bare role value to its exact selector only with a registry", () => {
		const settings = Settings.isolated({ modelRoles: { review: "target" } });
		expect(getPerCallModelAdvertisement(settings).roles.find(entry => entry.role === "review")?.patterns).toEqual([]);
		expect(
			getPerCallModelAdvertisement(settings, registry).roles.find(entry => entry.role === "review")?.patterns,
		).toEqual(["mock/target"]);
	});

	it("advertises only what both the operator's and a derived allowlist admit", () => {
		const root = Settings.isolated({ "task.perCallModelAllow": ["mock/target", "mock/other"] });
		const child = root.overlay({ "task.perCallModelAllow": ["mock/other", "mock/extra"] }, { derived: true });
		expect(getPerCallModelAdvertisement(child).allowlist).toEqual(["mock/other"]);
	});

	it("refreshes from current settings", () => {
		const settings = Settings.isolated({ modelRoles: { smol: "mock/original" } });
		const smol = () => getPerCallModelAdvertisement(settings).roles.find(entry => entry.role === "smol")?.patterns;
		expect(smol()).toEqual(["mock/original"]);
		settings.setModelRole("smol", "mock/edited");
		cfgTaskPerCallModelAllow.override(settings, ["mock/edited"]);
		expect(smol()).toEqual(["mock/edited"]);
		expect(getPerCallModelAdvertisement(settings).allowlist).toEqual(["mock/edited"]);
	});
});

// Repository settings are agent-writable, so they may narrow per-call selection but never widen it.
describe("project settings and per-call selection", () => {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let project: string;

	beforeEach(() => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-per-call-project-");
		agentDir = tempDir.join("agent");
		project = tempDir.join("repo");
		for (const dir of [agentDir, project]) fs.mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		tempDir.removeSync();
	});

	function writeRepositorySettings(settings: Record<string, unknown>): void {
		fs.mkdirSync(getProjectAgentDir(project), { recursive: true });
		fs.writeFileSync(path.join(getProjectAgentDir(project), "settings.json"), JSON.stringify(settings));
	}

	async function load(operator: Record<string, unknown>, repository?: Record<string, unknown>): Promise<Settings> {
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify(operator));
		if (repository) writeRepositorySettings(repository);
		return Settings.loadIsolated({ cwd: project, agentDir });
	}

	it.each<{ operator: string[]; repository: string[]; admitted: string[] }>([
		{ operator: [], repository: [], admitted: ["target", "other"] },
		{ operator: ["mock/target"], repository: ["mock/target", "mock/other"], admitted: ["target"] },
		{ operator: [], repository: ["mock/other"], admitted: ["other"] },
	])(
		"admits $admitted with operator allowlist $operator and project allowlist $repository",
		async ({ operator, repository, admitted }) => {
			const settings = await load(
				{ task: { perCallModelAllow: operator } },
				{ task: { perCallModelAllow: repository } },
			);
			expect([target, other].filter(model => approved(model, settings)).map(model => model.id)).toEqual(admitted);
		},
	);

	it("enables per-call models for task and eval calls by default", async () => {
		const settings = await load({});
		expect(perCallModelEnabled(settings, "task")).toBe(true);
		expect(perCallModelEnabled(settings, "eval")).toBe(true);
	});

	it.each([
		{ operator: "off", repository: "on", task: false, evalCall: false },
		{ operator: "on", repository: "off", task: false, evalCall: false },
		{ operator: "on", repository: "eval", task: false, evalCall: true },
		{ operator: "eval", repository: "on", task: false, evalCall: true },
	])(
		"lets project task.perCallModel $repository only narrow operator $operator",
		async ({ operator, repository, task, evalCall }) => {
			const settings = await load({ task: { perCallModel: operator } }, { task: { perCallModel: repository } });
			expect(perCallModelEnabled(settings, "task")).toBe(task);
			expect(perCallModelEnabled(settings, "eval")).toBe(evalCall);
		},
	);
});
