import { beforeAll, describe, expect, it } from "bun:test";
import { Text } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

const ROWS = 12;
const COLUMNS = 60;
const WHEEL_UP = "\x1b[<64;1;1M";
const WHEEL_DOWN = "\x1b[<65;1;1M";

/** SGR mouse report at 0-based screen `row`/`col`; `m` marks a release. */
function sgr(button: number, row: number, col: number, release = false): string {
	return `\x1b[<${button};${col + 1};${row + 1}${release ? "m" : "M"}`;
}

function makeHarness(initialRows: number, render: (row: number) => string = row => `row ${row}`) {
	const terminal = new VirtualTerminal(COLUMNS, ROWS);
	const writes: string[] = [];
	const write = terminal.write.bind(terminal);
	terminal.write = (data: string) => {
		writes.push(data);
		write(data);
	};
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true, fullscreen: true },
	});
	const transcript = new TranscriptContainer();
	// One block holds every row so the transcript has no inter-block spacers.
	let rowCount = initialRows;
	transcript.addChild({ render: () => Array.from({ length: rowCount }, (_, row) => render(row)) });
	composer.setRuntimeChildren([transcript, new Text("EDITOR", 0, 0)]);
	composer.start({ playWelcomeIntro: false });
	const screen = () => terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
	return {
		terminal,
		composer,
		writes,
		screen,
		settle: () => scheduler.settle(terminal),
		/** Stream `count` more transcript rows, as a growing assistant reply would. */
		grow: async (count: number) => {
			rowCount += count;
			composer.ui.requestRender();
			await scheduler.settle(terminal);
		},
		input: async (...data: string[]) => {
			for (const chunk of data) terminal.sendInput(chunk);
			await scheduler.settle(terminal);
		},
	};
}

beforeAll(async () => {
	await initTheme();
});

describe("composer fullscreen main view", () => {
	it("follows the tail while output streams, but holds a scrolled-up view in place", async () => {
		const h = makeHarness(40);
		await h.settle();
		expect(h.screen().at(-1)).toBe("EDITOR");
		expect(h.screen().at(-2)).toBe("row 39");

		await h.grow(5);
		expect(h.screen().at(-2)).toBe("row 44");

		await h.input(WHEEL_UP, WHEEL_UP);
		const top = h.screen()[0];
		expect(top).toBe("row 28");
		expect(h.screen().at(-2)).toContain("↓ 6 more lines");

		// New output lands below the reader instead of dragging the view down.
		await h.grow(10);
		expect(h.screen()[0]).toBe(top);
		expect(h.screen().at(-2)).toContain("↓ 16 more lines");
		expect(h.screen()).not.toContain("row 54");

		h.composer.stop();
	});

	it("re-attaches to the tail once scrolled back to the bottom", async () => {
		const h = makeHarness(40);
		await h.settle();
		await h.input(WHEEL_UP, WHEEL_UP, WHEEL_UP);
		await h.input(WHEEL_DOWN, WHEEL_DOWN, WHEEL_DOWN, WHEEL_DOWN);
		expect(h.screen().at(-2)).toBe("row 39");

		await h.grow(3);
		expect(h.screen().at(-2)).toBe("row 42");
		expect(h.screen().some(row => row.includes("more line"))).toBe(false);

		h.composer.stop();
	});

	it("copies a drag selection as plain text, and a plain click copies nothing", async () => {
		const h = makeHarness(5, row => `\x1b[31mred ${row}\x1b[0m tail ${row}`);
		const copies: string[] = [];
		h.composer.setFullscreenInputHandlers({ copy: text => copies.push(text) });
		await h.settle();
		const first = h.screen().indexOf("red 1 tail 1");
		expect(first).toBeGreaterThanOrEqual(0);

		// Press on "red 1", drag to the "d" of "red 2" on the next row, release.
		await h.input(sgr(0, first, 0), sgr(32, first + 1, 2), sgr(0, first + 1, 2, true));
		expect(copies).toEqual(["red 1 tail 1\nred"]);

		await h.input(sgr(0, first, 4), sgr(0, first, 4, true));
		expect(copies).toHaveLength(1);

		h.composer.stop();
	});

	it("runs on the alternate screen with mouse capture and leaves no transcript behind on stop", async () => {
		const h = makeHarness(40);
		await h.settle();
		const running = h.writes.join("");
		expect(running).toContain("\x1b[?1049h");
		expect(running).toContain("\x1b[?1000h");

		const stopFrom = h.writes.length;
		h.composer.stop();
		const stopping = h.writes.slice(stopFrom).join("");
		expect(stopping).toContain("\x1b[?1000l");
		expect(stopping).toContain("\x1b[?1049l");
		// The normal buffer never received transcript rows: quitting a fullscreen
		// session must not dump the whole conversation into the shell.
		expect(h.terminal.getScrollBuffer().some(row => row.includes("row "))).toBe(false);
	});
});
