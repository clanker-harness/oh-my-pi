/**
 * Approval for an exact per-call `model` on task items, eval `agent()` and
 * `workpool()`.
 *
 * A model-facing selector may name any available chat model, so a caller can
 * pin a subagent to the model the user asked for. `task.perCallModelAllow`,
 * when set, restricts exact per-call models to the identities it lists. Both
 * the operator's list ({@link Settings.grantAuthority}, which leaves out
 * project settings) and the live merged one (project and subagent-injected
 * layers) must admit a model, so a repository can narrow the operator's list
 * but never widen it. Model role aliases (`@smol`, `@slow`, …) never reach this
 * check: they route through the role configuration like agent frontmatter.
 *
 * Approval is checked again on every request a per-call child sends, so a model
 * that loses its credentials or leaves the allowlist mid-run fails the request
 * instead of silently running on another model.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../config/model-registry";
import {
	formatModelStringWithRouting,
	getModelMatchPreferences,
	type ModelMatchPreferences,
	normalizeModelPatternList,
	resolveExplicitModelRole,
	resolveModelRoleValue,
} from "../config/model-resolver";
import { getKnownRoleIds, isKindRole } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { cfgTaskPerCallModelAllow } from "./settings";

/** A per-call model request could not be dispatched or restored. */
export class PerCallModelError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PerCallModelError";
	}
}

/** The per-call model is not an available chat model, so it cannot be approved. */
export class PerCallModelUnavailableError extends PerCallModelError {
	constructor(message: string) {
		super(message);
		this.name = "PerCallModelUnavailableError";
	}
}

/**
 * What an exact per-call model is checked against on every request. `settings` is read live, so
 * an allowlist change applies to the next request; its grant authority and its own merged view
 * (project and subagent-injected layers included) must both admit the model.
 */
export interface PerCallModelGrants {
	settings: Settings;
	agentName: string;
}

type ApprovalRegistry = Pick<ModelRegistry, "getAll" | "getAvailable">;

/** Prompt data for the per-call `model` parameter. */
export interface PerCallModelAdvertisement {
	/** Chat role aliases a caller may send as `@<role>`, each with the exact selectors its configured value names. */
	roles: { role: string; patterns: string[] }[];
	/** Exact selectors admitted by `task.perCallModelAllow`; empty when any available chat model is allowed. */
	allowlist: string[];
}

/** Concrete selectors a role value names; nested role aliases and inherit markers are routing, not models. */
function roleValuePatterns(source: string | string[] | undefined, settings: Settings): string[] {
	const patterns = new Set<string>();
	for (const pattern of normalizeModelPatternList(source)) {
		const bare = pattern.toLowerCase();
		if (bare === "default" || bare === "inherit" || resolveExplicitModelRole(pattern, settings)) continue;
		patterns.add(pattern);
	}
	return [...patterns];
}

/** The allowlist compares canonical identities literally; it never resolves or case-folds entries. */
function allowlistAdmitsIdentity(allow: string[], identity: string): boolean {
	return allow.length === 0 || allow.some(entry => entry.trim() === identity);
}

/**
 * The operator's allowlist and the live one, which includes project and subagent-injected layers.
 * A model must satisfy both, so a project list can narrow the operator's but never replace it.
 */
function perCallAllowlists(settings: Settings): [operator: string[], live: string[]] {
	return [cfgTaskPerCallModelAllow.get(settings.grantAuthority()), cfgTaskPerCallModelAllow.get(settings)];
}

function allowlistsAdmitIdentity(allowlists: string[][], identity: string): boolean {
	return allowlists.every(allow => allowlistAdmitsIdentity(allow, identity));
}

/** A bare role value resolves among the chat models; a literal catalog id only ever names itself. */
function resolveRoleValue(
	pattern: string,
	chat: Model<Api>[],
	catalog: Model<Api>[],
	matchPreferences?: ModelMatchPreferences,
) {
	const knownLiteralId = catalog.some(candidate => candidate.id === pattern);
	const candidates = knownLiteralId ? chat.filter(candidate => candidate.id === pattern) : chat;
	return resolveModelRoleValue(pattern, candidates, { matchPreferences });
}

/**
 * Inputs a cached advertisement was computed from: the operator view, the live settings
 * revision, and the catalog snapshot (absent when the computation never read the catalog).
 * `skippedBare` marks a computation that dropped bare role values for lack of a registry, so a
 * later call that supplies one recomputes instead of reusing the registry-less result.
 */
interface AdvertisementCacheKey {
	authority: Settings;
	revision: number;
	catalog?: Model<Api>[];
	skippedBare: boolean;
}

function isCurrent(cached: AdvertisementCacheKey, settings: Settings, registry?: ApprovalRegistry): boolean {
	return (
		cached.authority === settings.grantAuthority() &&
		cached.revision === settings.revision &&
		!(cached.skippedBare && registry) &&
		(cached.catalog === undefined || cached.catalog === registry?.getAll())
	);
}

const advertisementCache = new WeakMap<Settings, AdvertisementCacheKey & PerCallModelAdvertisement>();

/**
 * Each chat role alias with its configured value as selectors a caller could also send exactly;
 * globs are skipped. Provider-qualified values are shown as written, so rendering never composes
 * the full catalog; a bare value needs the registry to name its provider.
 */
function advertisedSelectors(
	settings: Settings,
	registry: ApprovalRegistry | undefined,
): AdvertisementCacheKey & PerCallModelAdvertisement {
	const allowlists = perCallAllowlists(settings);
	const [operatorAllow, liveAllow] = allowlists;
	let models: { chat: Model<Api>[]; catalog: Model<Api>[]; preferences: ModelMatchPreferences } | undefined;
	let skippedBare = false;
	const advertise = (pattern: string): string | undefined => {
		if (/[*?]/.test(pattern)) return undefined;
		if (pattern.includes("/")) return pattern;
		if (!registry) {
			skippedBare = true;
			return undefined;
		}
		models ??= {
			chat: registry.getAvailable("chat"),
			catalog: registry.getAll(),
			preferences: getModelMatchPreferences(settings),
		};
		const resolved = resolveRoleValue(pattern, models.chat, models.catalog, models.preferences);
		if (!resolved.model) return undefined;
		const identity = formatModelStringWithRouting(resolved.model);
		return resolved.explicitThinkingLevel && resolved.thinkingLevel
			? `${identity}:${resolved.thinkingLevel}`
			: identity;
	};
	const configured = settings.getModelRoles();
	const roles = getKnownRoleIds(settings)
		.filter(role => !isKindRole(role))
		.map(role => ({
			role,
			patterns: [
				...new Set(
					roleValuePatterns(configured[role], settings)
						.map(advertise)
						.filter(selector => selector !== undefined),
				),
			],
		}));
	return {
		authority: settings.grantAuthority(),
		revision: settings.revision,
		catalog: models?.catalog,
		skippedBare,
		roles,
		allowlist: [...new Set((operatorAllow.length > 0 ? operatorAllow : liveAllow).map(entry => entry.trim()))].filter(
			entry => allowlistsAdmitIdentity(allowlists, entry),
		),
	};
}

/** Prompt data for the per-call `model` parameter. Reused until the settings or catalog change. */
export function getPerCallModelAdvertisement(
	settings: Settings,
	registry?: ApprovalRegistry,
): PerCallModelAdvertisement {
	let cached = advertisementCache.get(settings);
	if (!cached || !isCurrent(cached, settings, registry)) {
		cached = advertisedSelectors(settings, registry);
		advertisementCache.set(settings, cached);
	}
	return { roles: cached.roles, allowlist: cached.allowlist };
}

/**
 * Throw {@link PerCallModelError} unless `model` is an available chat model that
 * `task.perCallModelAllow` admits (an empty allowlist admits every one).
 */
export function assertPerCallModelApproved(
	model: Model<Api>,
	grants: PerCallModelGrants,
	registry: ApprovalRegistry,
): void {
	const target = formatModelStringWithRouting(model);
	// Never cached: a login can make the model available without a settings change.
	const chat = registry.getAvailable("chat");
	if (!chat.some(candidate => candidate.provider === model.provider && candidate.id === model.id)) {
		throw new PerCallModelUnavailableError(`Per-call model ${target} is not an available chat model.`);
	}
	if (allowlistsAdmitIdentity(perCallAllowlists(grants.settings), target)) return;
	throw new PerCallModelError(
		`Per-call model ${target} is not listed in task.perCallModelAllow, so agent "${grants.agentName}" cannot run on it. Use a listed model or a model role alias (e.g. @smol), or omit model.`,
	);
}
