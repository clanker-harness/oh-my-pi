import { beforeAll, describe, expect, it } from "bun:test";
import { AuthStorage, type UsageReport } from "@oh-my-pi/pi-ai";
import {
	describeSessionPinUsage,
	describeSessionPinUsageWindows,
	SessionAccountSelectorComponent,
	type SessionPinUsageText,
} from "@oh-my-pi/pi-tui/overlays/session-account-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import {
	loadSessionPinUsage,
	toSessionPinAccounts,
} from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/session-pin";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

beforeAll(async () => {
	await initTheme();
});

const accounts = toSessionPinAccounts([
	{ position: 0, credentialId: 11, email: "first@example.com", active: false },
	{ position: 1, credentialId: 12, email: "second@example.com", active: true },
]);

describe("SessionAccountSelectorComponent", () => {
	it("handles navigation, selection, Escape, and Ctrl+C while focused", () => {
		const selected: number[] = [];
		let cancellations = 0;
		const component = new SessionAccountSelectorComponent(
			"Anthropic",
			accounts,
			account => selected.push(account.credentialId),
			() => {
				cancellations += 1;
			},
		);

		component.handleInput("\x1b[A");
		component.handleInput("\n");
		expect(selected).toEqual([11]);

		const escapeComponent = new SessionAccountSelectorComponent(
			"Anthropic",
			accounts,
			() => {},
			() => {
				cancellations += 1;
			},
		);
		escapeComponent.handleInput("\x1b");

		const ctrlCComponent = new SessionAccountSelectorComponent(
			"Anthropic",
			accounts,
			() => {},
			() => {
				cancellations += 1;
			},
		);
		ctrlCComponent.handleInput("\x03");
		expect(cancellations).toBe(2);
	});
});

describe("toSessionPinAccounts usage", () => {
	const summaries = [
		{ position: 0, credentialId: 11, email: "full@example.com", active: true },
		{ position: 1, credentialId: 12, email: "spent@example.com", active: false },
		{ position: 2, credentialId: 13, email: "free-plan@example.com", active: false },
	];

	it("preserves stale snapshot age and marks its percentages as last-known", () => {
		const now = Date.now();
		const [account] = toSessionPinAccounts(
			[summaries[0]!],
			{
				provider: "anthropic",
				reserveFraction: 0.1,
				reports: [
					{
						provider: "anthropic",
						fetchedAt: now - 3_600_000,
						metadata: { email: "full@example.com", stale: true },
						limits: [
							{
								id: "anthropic:5h",
								label: "Claude 5 Hour",
								scope: { provider: "anthropic" },
								amount: { usedFraction: 0.25, unit: "percent" },
							},
						],
					},
				],
			},
			now,
		);
		expect(account!.usage!.fetchedAt).toBe(now - 3_600_000);
		expect(describeSessionPinUsage(account!.usage!, now)).toEqual({
			text: "stale quota · fetched 1h ago",
			color: "warning",
		});
		expect(describeSessionPinUsageWindows(account!.usage!, now)).toEqual([
			{ text: "last known: Claude 5 Hour 75% left", color: "dim" },
		]);
	});

	it("refreshes account windows and router health together instead of reusing cached quota", async () => {
		const authStorage = await AuthStorage.create(":memory:");
		try {
			await authStorage.credentials.set("anthropic", {
				type: "oauth",
				access: "test-access",
				refresh: "test-refresh",
				expires: Date.now() + 3_600_000,
				email: "full@example.com",
			});
			let usedFraction = 0.1;
			authStorage.usage.setProvider("anthropic", {
				id: "anthropic",
				fetchUsage: async () => ({
					provider: "anthropic",
					fetchedAt: Date.now(),
					metadata: { email: "full@example.com" },
					limits: [
						{
							id: "anthropic:5h",
							label: "Claude 5 Hour",
							scope: { provider: "anthropic", windowId: "5h" },
							window: { id: "5h", label: "5 Hour", resetsAt: Date.now() + 3_600_000 },
							amount: { usedFraction, unit: "percent" },
						},
					],
				}),
			});
			await authStorage.usage.reports();
			usedFraction = 1;
			const session = {
				settings: Settings.isolated(),
				modelRegistry: { authStorage } as Parameters<typeof loadSessionPinUsage>[0]["modelRegistry"],
				fetchUsageReports: (signal?: AbortSignal) => authStorage.usage.reports({ signal }),
				getAccountUsage: (provider: string, signal?: AbortSignal) =>
					authStorage.health.model(provider, { signal, reserveFraction: 0 }),
			};
			const usage = await loadSessionPinUsage(session, "anthropic");
			const [account] = toSessionPinAccounts(authStorage.oauth.accounts("anthropic"), usage);
			expect(account!.usage!.state).toBe("depleted");
			expect(account!.usage!.windows?.[0]?.state).toBe("depleted");
			expect(account!.usage!.windows?.[0]?.remainingFraction).toBe(0);
		} finally {
			authStorage.close();
		}
	});
	it("tells accounts with quota from spent and plan-gated ones", () => {
		const now = Date.now();
		const [full, spent, gated] = toSessionPinAccounts(
			summaries,
			{
				provider: "anthropic",
				reserveFraction: 0.1,
				health: {
					state: "healthy",
					accounts: [
						{ credentialId: 11, credentialType: "oauth", state: "healthy", remainingFraction: 0.66 },
						{
							credentialId: 12,
							credentialType: "oauth",
							state: "depleted",
							resetsAt: now + 2 * 3_600_000 + 60_000,
						},
					],
				},
			},
			now,
		);
		expect(describeSessionPinUsage(full!.usage!, now)).toEqual({ text: "66% left", color: "success" });
		expect(describeSessionPinUsage(spent!.usage!, now)).toEqual({
			text: "out of usage · resets in 2h1m",
			color: "error",
		});
		// The health snapshot omits accounts the model's plan gate dropped.
		expect(gated!.usage).toEqual({ state: "ineligible" });
	});

	it("reads quota the router does not gate on off the account's own usage report", () => {
		const now = Date.now();
		const reports = (
			[
				["full@example.com", 0.73],
				["spent@example.com", 1],
			] as const
		).map(([email, usedFraction]): UsageReport => ({
			provider: "anthropic",
			fetchedAt: now,
			metadata: { email },
			limits: [
				{
					id: "anthropic:extra",
					label: "Claude Extra Usage",
					scope: { provider: "anthropic", windowId: "extra" },
					amount: { usedFraction, unit: "usd" },
				},
			],
		}));
		const [full, spent, unreported] = toSessionPinAccounts(
			summaries,
			{
				provider: "anthropic",
				reserveFraction: 0.1,
				health: {
					state: "unknown",
					accounts: summaries.map(({ credentialId }) => ({
						credentialId,
						credentialType: "oauth" as const,
						state: "unknown" as const,
					})),
				},
				reports,
			},
			now,
		);
		// The listed window names the limit, so the verdict drops its source.
		expect(describeSessionPinUsage(full!.usage!, now)).toEqual({ text: "27% left", color: "success" });
		expect(describeSessionPinUsageWindows(full!.usage!, now)).toEqual([
			{ text: "Claude Extra Usage 27% left", color: "dim" },
		]);
		expect(describeSessionPinUsage(spent!.usage!, now)).toEqual({ text: "out of usage", color: "error" });
		expect(describeSessionPinUsageWindows(spent!.usage!, now)).toEqual([
			{ text: "Claude Extra Usage used up", color: "error" },
		]);
		expect(unreported!.usage).toEqual({ state: "unknown" });
	});

	it("lists every window with its own reset, even for accounts with usage left", () => {
		const now = Date.now();
		const hour = 3_600_000;
		const window = (id: string, label: string, usedFraction: number, resetsInMs: number) => ({
			id,
			label,
			scope: { provider: "anthropic" as const },
			window: { id, label, resetsAt: now + resetsInMs },
			amount: { usedFraction, unit: "percent" as const },
		});
		const reports: UsageReport[] = ["full@example.com", "free-plan@example.com"].map(email => ({
			provider: "anthropic",
			fetchedAt: now,
			metadata: { email },
			limits: [
				window("anthropic:5h", "Claude 5 Hour", 0.57, 28 * 60_000),
				window("anthropic:7d", "Claude 7 Day", 0.16, 3 * 24 * hour + 4 * hour),
				window("anthropic:7d:fable", "Claude 7 Day (Fable)", 0.95, 3 * 24 * hour + 4 * hour),
			],
		}));
		const [full, , gated] = toSessionPinAccounts(
			summaries,
			{
				provider: "anthropic",
				reserveFraction: 0.1,
				health: {
					state: "healthy",
					accounts: [{ credentialId: 11, credentialType: "oauth", state: "healthy", remainingFraction: 0.43 }],
				},
				reports,
			},
			now,
		);
		const expected: SessionPinUsageText[] = [
			{ text: "Claude 5 Hour 43% left, resets in 28m", color: "dim" },
			{ text: "Claude 7 Day 84% left, resets in 3d4h", color: "dim" },
			{ text: "Claude 7 Day (Fable) 5% left, resets in 3d4h", color: "warning" },
		];
		expect(describeSessionPinUsage(full!.usage!, now)).toEqual({ text: "43% left", color: "success" });
		expect(describeSessionPinUsageWindows(full!.usage!, now)).toEqual(expected);
		// A plan-gated account still shows when its windows reset.
		expect(gated!.usage?.state).toBe("ineligible");
		expect(describeSessionPinUsageWindows(gated!.usage!, now)).toEqual(expected);

		// The row wraps instead of clipping the later windows' resets.
		const selector = new SessionAccountSelectorComponent(
			"Anthropic",
			[full!],
			() => {},
			() => {},
		);
		// Collapse the box border and wrap indent so the check holds wherever the row wraps.
		const rendered = Bun.stripANSI(selector.render(100).join("\n")).replace(/[│\s]+/g, " ");
		expect(rendered).toContain("Claude 5 Hour 43% left, resets in 28m");
		expect(rendered).toContain("Claude 7 Day (Fable) 5% left, resets in 3d4h");
	});

	it("shows no quota when neither source knows the account", () => {
		const accounts = toSessionPinAccounts(summaries, {
			provider: "anthropic",
			reserveFraction: 0.1,
			health: { state: "unknown", accounts: [] },
		});
		expect(accounts.map(account => account.usage)).toEqual([undefined, undefined, undefined]);
	});
});
