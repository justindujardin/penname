/** Practice problems: the shared half of the worksheet system.
 *
 * A concept unit can carry a problem generator (registered by the consumer
 * under the concept's slug). The build calls it to render a printable
 * worksheet into the concept card and an answer-key appendix into the PDF;
 * the browser runtime calls the same generator with the same seed to run
 * an interactive, graded session. Both sides must agree on every problem,
 * so generators stay in integer/short-decimal arithmetic — the seeded
 * stream below is bit-exact across JS engines, and nothing here touches
 * Math.exp or friends.
 *
 * This module is browser-safe: no Node imports, no DOM at module scope.
 */

export type PracticeAnswer =
  | { kind: "number"; value: number; tolerance?: number; unit?: string }
  | { kind: "choice"; options: string[]; correct: number }
  | { kind: "text"; accept: string[] };

export interface PracticeProblem {
  /** Plain HTML (no markdown, no $math$ — it renders verbatim in both the
   * static worksheet and the study session). */
  prompt: string;
  answer: PracticeAnswer;
  /** Shown after the first miss. */
  hint?: string;
  /** Shown once the problem is resolved, right or revealed. */
  explain?: string;
}

/** One problem, deterministically, from a seeded stream and its position
 * in the sheet. Generators vary their numbers with `rand` and can vary
 * their form with `index`. */
export type PracticeGenerator = (rand: () => number, index: number) => PracticeProblem;

export interface PracticeConfig {
  /** Concept slug -> generator. A concept with no entry gets no worksheet. */
  generators: Record<string, PracticeGenerator>;
  /** Problems per worksheet (default 4). */
  count?: number;
  /** Base seed mixed into every worksheet's slug hash (default 1). */
  seed?: number;
}

/** The same LCG on both sides of the build: integer ops only. */
export function practiceRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A worksheet's seed is a pure function of its concept slug and the
 * project's base seed, so the printed sheet, the answer key, and the
 * browser session all describe the same problems. */
export function worksheetSeed(slug: string, base: number): number {
  let h = 2166136261 ^ base;
  for (let i = 0; i < slug.length; i++) h = ((h ^ slug.charCodeAt(i)) * 16777619) >>> 0;
  return h >>> 0;
}

export function genProblems(gen: PracticeGenerator, seed: number, count: number): PracticeProblem[] {
  const rand = practiceRng(seed);
  return Array.from({ length: count }, (_, i) => gen(rand, i));
}

/** Grade a raw reader answer. Choice answers grade by option index. */
export function checkAnswer(answer: PracticeAnswer, raw: string): boolean {
  if (answer.kind === "number") {
    const v = Number(raw.replace(",", ".").trim());
    if (!Number.isFinite(v)) return false;
    return Math.abs(v - answer.value) <= (answer.tolerance ?? 1e-6);
  }
  if (answer.kind === "choice") return Number(raw) === answer.correct;
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  return answer.accept.some((a) => norm(a) === norm(raw));
}

/** The answer, as the printed key states it. */
export function answerText(answer: PracticeAnswer): string {
  if (answer.kind === "number") {
    const v = Number.isInteger(answer.value) ? String(answer.value) : String(Math.round(answer.value * 1e6) / 1e6);
    return answer.unit ? `${v} ${answer.unit}` : v;
  }
  if (answer.kind === "choice") return answer.options[answer.correct];
  return answer.accept[0];
}
