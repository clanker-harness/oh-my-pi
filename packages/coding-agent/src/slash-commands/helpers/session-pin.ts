import {
	isWithinUsageReserve,
	type ModelUsageHealth,
	resolveUsedFraction,
	type UsageLimit,
	type UsageReport,
} from "@oh-my-pi/pi-ai";
import { isUsageLimitExhausted, usageResetAtMs } from "@oh-my-pi/pi-ai/auth/usage-report";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import type { OAuthAccountSummary } from "../../session/auth-storage";
import { cfgRetryUsageReservePct } from "../../session/settings";
import { formatActiveAccountLabel, limitMatchesActiveAccount } from "./active-oauth-account";

import type {
	SessionPinAccount,
	SessionPinUsage,
	SessionPinUsageWindow,
} from "@oh-my-pi/pi-tui/overlays/session-account-selector";
import { formatLimitTitle } from "@oh-my-pi/pi-tui/overlays/usage-display";

/** Longest the account picker waits on account usage before listing accounts without it. */
const SESSION_PIN_USAGE_TIMEOUT_MS = 5_000;

/** Quota evidence for one provider's accounts. */
export interface SessionPinUsageSources {
	provider: string;
	/** The account router's verdicts (for the current model when it belongs to `provider`). */
	health?: ModelUsageHealth;
	/** Raw provider usage reports, for accounts the router has no verdict on. */
	reports?: readonly UsageReport[];
	/** Remaining fraction (0..1) at or below which an account counts as low. */
	reserveFraction: number;
}

/**
 * Refresh this provider before reading quota and then the router's verdict.
 * A source that fails or outlasts {@link SESSION_PIN_USAGE_TIMEOUT_MS} is
 * left out, so accounts are listed with whatever quota is known.
 */
export async function loadSessionPinUsage(
	session: Pick<AgentSession, "settings" | "modelRegistry" | "getAccountUsage" | "fetchUsageReports">,
	provider: string,
): Promise<SessionPinUsageSources> {
	const signal = AbortSignal.timeout(SESSION_PIN_USAGE_TIMEOUT_MS);
	const failOpen = (source: string) => (error: unknown) => {
		logger.debug("Account usage lookup failed", { provider, source, error: String(error) });
		return undefined;
	};
	try {
		await session.modelRegistry.authStorage.usage.invalidate(provider);
	} catch (error) {
		failOpen("invalidate")(error);
		return { provider, reserveFraction: cfgRetryUsageReservePct.get(session.settings) / 100 };
	}
	const reports = await session.fetchUsageReports(signal).catch(failOpen("reports"));
	// Health consumes the refreshed cache, not the pre-invalidation snapshot.
	const health = await session.getAccountUsage(provider, signal).catch(failOpen("health"));
	return {
		provider,
		health,
		reports: reports ?? undefined,
		reserveFraction: cfgRetryUsageReservePct.get(session.settings) / 100,
	};
}

/** The account's live limits across its own usage reports, each once. */
function accountLimits(account: OAuthAccountSummary, sources: SessionPinUsageSources, nowMs: number): UsageLimit[] {
	const limits = new Map<string, UsageLimit>();
	for (const report of sources.reports ?? []) {
		if (report.provider !== sources.provider) continue;
		for (const limit of report.limits) {
			const resetsAt = limit.window?.resetsAt;
			const live = resetsAt === undefined || resetsAt > nowMs || report.fetchedAt >= resetsAt;
			if (live && !limits.has(limit.id) && limitMatchesActiveAccount(report, limit, account)) {
				limits.set(limit.id, limit);
			}
		}
	}
	return [...limits.values()];
}

/**
 * Quota read straight off the account's own limits: exhausted when any is,
 * otherwise the remaining share of its tightest limit. `source` names that
 * limit because it may not be a subscription window the router gates on
 * (e.g. a Claude org's Extra Usage spend cap).
 */
function reportUsage(
	limits: readonly UsageLimit[],
	reserveFraction: number,
	nowMs: number,
): SessionPinUsage | undefined {
	const exhausted = limits.filter(isUsageLimitExhausted);
	if (exhausted.length > 0) {
		return {
			state: "depleted",
			resetsAt: usageResetAtMs(exhausted, nowMs),
			source: exhausted.length === 1 ? exhausted[0]!.label : undefined,
		};
	}
	let tightest: { label: string; used: number } | undefined;
	for (const limit of limits) {
		const used = resolveUsedFraction(limit);
		if (used !== undefined && (!tightest || used > tightest.used)) tightest = { label: limit.label, used };
	}
	if (!tightest) return undefined;
	const remainingFraction = Math.max(0, 1 - tightest.used);
	return {
		state: isWithinUsageReserve(remainingFraction, reserveFraction) ? "reserve" : "healthy",
		remainingFraction,
		source: tightest.label,
	};
}

/** One limit as a listed quota window, or nothing when it reports neither usage nor a reset. */
function usageWindow(limit: UsageLimit, reserveFraction: number): SessionPinUsageWindow | undefined {
	const used = resolveUsedFraction(limit);
	const remainingFraction = used === undefined ? undefined : Math.max(0, 1 - used);
	const window = limit.window;
	const exhausted = isUsageLimitExhausted(limit);
	if (remainingFraction === undefined && window?.resetsAt === undefined && !exhausted) return undefined;
	return {
		label: formatLimitTitle(limit),
		state: exhausted
			? "depleted"
			: remainingFraction !== undefined && isWithinUsageReserve(remainingFraction, reserveFraction)
				? "reserve"
				: "healthy",
		...(remainingFraction === undefined ? {} : { remainingFraction }),
		...(window?.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
		...(window?.resetLabel ? { resetLabel: window.resetLabel } : {}),
	};
}

/**
 * One account's quota: the router's verdict when it has one, else its own
 * usage reports, plus every window those reports carry so each reset shows.
 * An account a computed health snapshot omits was dropped by the model's plan
 * gate; an empty unknown snapshot means the router had no managed account
 * pool to inspect at all.
 */
function accountUsage(
	account: OAuthAccountSummary,
	sources: SessionPinUsageSources | undefined,
	nowMs: number,
): SessionPinUsage | undefined {
	if (!sources) return undefined;
	const limits = accountLimits(account, sources, nowMs);
	const health = sources.health;
	const entry = health?.accounts.find(candidate => candidate.credentialId === account.credentialId);
	let verdict: SessionPinUsage | undefined;
	if (entry && entry.state !== "unknown") {
		verdict = { state: entry.state, remainingFraction: entry.remainingFraction, resetsAt: entry.resetsAt };
	} else if (health && !entry && (health.state !== "unknown" || health.accounts.length > 0)) {
		verdict = { state: "ineligible" };
	} else {
		verdict = reportUsage(limits, sources.reserveFraction, nowMs) ?? (entry ? { state: "unknown" } : undefined);
	}
	const windows = limits
		.map(limit => usageWindow(limit, sources.reserveFraction))
		.filter((window): window is SessionPinUsageWindow => window !== undefined);
	const result = windows.length > 0 ? { ...(verdict ?? { state: "unknown" as const }), windows } : verdict;
	if (!result) return undefined;
	const reports = sources.reports?.filter(
		report =>
			report.provider === sources.provider &&
			report.limits.some(limit => limitMatchesActiveAccount(report, limit, account)),
	);
	if (!reports?.length) return result;
	return {
		...result,
		fetchedAt: Math.min(...reports.map(report => report.fetchedAt)),
		stale: reports.some(report => report.metadata?.stale === true),
	};
}

/** Add stable user-facing labels, and the current model's quota when known, to provider account summaries. */
export function toSessionPinAccounts(
	accounts: readonly OAuthAccountSummary[],
	usage?: SessionPinUsageSources,
	nowMs = Date.now(),
): SessionPinAccount[] {
	return accounts.map(account => {
		const enterpriseUrl = account.enterpriseUrl?.trim();
		const pinUsage = accountUsage(account, usage, nowMs);
		return {
			...account,
			label: (formatActiveAccountLabel(account) ?? enterpriseUrl) || `OAuth credential #${account.credentialId}`,
			...(pinUsage ? { usage: pinUsage } : {}),
		};
	});
}

/** Match a `/session pin` selector by 1-based position or exact account identity. */
export function matchSessionPinAccounts(accounts: readonly SessionPinAccount[], selector: string): SessionPinAccount[] {
	const wanted = selector.trim().toLowerCase();
	if (!wanted) return [];
	if (wanted === "active") return accounts.filter(account => account.active);

	if (/^\d+$/.test(wanted)) {
		const position = Number(wanted) - 1;
		const positioned = accounts.find(account => account.position === position);
		if (positioned) return [positioned];
	}

	return accounts.filter(account =>
		[
			account.label,
			account.email,
			account.accountId,
			account.projectId,
			account.enterpriseUrl,
			account.orgId,
			account.orgName,
			`OAuth credential #${account.credentialId}`,
		].some(value => value?.trim().toLowerCase() === wanted),
	);
}
