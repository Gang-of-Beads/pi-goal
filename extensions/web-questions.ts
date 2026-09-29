import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * pi-web's native Questions card for a `ctx.ui.custom` screen.
 *
 * pi-web mirrored the terminal component as a text dump, and the reader had to
 * close it before the native select/input fallback appeared - the same dialog,
 * twice. A host that lists "questions" in `ctx.ui.piWebScreens` draws the
 * declaration below as its Questions card and never mounts the component; the
 * custom call then resolves with the reader's {@link WebAnswers}, or `undefined`
 * when the card closed unanswered. pi ignores the unknown option, so the terminal
 * keeps drawing the component.
 */
export interface WebQuestion {
	id: string;
	question: string;
	detail?: string;
	options: Array<{ value: string; label: string; detail?: string }>;
	custom?: false;
}

export interface WebAnswer {
	id: string;
	values: string[];
	otherText?: string;
}

export interface WebAnswers {
	answers: WebAnswer[];
}

export function hostDrawsQuestions(ctx: ExtensionContext): boolean {
	const screens: unknown = Reflect.get(ctx.ui, "piWebScreens");
	return Array.isArray(screens) && screens.includes("questions");
}

/**
 * The custom call's options: the declaration for a host that draws it, nothing
 * otherwise. Typed loosely because pi's option type predates the key and an object
 * literal would be excess-property checked.
 */
export function questionsOption(ctx: ExtensionContext, title: string, questions: WebQuestion[]): Record<string, unknown> | undefined {
	return hostDrawsQuestions(ctx) ? { web: { kind: "questions", title, questions } } : undefined;
}

/** The reader's answers, when `value` is what the Questions card sent. */
export function readWebAnswers(value: unknown): WebAnswers | undefined {
	if (typeof value !== "object" || value === null || Reflect.has(value, "cancelled")) return undefined;
	const answers: unknown = Reflect.get(value, "answers");
	if (!Array.isArray(answers) || !answers.every(isWebAnswer)) return undefined;
	return { answers };
}

function isWebAnswer(value: unknown): value is WebAnswer {
	if (typeof value !== "object" || value === null) return false;
	const values: unknown = Reflect.get(value, "values");
	const otherText: unknown = Reflect.get(value, "otherText");
	return typeof Reflect.get(value, "id") === "string"
		&& Array.isArray(values) && values.every((entry) => typeof entry === "string")
		&& (otherText === undefined || typeof otherText === "string");
}
