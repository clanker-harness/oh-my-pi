import { beforeAll, describe, expect, it } from "bun:test";
import { Container } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

const ROWS = 14;
const COLUMNS = 40;

/** SGR mouse report at 0-based screen `row`/`col`; `m` marks a release. */
function sgr(button: number, row: number, col: number, release = false): string {
	return `\x1b[<${button};${col + 1};${row + 1}${release ? "m" : "M"}`;
}

/** Press at `from`, drag through to `to`, release there. */
function drag(from: [number, number], to: [number, number]): string[] {
	return [sgr(0, from[0], from[1]), sgr(32, to[0], to[1]), sgr(0, to[0], to[1], true)];
}

/** Fullscreen composer with a short transcript and the real editor mounted the way InteractiveMode mounts it. */
function mountHarness(composerShape: string) {
	const terminal = new VirtualTerminal(COLUMNS, ROWS);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true, fullscreen: true, composerShape },
	});
	const transcript = new TranscriptContainer();
	transcript.addChild({ render: () => ["transcript one", "transcript two"] });
	const editorContainer = new Container();
	editorContainer.addChild(composer.editor);
	composer.setRuntimeChildren([transcript, editorContainer]);
	const copies: string[] = [];
	composer.setFullscreenInputHandlers({ copy: text => copies.push(text) });
	composer.start({ playWelcomeIntro: false });
	const screen = () => terminal.getViewport().map(row => Bun.stripANSI(row));
	/** Screen cell of the first occurrence of `needle`, plus `offset` columns. */
	const cellOf = (needle: string, offset = 0): [number, number] => {
		const rows = screen();
		const row = rows.findIndex(line => line.includes(needle));
		if (row < 0) throw new Error(`"${needle}" not on screen:\n${rows.join("\n")}`);
		return [row, rows[row]!.indexOf(needle) + offset];
	};
	return {
		composer,
		editor: composer.editor,
		copies,
		screen,
		cellOf,
		settle: () => scheduler.settle(terminal),
		input: async (...data: string[]) => {
			for (const chunk of data) terminal.sendInput(chunk);
			await scheduler.settle(terminal);
		},
	};
}

beforeAll(async () => {
	await initTheme();
});

describe.each(["band", "box", "claude"])("fullscreen editor mouse (%s composer)", shape => {
	it("places the cursor where a click lands, so typing inserts there", async () => {
		const h = mountHarness(shape);
		h.editor.setText("alpha beta\ngamma delta");
		await h.settle();

		await h.input(sgr(0, ...h.cellOf("beta")), sgr(0, ...h.cellOf("beta"), true));
		expect(h.editor.getCursor()).toEqual({ line: 0, col: 6 });

		await h.input(sgr(0, ...h.cellOf("delta", 2)), sgr(0, ...h.cellOf("delta", 2), true));
		expect(h.editor.getCursor()).toEqual({ line: 1, col: 8 });
		await h.input("X");
		expect(h.editor.getText()).toBe("alpha beta\ngamma deXlta");
		// A click is not a selection: nothing reaches the clipboard.
		expect(h.copies).toEqual([]);

		h.composer.stop();
	});

	it("clamps a click past the end of a line to the line end", async () => {
		const h = mountHarness(shape);
		h.editor.setText("short\nlonger line");
		await h.settle();

		const [row] = h.cellOf("short");
		await h.input(sgr(0, row, COLUMNS - 3), sgr(0, row, COLUMNS - 3, true));
		expect(h.editor.getCursor()).toEqual({ line: 0, col: 5 });

		h.composer.stop();
	});

	it("copies a drag across lines as the exact buffer text, both end cells included", async () => {
		const h = mountHarness(shape);
		h.editor.setText("alpha beta\ngamma delta");
		await h.settle();

		// "beta" through the "m" of "gamma": the dragged-to cell is part of the copy.
		await h.input(...drag(h.cellOf("beta"), h.cellOf("gamma", 2)));
		expect(h.copies).toEqual(["beta\ngam"]);
		// The cursor follows the drag to its focus end.
		expect(h.editor.getCursor()).toEqual({ line: 1, col: 2 });

		// Dragging backwards selects the same way.
		await h.input(...drag(h.cellOf("delta", 4), h.cellOf("delta")));
		expect(h.copies).toEqual(["beta\ngam", "delta"]);

		h.composer.stop();
	});

	it("keeps body and editor selections exclusive, and Esc drops an editor highlight without reaching the editor", async () => {
		const h = mountHarness(shape);
		let interrupts = 0;
		h.editor.onEscape = () => interrupts++;
		h.editor.setText("alpha beta");
		await h.settle();

		await h.input(...drag(h.cellOf("transcript one"), h.cellOf("transcript one", 9)));
		expect(h.copies).toEqual(["transcript"]);
		await h.input(...drag(h.cellOf("alpha"), h.cellOf("alpha", 4)));
		expect(h.copies).toEqual(["transcript", "alpha"]);
		// The body highlight went away with the editor press; only "alpha" stays reversed.
		expect(h.editor.clearMouseSelection()).toBe(true);
		expect(h.composer.clearFullscreenSelection()).toBe(false);

		await h.input(...drag(h.cellOf("beta"), h.cellOf("beta", 3)));
		await h.input("\x1b");
		expect(h.editor.clearMouseSelection()).toBe(false);
		expect(interrupts).toBe(0);
		// With nothing selected, Esc reaches the editor's interrupt again.
		await h.input("\x1b");
		expect(interrupts).toBe(1);

		h.composer.stop();
	});
});

describe("fullscreen editor mouse with wrapped text", () => {
	it("maps clicks on a soft-wrapped row to that row's segment and copies wrapped text without breaks", async () => {
		const h = mountHarness("band");
		const words = "one two three four five six seven eight nine ten eleven twelve";
		h.editor.setText(words);
		await h.settle();
		const [firstRow] = h.cellOf("one two");
		const [wrappedRow, wrappedCol] = h.cellOf("eleven");
		expect(wrappedRow).toBeGreaterThan(firstRow);

		await h.input(sgr(0, wrappedRow, wrappedCol), sgr(0, wrappedRow, wrappedCol, true));
		expect(h.editor.getCursor()).toEqual({ line: 0, col: words.indexOf("eleven") });

		await h.input(...drag(h.cellOf("one two"), h.cellOf("twelve", 5)));
		expect(h.copies).toEqual([words]);

		h.composer.stop();
	});
});
