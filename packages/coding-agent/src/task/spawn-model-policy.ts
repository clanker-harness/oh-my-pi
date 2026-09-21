/**
 * Authorization for a caller-supplied per-spawn model selector.
 *
 * The agent may pick *which* model a subagent runs on, but not *what models
 * exist*: the legal set is everything the user already controls — model role
 * aliases (`@smol`, `@slow`, custom roles they configured), selectors they
 * tagged in chat with `^model`, and anything explicitly listed in
 * `task.allowedSpawnModels`.
 *
 * Validation here is mandatory rather than advisory.
 * `resolveConfiguredModelPatterns` yields `[]` for an unresolvable selector,
 * and `resolveEffectiveAgentModelSelection` then falls through to the session
 * default — so an unchecked typo runs silently on the wrong model instead of
 * failing. Reject loudly and name the legal values.
 */
import type { Settings } from "../config/settings";
import { getKnownRoleIds, MODEL_ROLE_ALIAS_PREFIX } from "../config/model-roles";
import { normalizeModelPatternList } from "../config/model-resolver";

/** Everything a caller may name in a spawn's `model` field, already normalized. */
export interface SpawnModelAuthorization {
	/** Role ids (without the `@` sigil) the user's settings define. */
	roles: readonly string[];
	/** Canonical `provider/id` selectors authorized by `^model` mentions. */
	mentioned: readonly string[];
	/** Extra selectors pre-approved via `task.allowedSpawnModels`. */
	allowlisted: readonly string[];
}

interface SpawnModelPolicyHost {
	settings: Settings;
	getAuthorizedModelSelectors?: () => readonly string[];
}

/**
 * Strip a trailing `:level` thinking suffix so `@smol:high` and
 * `anthropic/claude-opus-5:xhigh` authorize on their base selector. A bare
 * `provider/id` has no colon; role aliases never contain one before the
 * suffix.
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
	const allowlisted = normalizeModelPatternList(host.settings.get("task.allowedSpawnModels"));
	return {
		roles: getKnownRoleIds(host.settings),
		mentioned: host.getAuthorizedModelSelectors?.() ?? [],
		allowlisted,
	};
}

/** Human-readable list of what a caller may pass, for the rejection message. */
export function describeSpawnModelAuthorization(auth: SpawnModelAuthorization): string {
	const parts: string[] = [auth.roles.map(role => `${MODEL_ROLE_ALIAS_PREFIX}${role}`).join(", ")];
	if (auth.mentioned.length > 0) parts.push(auth.mentioned.join(", "));
	if (auth.allowlisted.length > 0) parts.push(auth.allowlisted.join(", "));
	return parts.filter(Boolean).join(", ");
}

/**
 * Reason `selector` is not authorized, or `undefined` when it is. A caller may
 * pass a comma-separated fallback chain; every entry must authorize
 * independently, because any of them can be the one that actually runs.
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
		if (auth.mentioned.includes(base) || auth.allowlisted.includes(base)) continue;
		return `model "${pattern}" is not authorized for spawning`;
	}
	return undefined;
}
