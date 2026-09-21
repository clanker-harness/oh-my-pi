import type { Model } from "@oh-my-pi/pi-ai";
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { formatModelString, getModelMatchPreferences, parseModelPattern } from "../config/model-resolver";
import modelMentionDescription from "../prompts/agents/model-mention.md" with { type: "text" };
import { getBundledAgent } from "../task/agents";
import type { AgentDefinition } from "../task/types";
import {
	MODEL_MENTION_RE,
	type ModelMention,
	modelMentionDisplayName,
	modelMentionTag,
} from "@oh-my-pi/pi-tui/prompt/model-mention-syntax";
import type { SessionEntry } from "./session-entries";
import type { SessionManager } from "./session-manager";

/** Journal entry identifying a model the user authorized for delegation. */
export const MODEL_MENTION_ENTRY_TYPE = "model_mention";

/** Replay valid branch entries, keeping the first occurrence of each agent and selector. */
export function readModelMentions(entries: readonly SessionEntry[]): ModelMention[] {
	const mentions: ModelMention[] = [];
	const agents = new Set<string>();
	const selectors = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== MODEL_MENTION_ENTRY_TYPE || !isRecord(entry.data)) continue;
		const { agent, selector, name } = entry.data;
		if (
			typeof agent !== "string" ||
			!/^m\d+$/.test(agent) ||
			typeof selector !== "string" ||
			typeof name !== "string"
		)
			continue;
		if (agents.has(agent) || selectors.has(selector)) continue;
		agents.add(agent);
		selectors.add(selector);
		mentions.push({ agent, selector, name });
	}
	return mentions;
}

/** Session capabilities needed to authorize and persist model mentions. */
export interface ModelMentionHost {
	sessionManager: SessionManager;
	modelRegistry: ModelRegistry;
	scopedModels(): ReadonlyArray<Model>;
	/** Live settings, so fuzzy mention resolution shares the model picker's preference order. */
	settings?(): Settings;
}

/** Owns branch-local pseudonyms for models explicitly tagged by the user. */
export class ModelMentionRegistry {
	readonly #host: ModelMentionHost;
	#mentions: ModelMention[] = [];
	readonly #bySelector = new Map<string, ModelMention>();
	readonly #agents = new Set<string>();
	/** Typed mention token (possibly fuzzy) → the mention its canonical selector resolved to. */
	readonly #byToken = new Map<string, ModelMention>();

	constructor(host: ModelMentionHost) {
		this.#host = host;
	}

	/** Rebuild pseudonyms after resume, rewind, or a session switch. */
	syncFromBranch(): void {
		this.#mentions = readModelMentions(this.#host.sessionManager.getBranch());
		this.#bySelector.clear();
		this.#byToken.clear();
		this.#agents.clear();
		for (const mention of this.#mentions) {
			this.#bySelector.set(mention.selector, mention);
			this.#agents.add(mention.agent);
			this.#byToken.set(mention.selector, mention);
		}
	}

	/** User-authorized model pseudonyms in first-mention order. */
	get mentions(): readonly ModelMention[] {
		return this.#mentions;
	}

	/**
	 * Resolve a mention token within the same model scope as the session
	 * picker, using the picker's own grammar (`parseModelPattern`: exact
	 * `provider/id`, fuzzy ids, `:level` suffixes). Exact-only matching forced
	 * `^anthropic/claude-opus-5` and rejected `^opus`, which is what a user
	 * actually types.
	 */
	findMentionable(selector: string): Model | undefined {
		const scoped = this.#host.scopedModels();
		const models = scoped.length > 0 ? scoped : this.#host.modelRegistry.getAvailable();
		const exact = models.find(model => formatModelString(model) === selector);
		if (exact) return exact;
		// Same preference context the picker and `/switch` use, so an ambiguous
		// token resolves to the provider the user actually works with instead
		// of whichever aggregator happens to sort first.
		return parseModelPattern(selector, models as Model[], getModelMatchPreferences(this.#host.settings?.())).model;
	}

	/** Register user-tagged models and replace their tokens with persisted agent tags. */
	expandMentions(text: string): string {
		if (!text.includes("^")) return text;
		return text.replace(MODEL_MENTION_RE, (token, delimiter: string, typed: string) => {
			let mention = this.#byToken.get(typed);
			if (!mention) {
				const model = this.findMentionable(typed);
				if (!model) return token;
				// Store the canonical selector, not the typed token: downstream
				// model resolution and the authorization check both compare
				// against `formatModelString`, and a fuzzy token would miss.
				const selector = formatModelString(model);
				mention = this.#bySelector.get(selector);
				if (!mention) {
					let next = 1;
					while (this.#agents.has(`m${next}`)) next++;
					mention = { agent: `m${next}`, selector, name: modelMentionDisplayName(model) };
					this.#host.sessionManager.appendCustomEntry(MODEL_MENTION_ENTRY_TYPE, mention);
					this.#mentions.push(mention);
					this.#bySelector.set(selector, mention);
					this.#agents.add(mention.agent);
				}
				this.#byToken.set(typed, mention);
			}
			return `${delimiter}${modelMentionTag(mention)}`;
		});
	}

	/** Expose tagged models as general-purpose task agents without changing the bundled template. */
	sessionAgents(): AgentDefinition[] {
		const task = getBundledAgent("task");
		if (!task) throw new Error("Bundled task agent is unavailable");
		return this.#mentions.map(mention => ({
			...task,
			name: mention.agent,
			description: prompt.render(modelMentionDescription, { name: mention.name, selector: mention.selector }),
			model: [mention.selector],
			filePath: undefined,
		}));
	}
}
