/** Browser runtime: upgrade static figures to interactive ones.
 *
 * Every figure ships working static SVG/HTML; hydration is progressive
 * enhancement. A project's hydrators re-render through the same
 * `renderFigure` pipeline with mutated params — there is exactly one
 * rendering path. Without JavaScript everything is simply visible.
 */

/** Apply re-rendered markup to a live element by patching instead of
 * replacing it. Nodes that did not change survive, so CSS transitions run
 * on the attributes that did, and focus and scroll inside the figure are
 * kept. Children match by position, or by `data-key` when both sides carry
 * one, so a row can appear or disappear without every sibling after it
 * being rebuilt. Attributes are synced exactly; text is replaced when it
 * differs. */
export function patch(target: Element, html: string): void {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  morphChildren(target, tpl.content);
}

const keyOf = (n: Node): string | null => (n.nodeType === 1 ? (n as Element).getAttribute("data-key") : null);
const sameKind = (a: Node, b: Node): boolean =>
  a.nodeType === b.nodeType &&
  (a.nodeType !== 1 || (a as Element).tagName === (b as Element).tagName) &&
  keyOf(a) === keyOf(b);

function morph(have: Node, want: Node): void {
  if (have.nodeType === Node.TEXT_NODE || have.nodeType === Node.COMMENT_NODE) {
    if (have.nodeValue !== want.nodeValue) have.nodeValue = want.nodeValue;
    return;
  }
  if (have.nodeType !== Node.ELEMENT_NODE) return;
  const el = have as Element;
  const w = want as Element;
  for (const attr of Array.from(w.attributes))
    if (el.getAttribute(attr.name) !== attr.value) el.setAttribute(attr.name, attr.value);
  for (const attr of Array.from(el.attributes)) if (!w.hasAttribute(attr.name)) el.removeAttribute(attr.name);
  morphChildren(el, w);
}

function morphChildren(from: Node, to: Node): void {
  const wanted = Array.from(to.childNodes);
  const wantedKeys = new Set(wanted.map(keyOf).filter((k): k is string => k !== null));
  const stillWanted = (n: Node): boolean => {
    const k = keyOf(n);
    return k !== null && wantedKeys.has(k);
  };
  for (let i = 0; i < wanted.length; i++) {
    const want = wanted[i];
    let have: Node | null = from.childNodes[i] ?? null;
    const key = keyOf(want);
    if (have && key !== null && keyOf(have) !== key) {
      // the wanted keyed node may already exist further along: pull it here
      let found: Node | null = null;
      for (let j = i + 1; j < from.childNodes.length; j++)
        if (keyOf(from.childNodes[j]) === key) { found = from.childNodes[j]; break; }
      if (found) {
        from.insertBefore(found, have);
        have = found;
      } else if (stillWanted(have)) {
        // a new keyed node arriving in front of one that stays: insert, keep the old one for its turn
        from.insertBefore(document.importNode(want, true), have);
        continue;
      }
    } else if (have && key === null && stillWanted(have)) {
      from.insertBefore(document.importNode(want, true), have);
      continue;
    }
    if (!have) from.appendChild(document.importNode(want, true));
    else if (sameKind(have, want)) morph(have, want);
    else from.replaceChild(document.importNode(want, true), have);
  }
  while (from.childNodes.length > wanted.length) from.removeChild(from.lastChild!);
}

export function ctlRow(...children: (HTMLElement | string)[]): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "ctl-row";
  for (const c of children) {
    if (typeof c === "string") {
      const span = document.createElement("span");
      span.className = "ctl-label";
      span.textContent = c;
      row.appendChild(span);
    } else row.appendChild(c);
  }
  return row;
}

export function slider(
  min: number,
  max: number,
  step: number,
  value: number,
  oninput: (v: number) => void,
): HTMLInputElement {
  const s = document.createElement("input");
  s.type = "range";
  s.min = String(min);
  s.max = String(max);
  s.step = String(step);
  s.value = String(value);
  s.addEventListener("input", () => oninput(Number(s.value)));
  return s;
}

export function numberInput(value: number, oninput: (v: number) => void): HTMLInputElement {
  const n = document.createElement("input");
  n.type = "number";
  n.className = "ctl-text";
  n.value = String(value);
  n.step = "any";
  n.addEventListener("input", () => {
    const v = Number(n.value);
    if (Number.isFinite(v)) oninput(v);
  });
  return n;
}

/** Preset buttons with an honest active state: `current` derives the
 * selected key from the live spec, so sliding params away from a preset
 * clears the highlight and landing back on one restores it. */
export function presetButtons<T extends string>(
  presets: [T, string][],
  onpick: (key: T) => void,
  current?: () => T | null,
): { el: HTMLSpanElement; refresh(): void } {
  const wrap = document.createElement("span");
  wrap.className = "btn-row";
  const btns = new Map<T, HTMLButtonElement>();
  const refresh = () => {
    const cur = current?.() ?? null;
    for (const [k, b] of btns) b.classList.toggle("active", k === cur);
  };
  for (const [key, label] of presets) {
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = label;
    b.addEventListener("click", () => onpick(key));
    btns.set(key, b);
    wrap.appendChild(b);
  }
  refresh();
  return { el: wrap, refresh };
}

export const valueOut = (): HTMLSpanElement => {
  const span = document.createElement("span");
  span.className = "ctl-value";
  return span;
};

export type Hydrator<Spec extends { kind: string }> = (body: HTMLElement, spec: Spec) => void;

/** Find every figure on the page and hand it to its hydrator. Figures whose
 * kind has no hydrator stay static; a hydrator that throws loses only its
 * own figure. */
export function runHydrators<Spec extends { kind: string }>(
  hydrators: Partial<Record<string, Hydrator<Spec>>>,
): void {
  for (const fig of document.querySelectorAll<HTMLElement>("figure.fig[data-kind]")) {
    const specEl = fig.querySelector("script.fig-spec");
    const body = fig.querySelector<HTMLElement>(".fig-body");
    if (!specEl?.textContent || !body) continue;
    const spec = JSON.parse(specEl.textContent) as Spec;
    const hydrate = hydrators[spec.kind];
    if (!hydrate) continue;
    try {
      hydrate(body, spec);
      fig.classList.add("live");
    } catch (e) {
      console.error(`hydration failed for ${spec.kind}:`, e);
    }
  }
}

/** With JS present, step-by-step walkthroughs (shipped expanded for the PDF
 * and no-JS readers) collapse behind their label. Delegated so figures
 * re-rendered by hydrators keep working. */
export function enableStepsToggle(): void {
  document.body.classList.add("js");
  document.addEventListener("click", (ev) => {
    const label = (ev.target as HTMLElement).closest(".steps-label");
    label?.parentElement?.classList.toggle("open");
  });
}

// ── course runtime: organic disclosure, concept memory, practice ───────
//
// Course pages ship every :::unpack fold open — the no-JS and print
// reader always gets the whole ladder. With JS, every fold closes on
// load: the dense prose reads clean, and one small chevron per fold is
// the whole affordance for going deeper. A concept with a worksheet gets
// a practice entry that takes over the screen — one generated problem at
// a time, graded, with hints — and records the result (localStorage,
// keyed by slug), which a callout then shows on its summary.

import {
  checkAnswer,
  genProblems,
  type PracticeConfig,
  type PracticeProblem,
} from "./practice.js";

export interface CourseOptions {
  /** The same generators the build used — practice entries appear only
   * for worksheets whose slug has one. */
  practice?: PracticeConfig;
}

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode: everything still works, it just forgets */
    }
  },
};

interface PracticeMark {
  best: number;
  total: number;
  rounds: number;
}

const readJson = <T>(key: string, fallback: T): T => {
  try {
    return JSON.parse(store.get(key) ?? "") as T;
  } catch {
    return fallback;
  }
};

export function enableCourse(opts: CourseOptions = {}): void {
  // ── organic folds: dense first, one chevron per step down ──
  for (const d of document.querySelectorAll<HTMLDetailsElement>("details.unpack")) d.open = false;

  // ── practice ──
  const marks = readJson<Record<string, PracticeMark>>("penname:practice", {});
  const saveMarks = () => store.set("penname:practice", JSON.stringify(marks));
  for (const ws of document.querySelectorAll<HTMLElement>("section.worksheet[data-concept]")) {
    const specEl = ws.querySelector("script.ws-spec");
    if (!specEl?.textContent) continue;
    const spec = JSON.parse(specEl.textContent) as { slug: string; seed: number; count: number };
    const gen = opts.practice?.generators[spec.slug];
    if (!gen) continue;
    const section = ws.closest<HTMLElement>("section.concept");
    const title = section?.querySelector(".concept-title")?.textContent ?? spec.slug;
    ws.querySelector(".ws-list")?.remove();
    ws.querySelector(".ws-head")?.remove();
    const entry = document.createElement("div");
    entry.className = "ws-entry";
    const start = document.createElement("button");
    start.className = "btn ws-start";
    start.textContent = `practice · ${spec.count} problems`;
    const mastery = document.createElement("span");
    mastery.className = "ws-mastery";
    const refresh = () => {
      const m = marks[spec.slug];
      mastery.textContent = m ? `best ${m.best}/${m.total} first try · ${m.rounds} ${m.rounds === 1 ? "round" : "rounds"}` : "";
      ws.classList.toggle("practiced", !!m);
    };
    start.addEventListener("click", () =>
      openStudy(title, spec, gen, (score, total) => {
        const m = marks[spec.slug] ?? { best: 0, total, rounds: 0 };
        marks[spec.slug] = { best: Math.max(m.best, score), total, rounds: m.rounds + 1 };
        saveMarks();
        refresh();
        document.dispatchEvent(new Event("penname:practiced"));
      }),
    );
    refresh();
    entry.append(start, mastery);
    ws.appendChild(entry);
  }

  // ── practice reflection on the callouts ──
  // A concept's card carries the reader's best round on its summary, so a
  // collapsed callout still says whether they have been here.
  const badge = (slug: string) => {
    const m = marks[slug];
    return m ? `${m.best}/${m.total}` : "";
  };
  const paintBadges = () => {
    for (const d of document.querySelectorAll<HTMLElement>("details.concept.callout[data-concept]")) {
      const slug = d.dataset.concept!;
      const head = d.querySelector(".concept-head");
      if (!head) continue;
      let el = head.querySelector<HTMLElement>(".concept-mark");
      const text = badge(slug);
      if (!text) {
        el?.remove();
        continue;
      }
      if (!el) {
        el = document.createElement("span");
        el.className = "concept-mark";
        head.appendChild(el);
      }
      el.textContent = `practiced · ${text}`;
      d.classList.add("practiced");
    }
  };
  paintBadges();
  document.addEventListener("penname:practiced", paintBadges);
}

/** The practice session: a dialog over the dimmed page. The reading
 * context stays visible behind a soft scrim while one problem shows at a
 * time — verdict on answer, a hint on the first miss, the answer on
 * request. Round one is the exact sheet printed in the PDF (same seed);
 * later rounds reseed. Esc, the close button, or a click on the scrim
 * returns to the reading position untouched. */
function openStudy(
  title: string,
  spec: { slug: string; seed: number; count: number },
  gen: (rand: () => number, index: number) => PracticeProblem,
  onRound: (firstTry: number, total: number) => void,
): void {
  let round = 0;
  let problems = genProblems(gen, spec.seed, spec.count);

  const overlay = document.createElement("div");
  overlay.className = "study-mode";
  const panel = document.createElement("div");
  panel.className = "study-panel";
  overlay.appendChild(panel);
  overlay.addEventListener("mousedown", (ev) => {
    if (ev.target === overlay) close();
  });

  const el = (cls: string, tag = "div"): HTMLElement => {
    const e = document.createElement(tag);
    e.className = cls;
    return e;
  };
  const btn = (label: string, onClick: () => void, cls = "btn"): HTMLButtonElement => {
    const b = document.createElement("button");
    b.className = cls;
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  };

  const close = () => {
    document.removeEventListener("keydown", onKey);
    document.body.style.overflow = prevOverflow;
    overlay.remove();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") close();
  };
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  document.addEventListener("keydown", onKey);

  const head = el("study-head");
  const headText = el("study-head-text");
  const kicker = el("study-kicker");
  kicker.textContent = "practice";
  const titleEl = el("study-title");
  titleEl.textContent = title;
  headText.append(kicker, titleEl);
  head.append(headText, btn("✕ back to reading", close, "btn study-close"));
  const dots = el("study-dots");
  const card = el("study-card");
  panel.append(head, dots, card);

  let i = 0;
  let firstTry = 0;
  const results: ("right" | "helped" | "shown" | null)[] = [];

  const paintDots = () => {
    dots.innerHTML = "";
    problems.forEach((_, k) => {
      const d = el(`study-dot ${k === i ? "now" : ""} ${results[k] ?? ""}`, "span");
      dots.appendChild(d);
    });
  };

  const showProblem = () => {
    paintDots();
    card.innerHTML = "";
    const p = problems[i];
    let attempts = 0;
    let done = false;
    const prompt = el("study-prompt");
    prompt.innerHTML = p.prompt;
    const answerRow = el("study-answer");
    const feedback = el("study-feedback");
    const actions = el("study-actions");
    card.append(prompt, answerRow, feedback, actions);

    const resolve = (outcome: "right" | "helped" | "shown", message: string) => {
      done = true;
      results[i] = outcome;
      if (outcome === "right") firstTry++;
      feedback.className = `study-feedback ${outcome === "shown" ? "warn" : "ok"}`;
      feedback.innerHTML = message + (p.explain ? `<div class="study-explain">${p.explain}</div>` : "");
      actions.innerHTML = "";
      actions.appendChild(btn(i + 1 < problems.length ? "next →" : "finish", next));
      actions.querySelector("button")?.focus();
      paintDots();
    };
    const miss = () => {
      attempts++;
      feedback.className = "study-feedback bad";
      feedback.innerHTML = `not yet${attempts === 1 && p.hint ? ` — <span class="study-hint">${p.hint}</span>` : ""}`;
      if (attempts >= 2 && !actions.querySelector(".study-show"))
        actions.appendChild(
          btn("show the answer", () => resolve("shown", `the answer: <strong>${answerLabel(p)}</strong>`), "btn study-show"),
        );
    };
    const grade = (raw: string) => {
      if (done) return;
      if (checkAnswer(p.answer, raw))
        resolve(attempts === 0 ? "right" : "helped", attempts === 0 ? "right" : "right — got there");
      else miss();
    };

    if (p.answer.kind === "choice") {
      for (const [k, option] of p.answer.options.entries()) {
        const b = btn(option, () => grade(String(k)), "btn study-choice");
        answerRow.appendChild(b);
      }
    } else {
      const input = document.createElement("input");
      input.className = "ctl-text study-input";
      input.type = "text";
      input.autocomplete = "off";
      if (p.answer.kind === "number" && p.answer.unit) {
        const unit = el("study-unit", "span");
        unit.textContent = p.answer.unit;
        answerRow.append(input, unit);
      } else answerRow.appendChild(input);
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") grade(input.value);
      });
      actions.appendChild(btn("check", () => grade(input.value)));
      input.focus();
    }
  };

  const next = () => {
    i++;
    if (i < problems.length) showProblem();
    else finish();
  };

  const finish = () => {
    onRound(firstTry, problems.length);
    paintDots();
    card.innerHTML = "";
    const summary = el("study-summary");
    summary.textContent = `${firstTry} of ${problems.length} on the first try`;
    const actions = el("study-actions");
    actions.append(
      btn("another round, new problems", () => {
        round++;
        problems = genProblems(gen, spec.seed + round * 7919, spec.count);
        i = 0;
        firstTry = 0;
        results.length = 0;
        showProblem();
      }),
      btn("back to reading", close),
    );
    card.append(summary, actions);
  };

  document.body.appendChild(overlay);
  showProblem();
}

function answerLabel(p: PracticeProblem): string {
  if (p.answer.kind === "number")
    return `${p.answer.value}${p.answer.unit ? ` ${p.answer.unit}` : ""}`;
  if (p.answer.kind === "choice") return p.answer.options[p.answer.correct];
  return p.answer.accept[0];
}

/** Long code listings fold to a teaser with a "show all" button. A
 * listing with a marked region (div.listing) already folds without
 * JavaScript and is left alone. */
export function enableCodeFold(maxLines = 24): void {
  for (const code of document.querySelectorAll("article > pre > code, article pre > code")) {
    const pre = code.parentElement as HTMLPreElement;
    if (pre.closest("figure.fig, .listing")) continue;
    const lines = (code.textContent ?? "").split("\n").length;
    if (lines <= maxLines) continue;
    const wrap = document.createElement("div");
    wrap.className = "code-fold";
    pre.replaceWith(wrap);
    wrap.appendChild(pre);
    const btn = document.createElement("button");
    btn.className = "btn code-fold-btn";
    const setLabel = () =>
      (btn.textContent = wrap.classList.contains("open") ? "collapse listing ▴" : `show all ${lines} lines ▾`);
    btn.addEventListener("click", () => {
      wrap.classList.toggle("open");
      setLabel();
    });
    setLabel();
    wrap.appendChild(btn);
  }
}

// ── floating contents: the reading position, jumps, closing ────────────

/** Switch on the floating contents panel (toc.web: "float"). The section
 * being read is marked in the list and, while the panel is closed, on
 * the tab; a hairline under the head tracks progress through the page;
 * a jump scrolls smoothly, lands focus on the heading, and closes the
 * panel where it floats over the page. Docked (wide screens) it stays
 * put. Without JavaScript the panel is a plain <details> listing the
 * sections; the one-line script the build ships beside it opens it on
 * wide screens and remembers a close. */
export function enableToc(): void {
  const box = document.querySelector<HTMLDetailsElement>("details.toc-float");
  const panel = box?.querySelector<HTMLElement>(".toc-list");
  if (!box || !panel) return;
  const tab = box.querySelector<HTMLElement>(".toc-tab");
  const here = box.querySelector<HTMLElement>(".toc-tab-here");
  const bar = box.querySelector<HTMLElement>(".toc-progress-bar");
  // the CSS picks the geometry per viewport and names it; read that
  // rather than repeating the breakpoints here
  const mode = () => getComputedStyle(box).getPropertyValue("--toc-mode").trim();
  const floating = () => mode() !== "dock";
  const links = Array.from(panel.querySelectorAll<HTMLAnchorElement>("a[href^='#']"));
  const targets = links.map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1))));
  const motion = (): ScrollBehavior => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

  // ── the reading position: the last heading above the reading line ──
  let current: HTMLAnchorElement | null = null;
  /** Scroll the list, never the page, so the current row stays in view. */
  const reveal = () => {
    if (!current || !box.open) return;
    const r = current.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    if (r.top < p.top + 14) panel.scrollBy({ top: r.top - p.top - 14, behavior: motion() });
    else if (r.bottom > p.bottom - 14) panel.scrollBy({ top: r.bottom - p.bottom + 14, behavior: motion() });
  };
  const mark = (next: HTMLAnchorElement | null) => {
    if (next === current) return;
    for (const li of panel.querySelectorAll("li.current, li.within")) li.classList.remove("current", "within");
    current?.removeAttribute("aria-current");
    current = next;
    if (here) here.textContent = "";
    if (!next) return;
    next.setAttribute("aria-current", "location");
    const li = next.closest("li");
    li?.classList.add("current");
    for (let up = li?.parentElement?.closest("li"); up; up = up.parentElement?.closest("li")) up.classList.add("within");
    if (here) here.textContent = next.dataset.num ?? next.querySelector(".toc-text")?.textContent ?? "";
    reveal();
  };
  const spy = () => {
    const doc = document.documentElement;
    const line = Math.min(160, innerHeight / 4);
    // at the very bottom the last sections may never cross the line
    const atEnd = scrollY + innerHeight >= doc.scrollHeight - 2;
    let pick = -1;
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (t && (atEnd || t.getBoundingClientRect().top <= line)) pick = i;
    }
    mark(pick >= 0 ? links[pick] : null);
    if (bar) {
      const room = doc.scrollHeight - innerHeight;
      bar.style.transform = `scaleX(${room > 0 ? Math.min(1, scrollY / room) : 1})`;
    }
  };
  let raf = 0;
  const queue = () => {
    if (!raf)
      raf = requestAnimationFrame(() => {
        raf = 0;
        spy();
      });
  };
  addEventListener("scroll", queue, { passive: true });
  addEventListener("resize", queue);
  document.addEventListener("toggle", queue, true); // a fold opening moves every heading below it
  box.addEventListener("toggle", () => {
    if (box.open) reveal();
  });
  spy();

  // ── jumps ──
  panel.addEventListener("click", (ev) => {
    const a = (ev.target as Element).closest<HTMLAnchorElement>("a[href^='#']");
    const t = a ? targets[links.indexOf(a)] : null;
    if (!a || !t) return;
    ev.preventDefault();
    if (floating()) box.open = false;
    // the top row means the top of the page, whatever sits above the masthead
    if (a.closest("li.toc-top")) scrollTo({ top: 0, behavior: motion() });
    else t.scrollIntoView({ behavior: motion(), block: "start" });
    history.pushState(null, "", a.hash);
    if (!t.hasAttribute("tabindex")) t.tabIndex = -1;
    t.focus({ preventScroll: true });
  });

  // ── closing while it floats: Esc, or a press outside (the sheet's scrim
  // is the box's own pseudo-element, so the box itself counts as outside) ──
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && box.open && floating()) {
      box.open = false;
      tab?.focus();
    }
  });
  document.addEventListener("pointerdown", (ev) => {
    const t = ev.target as Node;
    if (box.open && floating() && (t === box || !box.contains(t))) box.open = false;
  });

  // ── crossing a breakpoint: docked per the remembered choice, floating closed ──
  let was = mode();
  addEventListener("resize", () => {
    const now = mode();
    if (now === was) return;
    was = now;
    box.open = now === "dock" && store.get("penname:toc") !== "closed";
  });
}

// ── section links ───────────────────────────────────────────────────────

/** The "#" after a heading also copies the section's address and says so
 * for a moment. The click still puts the address in the URL bar, so a
 * reader without JavaScript, or without clipboard permission, copies it
 * from there. */
export function enableHeadingLinks(): void {
  document.addEventListener("click", (ev) => {
    const a = (ev.target as Element).closest<HTMLAnchorElement>("a.h-anchor");
    if (!a || !navigator.clipboard) return;
    navigator.clipboard
      .writeText(a.href)
      .then(() => {
        a.dataset.copied = "";
        setTimeout(() => delete a.dataset.copied, 1400);
      })
      .catch(() => {});
  });
}

// ── panel layout: search + the narrow-screen menu ───────────────────────

interface SearchEntry {
  t: string;
  n: string;
  u: string;
  k: string;
  g: string;
  x: string;
}

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Switch on the panel nav: the menu toggle on narrow screens, and search
 * over the build-time index (fetched once, on first focus). Scoring is
 * plain: title hits weigh most, then the gist or blurb, then how often
 * the words occur in the text. */
export function enablePanel(): void {
  const nav = document.querySelector<HTMLElement>("nav.side");
  if (!nav) return;
  const toggle = nav.querySelector<HTMLButtonElement>(".side-toggle");
  toggle?.addEventListener("click", () => {
    const open = document.body.classList.toggle("nav-open");
    toggle.setAttribute("aria-expanded", String(open));
  });
  const input = nav.querySelector<HTMLInputElement>(".side-search-input");
  const results = nav.querySelector<HTMLElement>(".side-results");
  if (!input || !results) return;
  const prefix = input.dataset.prefix ?? "";
  let index: SearchEntry[] | null = null;
  let loading: Promise<void> | null = null;
  const load = () =>
    (loading ??= fetch(input.dataset.index ?? "")
      .then((r) => r.json())
      .then((j: SearchEntry[]) => {
        index = j;
      })
      .catch(() => {
        index = [];
      }));
  const snippet = (e: SearchEntry, words: string[]): string => {
    const lower = e.x.toLowerCase();
    let at = -1;
    for (const w of words) {
      at = lower.indexOf(w);
      if (at >= 0) break;
    }
    if (at < 0) return e.g;
    const from = Math.max(0, at - 60);
    const to = Math.min(e.x.length, at + 90);
    return `${from > 0 ? "…" : ""}${e.x.slice(from, to)}${to < e.x.length ? "…" : ""}`;
  };
  const run = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) {
      results.hidden = true;
      results.innerHTML = "";
      return;
    }
    void load().then(() => {
      const words = q.split(/\s+/).filter(Boolean);
      const scored = (index ?? [])
        .map((e) => {
          let s = 0;
          const t = e.t.toLowerCase();
          const g = e.g.toLowerCase();
          const x = e.x.toLowerCase();
          for (const w of words) {
            if (t.includes(w)) s += 6;
            if (g.includes(w)) s += 3;
            s += Math.min(x.split(w).length - 1, 5);
          }
          return { e, s };
        })
        .filter((r) => r.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 8);
      results.innerHTML = scored.length
        ? scored
            .map(
              ({ e }) =>
                `<a href="${prefix}${e.u}"><span class="sr-kind">${escHtml(e.k)}${e.n ? ` ${escHtml(e.n)}` : ""}</span>` +
                `<span class="sr-title">${escHtml(e.t)}</span><span class="sr-snip">${escHtml(snippet(e, words))}</span></a>`,
            )
            .join("")
        : `<div class="sr-none">nothing found</div>`;
      results.hidden = false;
    });
  };
  let timer: number | null = null;
  input.addEventListener("input", () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(run, 120);
  });
  input.addEventListener("focus", () => void load());
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      input.value = "";
      run();
    } else if (ev.key === "Enter") {
      const first = results.querySelector<HTMLAnchorElement>("a");
      if (first) location.href = first.href;
    }
  });
}

// ── glossary: popovers on annotated terms, and the plain-words swap ─────

interface TermEntry {
  slug: string;
  term: string;
  nickname: string;
  explain: string;
  href: string;
  link: string;
}

/** Keep the original's capitalization on the swapped-in nickname. */
const matchCase = (nick: string, original: string): string =>
  /^[A-Z]/.test(original) && !/^[A-Z]{2,}/.test(original) ? nick.charAt(0).toUpperCase() + nick.slice(1) : nick;

/** Switch on the glossary: click a marked term for its plain description.
 * A book whose entries carry their own words for the terms may also
 * offer a site-wide swap from its nav (remembered in localStorage).
 * Without JavaScript the highlight and the title tooltip are all there
 * is, and the glossary page or section still exists. */
export function enableGlossary(): void {
  const el = document.querySelector("script.glossary");
  const entries = new Map<string, TermEntry>();
  if (el?.textContent) for (const e of JSON.parse(el.textContent) as TermEntry[]) entries.set(e.slug, e);
  const terms = Array.from(document.querySelectorAll<HTMLElement>(".term[data-term]"));
  const toggle = document.querySelector<HTMLInputElement>(".side-plain-toggle");
  if (!terms.length && !toggle) return;
  for (const t of terms) t.removeAttribute("title"); // the popover replaces the tooltip

  const applyPlain = (on: boolean) => {
    document.body.classList.toggle("nicknames", on);
    for (const t of terms) {
      const e = entries.get(t.dataset.term ?? "");
      if (!e?.nickname) continue;
      if (on) {
        if (t.dataset.original == null) t.dataset.original = t.textContent ?? "";
        t.textContent = matchCase(e.nickname, t.dataset.original);
      } else if (t.dataset.original != null) {
        t.textContent = t.dataset.original;
      }
    }
    if (toggle) toggle.checked = on;
  };
  const setPlain = (on: boolean) => {
    store.set("penname:nicknames", on ? "1" : "0");
    applyPlain(on);
    pop?.remove();
    pop = null;
  };
  applyPlain(store.get("penname:nicknames") === "1");
  toggle?.addEventListener("change", () => setPlain(toggle.checked));

  let pop: HTMLElement | null = null;
  const close = () => {
    pop?.remove();
    pop = null;
  };
  const open = (t: HTMLElement) => {
    const e = entries.get(t.dataset.term ?? "");
    if (!e) return;
    close();
    // the term, its plain description, and the way further; the swap
    // stays behind a book's nav toggle and is not offered here
    pop = document.createElement("div");
    pop.className = "term-pop";
    pop.innerHTML =
      `<div class="tp-term">${escHtml(e.term)}</div>` +
      `<p class="tp-explain">${escHtml(e.explain)}</p>` +
      `<div class="tp-actions"><a href="${e.href}">${escHtml(e.link)} →</a></div>`;
    pop.querySelector("a")?.addEventListener("click", close);
    document.body.appendChild(pop);
    const r = t.getBoundingClientRect();
    const width = Math.min(360, window.innerWidth - 24);
    pop.style.width = `${width}px`;
    const left = Math.max(12, Math.min(r.left + window.scrollX, window.scrollX + window.innerWidth - width - 12));
    pop.style.left = `${left}px`;
    pop.style.top = `${r.bottom + window.scrollY + 8}px`;
  };
  document.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const t = target.closest<HTMLElement>(".term[data-term]");
    if (t) {
      ev.preventDefault();
      if (pop && pop.dataset.for === t.dataset.term) return close();
      open(t);
      if (pop) pop.dataset.for = t.dataset.term ?? "";
      return;
    }
    if (pop && !pop.contains(target)) close();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") close();
  });
}
