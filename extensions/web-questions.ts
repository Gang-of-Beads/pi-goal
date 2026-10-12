import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * pi-web's native interactive card for a `ctx.ui.custom` screen.
 *
 * pi-web mirrored the terminal component as a text dump, and the reader had to
 * close it before the native select/input fallback appeared - the same dialog,
 * twice. A host that lists "card" in `ctx.ui.piWebScreens` draws the declaration
 * below (`web: { kind: "card", fields }`, each question a choice field, or a typed
 * field when it has no options) and never mounts the component; the custom call
 * then resolves with the card's values keyed by field id, read back here as
 * {@link WebAnswers}, or `undefined` when the card closed unanswered. pi ignores
 * the unknown option, so the terminal keeps drawing the component.
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
	return Array.isArray(screens) && screens.includes("card");
}

/** One question as a field of pi-web's card: a choice with a Custom option unless it takes no typed answer, or a typed field when it offers no options. */
function cardField(question: WebQuestion): Record<string, unknown> {
	const described = question.detail === undefined ? {} : { detail: question.detail };
	if (question.options.length === 0) return { type: "input", id: question.id, label: question.question, multiline: true, ...described };
	return {
		type: "choice",
		id: question.id,
		label: question.question,
		...described,
		options: question.options,
		...(question.custom === false ? {} : { other: "choice" }),
	};
}

/**
 * The custom call's options: the declaration for a host that draws it, nothing
 * otherwise. Typed loosely because pi's option type predates the key and an object
 * literal would be excess-property checked.
 *
 * For a host that draws the card, the card is the whole dialog (the owner's rule,
 * reported again on 2026-10-12): pi-web draws the terminal frame for a declaration it
 * refuses, so the questions are fitted to the card first, and a set that cannot be
 * fitted is never shown at all ({@link questionsRefusal}; the caller stops first).
 */
export function questionsOption(ctx: ExtensionContext, title: string, questions: WebQuestion[]): Record<string, unknown> | undefined {
	if (!hostDrawsQuestions(ctx)) return undefined;
	const fitted = fitQuestions(questions);
	return "refused" in fitted ? undefined : { web: { kind: "card", title, fields: fitted.questions.map(cardField) } };
}

/** Why a host that draws the card cannot be shown these questions, or nothing when it can (or draws no card). */
export function questionsRefusal(ctx: ExtensionContext, questions: WebQuestion[]): string | undefined {
	if (!hostDrawsQuestions(ctx)) return undefined;
	const fitted = fitQuestions(questions);
	return "refused" in fitted ? fitted.refused : undefined;
}

function cut(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The questions brought inside the card's bounds, or why they cannot be. A question too
 * long for its line moves whole into the detail, ahead of the context; a detail or an
 * option text past its bound is cut with an ellipsis. Too many questions or options, or a
 * blank question, cannot be fitted without losing what was asked.
 */
function fitQuestions(questions: readonly WebQuestion[]): { questions: WebQuestion[] } | { refused: string } {
	if (questions.length > LIMITS.questions) return { refused: `${questions.length} questions; pi-web's card takes at most ${LIMITS.questions}` };
	const crowded = questions.find((question) => question.options.length > LIMITS.options);
	if (crowded !== undefined) return { refused: `"${cut(crowded.question, 80)}" has ${crowded.options.length} options; pi-web's card takes at most ${LIMITS.options}` };
	const fitted = questions.map((question) => {
		const long = question.question.length > LIMITS.text;
		const detail = long ? [question.question, question.detail].filter(Boolean).join("\n\n") : question.detail;
		return {
			...question,
			question: cut(question.question, LIMITS.text),
			...(detail === undefined ? {} : { detail: cut(detail, LIMITS.detail) }),
			options: question.options.map((option) => ({
				...option,
				label: cut(option.label, LIMITS.text),
				...(option.detail === undefined ? {} : { detail: cut(option.detail, LIMITS.text) }),
			})),
		};
	});
	return fitsQuestionsCard(fitted) ? { questions: fitted } : { refused: "a question or an option is blank, or two share an id" };
}

/** pi-web's limits for a declared question (its daemon's `declaredScreen`). */
const LIMITS = { questions: 20, options: 12, id: 128, text: 1_000, detail: 32_000 };

export function fitsQuestionsCard(questions: readonly WebQuestion[]): boolean {
	const fits = (text: string, max: number): boolean => text.trim() !== "" && text.length <= max;
	const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;
	return questions.length > 0 && questions.length <= LIMITS.questions && unique(questions.map((question) => question.id)) && questions.every((question) =>
		fits(question.id, LIMITS.id)
		&& fits(question.question, LIMITS.text)
		&& (question.detail === undefined || fits(question.detail, LIMITS.detail))
		&& question.options.length <= LIMITS.options
		&& unique(question.options.map((option) => option.value))
		&& question.options.every((option) => fits(option.value, LIMITS.id) && fits(option.label, LIMITS.text) && (option.detail === undefined || fits(option.detail, LIMITS.text))));
}

/** The reader's answers, when `value` is what the card sent: `{ values: { [id]: { selected, other? } | { text } } }`. */
export function readWebAnswers(value: unknown): WebAnswers | undefined {
	if (typeof value !== "object" || value === null || Reflect.has(value, "cancelled")) return undefined;
	const values: unknown = Reflect.get(value, "values");
	if (typeof values !== "object" || values === null || Array.isArray(values)) return undefined;
	const answers = Object.entries(values).map(([id, entry]) => webAnswer(id, entry));
	return answers.every((answer): answer is WebAnswer => answer !== undefined) ? { answers } : undefined;
}

function webAnswer(id: string, entry: unknown): WebAnswer | undefined {
	if (typeof entry !== "object" || entry === null) return undefined;
	const text: unknown = Reflect.get(entry, "text");
	if (typeof text === "string") return { id, values: [], otherText: text };
	const selected: unknown = Reflect.get(entry, "selected");
	const other: unknown = Reflect.get(entry, "other");
	if (!Array.isArray(selected) || !selected.every((pick) => typeof pick === "string")) return undefined;
	if (other !== undefined && typeof other !== "string") return undefined;
	return { id, values: selected, ...(other === undefined ? {} : { otherText: other }) };
}
