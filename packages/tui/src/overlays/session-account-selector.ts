import type { ModelUsageHealthState } from "@oh-my-pi/pi-ai";
import { formatDuration } from "@oh-my-pi/pi-utils";
import type { TspTone } from "@oh-my-pi/pi-wire";
import { type SelectItem, SelectList, type SgrMouseEvent } from "../index";
import { getSelectListTheme, type ThemeColor, theme } from "../theme/theme";
import { OverlayPanel } from "../chrome/overlay-box";
import { routeSelectListMouseWithTopBorder } from "../chrome/select-list-mouse-routing";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { SelectListSheet } from "../native/picker";

/** Visual row budget: account rows wrap their per-window quota onto extra rows. */
const ACCOUNT_SELECTOR_MAX_ROWS = 16;

/** One quota window an account reports (e.g. Claude's 5-hour or weekly limit) and when it resets. */
export interface SessionPinUsageWindow {
	/** Limit title, e.g. "Claude 5 Hour" or "Claude 7 Day (Fable)". */
	label: string;
	state: Exclude<ModelUsageHealthState, "unknown">;
	/** Remaining fraction (0..1), when the provider reports how much is used. */
	remainingFraction?: number;
	/** Epoch ms of the window's next reset, when known. */
	resetsAt?: number;
	/** Verb before the countdown; rolling windows tick or regen rather than reset. Defaults to "resets". */
	resetLabel?: string;
}

/**
 * Quota verdict for one account and the current model: the account router's
 * when it has one, else read off the account's own usage reports.
 * `ineligible` marks an account whose plan cannot serve the model.
 */
export interface SessionPinUsage {
	state: ModelUsageHealthState | "ineligible";
	/** Remaining fraction (0..1) of the account's tightest quota. */
	remainingFraction?: number;
	/** Epoch ms when a depleted account can serve again, when known. */
	resetsAt?: number;
	/** Limit the verdict was read from, when it is not the router's own (e.g. "Claude Extra Usage"). */
	source?: string;
	/** Every quota window the account reports, each with its own reset. */
	windows?: readonly SessionPinUsageWindow[];
	/** Original snapshot time, retained when a refresh falls back to old quota. */
	fetchedAt?: number;
	/** A refresh failed and the quota is last-known rather than current. */
	stale?: boolean;
}

type SessionPinUsageColor = Extract<ThemeColor, "success" | "warning" | "error" | "dim">;

/** One piece of an account's quota line and the color it reads in. */
export interface SessionPinUsageText {
	text: string;
	color: SessionPinUsageColor;
}

const USAGE_TONE: Record<SessionPinUsageColor, TspTone> = {
	success: "success",
	warning: "warning",
	error: "error",
	dim: "muted",
};

const MINUTE_MS = 60_000;

/** `<verb> in 2h1m` until a future reset, rounded up to the minute; undefined once it has passed. */
function formatResetIn(resetsAt: number | undefined, nowMs: number, verb = "resets"): string | undefined {
	if (resetsAt === undefined || resetsAt <= nowMs) return undefined;
	return `${verb} in ${formatDuration(Math.ceil((resetsAt - nowMs) / MINUTE_MS) * MINUTE_MS)}`;
}

/** One-line quota summary of a `/session pin` account and the color it reads in. */
export function describeSessionPinUsage(usage: SessionPinUsage, nowMs = Date.now()): SessionPinUsageText {
	const age =
		usage.fetchedAt === undefined ? "" : ` · fetched ${formatDuration(Math.max(0, nowMs - usage.fetchedAt))} ago`;
	if (usage.stale) return { text: `stale quota${age}`, color: "warning" };
	if (usage.fetchedAt !== undefined && nowMs - usage.fetchedAt > 90_000) {
		const summary = describeSessionPinUsage({ ...usage, fetchedAt: undefined }, nowMs);
		return { ...summary, text: `${summary.text}${age}` };
	}
	// Listed windows already name the limit the verdict was read from.
	const source = usage.source && !usage.windows?.length ? ` (${usage.source})` : "";
	const left =
		usage.remainingFraction === undefined ? undefined : `${Math.round(usage.remainingFraction * 100)}% left${source}`;
	switch (usage.state) {
		case "healthy":
			return { text: left ?? "has usage", color: "success" };
		case "reserve":
			return { text: left ? `low · ${left}` : "low", color: "warning" };
		case "depleted": {
			const reset = formatResetIn(usage.resetsAt, nowMs);
			return { text: `out of usage${source}${reset ? ` · ${reset}` : ""}`, color: "error" };
		}
		case "ineligible":
			return { text: "plan can't use this model", color: "dim" };
		case "unknown":
			return { text: "usage unknown", color: "dim" };
	}
}

/** Per-window quota of a `/session pin` account: what each window has left and when it resets. */
export function describeSessionPinUsageWindows(usage: SessionPinUsage, nowMs = Date.now()): SessionPinUsageText[] {
	return (usage.windows ?? []).map(window => {
		const left =
			window.state === "depleted"
				? "used up"
				: window.remainingFraction === undefined
					? undefined
					: `${Math.round(window.remainingFraction * 100)}% left`;
		const reset = formatResetIn(window.resetsAt, nowMs, window.resetLabel);
		const facts = [left, reset].filter((fact): fact is string => fact !== undefined).join(", ");
		return {
			text: `${usage.stale ? "last known: " : ""}${facts ? `${window.label} ${facts}` : window.label}`,
			color: usage.stale
				? "dim"
				: window.state === "depleted"
					? "error"
					: window.state === "reserve"
						? "warning"
						: "dim",
		};
	});
}

/** Stored account identity rendered and matched by the session account picker. */
export interface SessionPinAccount {
	position: number;
	credentialId: number;
	accountId?: string;
	email?: string;
	projectId?: string;
	enterpriseUrl?: string;
	orgId?: string;
	orgName?: string;
	active: boolean;
	label: string;
	/** Quota for the current model; absent when usage could not be looked up. */
	usage?: SessionPinUsage;
}

/**
 * The ANSI row description: quota first, then the session marker. Each part
 * carries its own color because the list's muted description style does not
 * survive an embedded color's reset.
 */
function accountDescription(account: SessionPinAccount): string | undefined {
	const parts: string[] = [];
	if (account.usage) {
		for (const part of [describeSessionPinUsage(account.usage), ...describeSessionPinUsageWindows(account.usage)]) {
			parts.push(theme.fg(part.color, part.text));
		}
	}
	if (account.active) parts.push(theme.fg("muted", "active for this session"));
	return parts.length > 0 ? parts.join(theme.fg("muted", " · ")) : undefined;
}

/** What tells two accounts of one provider apart besides their label: the organization, project or host. */
function accountDetail(account: SessionPinAccount): string | undefined {
	const parts = [account.orgName ?? account.orgId, account.projectId, account.enterpriseUrl].filter(
		(part): part is string => typeof part === "string" && part.trim().length > 0 && !account.label.includes(part),
	);
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Values of the action rows; credential ids are numeric, so these never collide with an account. */
const ADD_ACCOUNT = "add-account";
const SIGN_OUT = "sign-out";

/** Primary action label for the selected row. */
const CONFIRM_LABELS: Record<string, string> = { [ADD_ACCOUNT]: "Sign in", [SIGN_OUT]: "Sign out" };

/** Action rows listed under the accounts; each appears only when its handler is given. */
export interface SessionAccountActions {
	/** Sign in to another account (or workspace) of the provider. */
	onAddAccount?: () => void;
	/** Choose a stored account to sign out. */
	onSignOut?: () => void;
}

/**
 * Account manager for one provider, opened by `/login <provider>` and
 * `/session pin`: use a stored account for this session, sign in to another
 * one, or sign one out.
 */
export class SessionAccountSelectorComponent extends OverlayPanel {
	#selectList: SelectList;
	#sheet: SelectListSheet;

	constructor(
		providerName: string,
		accounts: readonly SessionPinAccount[],
		onSelect: (account: SessionPinAccount) => void,
		onCancel: () => void,
		actions: SessionAccountActions = {},
	) {
		super(`${providerName} accounts`, "omp.overlay.session-account");
		const accountsByValue = new Map<string, SessionPinAccount>();
		const items: SelectItem[] = accounts.map(account => {
			const value = String(account.credentialId);
			accountsByValue.set(value, account);
			return {
				value,
				label: account.label,
				description: accountDescription(account),
			};
		});
		if (actions.onAddAccount) {
			items.push({
				value: ADD_ACCOUNT,
				label: "Add another account",
				icon: theme.cmd.plus,
				iconName: "plus",
				description: "sign in with a different email or workspace",
			});
		}
		if (actions.onSignOut) {
			items.push({
				value: SIGN_OUT,
				label: "Sign out an account…",
				icon: theme.cmd.signOut,
				iconName: "signOut",
				description: "remove a stored login",
			});
		}

		// Rows carry a quota description; size the label column to the widest
		// `email (org)` rather than the default 32 columns, which clips it, and
		// wrap the per-window quota under the description column.
		this.#selectList = new SelectList(items, ACCOUNT_SELECTOR_MAX_ROWS, getSelectListTheme(), {
			minPrimaryColumnWidth: 24,
			maxPrimaryColumnWidth: 64,
			wrapDescription: true,
			maxDescriptionRows: 3,
		});
		const activeIndex = accounts.findIndex(account => account.active);
		if (activeIndex >= 0) this.#selectList.setSelectedIndex(activeIndex);
		this.#selectList.onSelect = item => {
			if (item.value === ADD_ACCOUNT) actions.onAddAccount?.();
			else if (item.value === SIGN_OUT) actions.onSignOut?.();
			else {
				const account = accountsByValue.get(item.value);
				if (account) onSelect(account);
			}
		};
		this.#selectList.onCancel = onCancel;
		this.addChild(this.#selectList);
		// Natively the active account carries the picker's current check, so the
		// row's detail is what tells accounts apart instead of "active for this session":
		// its org plus each quota window's reset. The verdict rides as a toned badge.
		const current = accounts.filter(account => account.active).map(account => String(account.credentialId));
		this.#sheet = new SelectListSheet(this.#selectList, () => ({
			title: `${providerName} accounts`,
			subtitle: "Choose the account this session sends its requests with",
			icon: "key-round",
			noun: "accounts",
			current,
			confirm: CONFIRM_LABELS[this.#selectList.pickerView().selected ?? ""] ?? "Use",
			decorate: item => {
				if (item.value === ADD_ACCOUNT) return { icon: "plus" };
				if (item.value === SIGN_OUT) return { icon: "log-out" };
				const account = accountsByValue.get(item.value);
				if (!account) return undefined;
				const usage = account.usage ? describeSessionPinUsage(account.usage) : undefined;
				const windows = account.usage ? describeSessionPinUsageWindows(account.usage) : [];
				const detail = [accountDetail(account), ...windows.map(window => window.text)]
					.filter((part): part is string => part !== undefined)
					.join(" · ");
				return {
					mark: { text: account.email ?? account.label, seed: account.label },
					detail,
					...(usage ? { badges: [{ text: usage.text, tone: USAGE_TONE[usage.color] }] } : {}),
				};
			},
		}));
	}

	override describe(cx: DescribeContext): NativeNode | null {
		return cx.supports("picker") ? this.#sheet.describe() : super.describe(cx);
	}

	/** Picker pointer events drive the list exactly as its keys do. */
	handleNativeEvent(event: NativeUiEvent): void {
		this.#sheet.handle(event);
	}

	/** Forward keyboard navigation and cancellation when the wrapper owns focus. */
	handleInput(keyData: string): void {
		this.#selectList.handleInput(keyData);
	}

	/** Route mouse selection through the title rows into the account list. */
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeSelectListMouseWithTopBorder(this.#selectList, event, line, col);
	}
}
