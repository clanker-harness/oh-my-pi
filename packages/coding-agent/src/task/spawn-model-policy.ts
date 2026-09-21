/**
 * Validation for a caller-supplied per-spawn model selector.
 *
 * Any model the session can actually reach is fair game, plus every model
 * role alias (`@smol`, `@slow`, custom roles). The only thing rejected is a
 * selector that resolves to nothing.
 *
 * That rejection is the whole point and is not optional:
 * `resolveConfiguredModelPatterns` yields `[]` for an unresolvable selector
 * and `resolveEffectiveAgentModelSelection` then falls through to the session
 * default — so an unchecked typo runs the spawn on the wrong model with no
 * signal to anyone. This is the failure mode that got per-call model removed
 * upstream (#6438); catching it here is what makes the field safe to expose.
 *
 * `task.allowedSpawnModels` is an optional lockdown: leave it empty (the
 * default) and every available model is spawnable; set it and spawns are
 * restricted to those entries.
 */
import { getKnownRoleIds, MODEL_ROLE_ALIAS_PREFIX } from "../config/model-roles";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelString, normalizeModelPatternList, resolveModelOverride } from "../config/model-resolver";
import type { Settings } from "../config/settings";

/** What a caller may name in a spawn's `model` field for this session. */
export interface SpawnModelAuthorization {
	/** Role ids (without the `@` sigil) the user's settings define. */
	roles: readonly string[];
	/** When non-empty, spawns are restricted to these selectors (plus roles). */
	allowlist: readonly string[];
	/** Resolves a concrete selector against the session's reachable models. */
	resolve: (pattern: string) => boolean;
}

interface SpawnModelPolicyHost {
	settings: Settings;
	modelRegistry?: ModelRegistry;
}

/**
 * Strip a trailing `:level` thinking suffix so `@smol:high` and
 * `anthropic/claude-opus-5:xhigh` validate on their base selector.
 */
function baseSelector(selector: string): string {
	const colon = selector.lastIndexOf(":");
	return colon > 0 ? selector.slice(0, colon) : selector;
}

/** Role alias (`@name`, `pi/name`, `*`) reduced to its bare role id, else undefined. */
function roleIdOf(selector: string): string | undefined {
	if (selector === "*") return "default";
	if (selector.startsWith(MODEL_ROLE_ALIAS_PREFIX)) return selector.slice(MODEL_ROLE_ALIAS_PREFIX.length);
	if (selector.startsWith("pi/")) return selector.slice(3);
	return undefined;
}

/** Snapshot the legal spawn-model vocabulary for this session. */
export function spawnModelAuthorization(host: SpawnModelPolicyHost): SpawnModelAuthorization {
	const registry = host.modelRegistry;
	return {
		roles: getKnownRoleIds(host.settings),
		allowlist: normalizeModelPatternList(host.settings.get("task.allowedSpawnModels")),
		// No registry (isolated tests, host embeddings) means nothing local can
		// prove a selector wrong, so accept it and let the provider decide.
		resolve: registry
			? pattern => resolveModelOverride([pattern], registry, host.settings).model !== undefined
			: () => true,
	};
}

/** Human-readable description of what a caller may pass, for prompts and errors. */
export function describeSpawnModelAuthorization(auth: SpawnModelAuthorization): string {
	const roles = auth.roles.map(role => `${MODEL_ROLE_ALIAS_PREFIX}${role}`).join(", ");
	if (auth.allowlist.length > 0) return `${auth.allowlist.join(", ")}, ${roles}`;
	return `any available model (e.g. \`anthropic/claude-opus-5\`), or a role alias: ${roles}`;
}

/**
 * Reason `selector` cannot be used, or `undefined` when it can. A caller may
 * pass a comma-separated fallback chain; every entry must be usable, because
 * any of them can be the one that actually runs.
 */
export function unauthorizedSpawnModelReason(
	selector: string | readonly string[],
	auth: SpawnModelAuthorization,
): string | undefined {
	const patterns = normalizeModelPatternList(selector as string | string[]);
	if (patterns.length === 0) return "empty model selector";
	for (const pattern of patterns) {
		const base = baseSelector(pattern);
		const role = roleIdOf(base);
		if (role !== undefined) {
			if (auth.roles.includes(role)) continue;
			return `unknown model role "${pattern}"`;
		}
		if (auth.allowlist.length > 0) {
			if (auth.allowlist.includes(base)) continue;
			return `model "${pattern}" is not in task.allowedSpawnModels`;
		}
		if (auth.resolve(pattern)) continue;
		return `no available model matches "${pattern}"`;
	}
	return undefined;
}

/** Canonical `provider/id` for a resolved selector, for display on the spawn card. */
export function resolveSpawnModelDisplay(pattern: string, host: SpawnModelPolicyHost): string | undefined {
	if (!host.modelRegistry) return undefined;
	const resolved = resolveModelOverride([pattern], host.modelRegistry, host.settings).model;
	return resolved ? formatModelString(resolved) : undefined;
}
