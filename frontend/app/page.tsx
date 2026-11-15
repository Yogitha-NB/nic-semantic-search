"use client";

import {
  CSSProperties,
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

/* -------------------------------------------------------------------------- */
/* Types (mirror backend/app/schemas.py)                                       */
/* -------------------------------------------------------------------------- */

interface HierarchyLevel {
  level: string;
  code: string;
  title: string;
}

interface NICResult {
  code: string;
  description: string;
  hierarchy: HierarchyLevel[];
  score: number;
  score_percent: number;
}

interface SearchResponse {
  query: string;
  results: NICResult[];
  explanation: string | null;
  explanation_error: string | null;
  took_ms: number;
}

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(/\/$/, "");
const MIN_QUERY_LENGTH = 3;
const MAX_QUERY_LENGTH = 500;
const RECENT_KEY = "nic-recent-searches";
const MAX_RECENT = 5;

// Example prompts; each chip gets its own hue so the page feels alive.
const EXAMPLES: { text: string; hue: number }[] = [
  { text: "We stitch and export cotton shirts", hue: 340 },
  { text: "Mobile app development for small retailers", hue: 230 },
  { text: "Home-cooked tiffin delivery service", hue: 28 },
  { text: "Rooftop solar panel installation", hue: 160 },
];

// Placeholder text rotates while the box is empty.
const PLACEHOLDERS = [
  "e.g. We manufacture and sell handmade leather bags online",
  "e.g. I run a small dairy farm and sell milk locally",
  "e.g. Freelance graphic design for startups",
  "e.g. Wholesale trading of rice and pulses",
];

// Shown in turn while the search is running.
const LOADING_MESSAGES = [
  "Reading your description...",
  "Searching the NIC 2025 codes...",
  "Ranking the closest matches...",
  "Writing the explanation...",
];

/* -------------------------------------------------------------------------- */
/* Colour helpers: every NIC section (A-V) gets its own hue                    */
/* -------------------------------------------------------------------------- */

const SECTION_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Golden-angle spacing keeps neighbouring sections (A, B, C...) visually distinct. */
function sectionHue(sectionCode: string | undefined, fallback: string): number {
  const idx = sectionCode ? SECTION_LETTERS.indexOf(sectionCode.trim().toUpperCase()) : -1;
  if (idx >= 0) return Math.round((idx * 137.5 + 220) % 360);
  let h = 0;
  for (const ch of fallback) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/** Palette derived from one hue: accent (bars/rings), ink (text), tint (backgrounds), soft (borders). */
function palette(hue: number) {
  return {
    accent: `hsl(${hue} 72% 46%)`,
    ink: `hsl(${hue} 70% 24%)`,
    tint: `hsl(${hue} 90% 96%)`,
    soft: `hsl(${hue} 70% 86%)`,
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Pull a readable message out of a FastAPI error response. */
async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    const detail = body?.detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail) && detail.length > 0) {
      return detail.map((d: { msg?: string }) => d.msg).filter(Boolean).join(" ");
    }
  } catch {
    /* response was not JSON */
  }
  return `The search service returned an error (${res.status}). Please try again.`;
}

/** Copy text to the clipboard, with a fallback for non-secure contexts. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.setAttribute("readonly", "");
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
}

/** Recent searches live in this browser only (localStorage), never on the server. */
function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string").slice(0, MAX_RECENT)
      : [];
  } catch {
    return [];
  }
}

function saveRecent(list: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable (private mode, quota): ignore */
  }
}

/* -------------------------------------------------------------------------- */
/* Small presentational components                                             */
/* -------------------------------------------------------------------------- */

function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function CopyButton({ code, hue }: { code: string; hue: number }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const p = palette(hue);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const handleCopy = async () => {
    if (await copyToClipboard(code)) {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    }
  };

  const style: CSSProperties = copied
    ? { backgroundColor: "#16A34A", borderColor: "#16A34A", color: "#fff" }
    : { backgroundColor: p.tint, borderColor: p.soft, color: p.ink };

  return (
    <button
      type="button"
      onClick={handleCopy}
      style={style}
      aria-label={copied ? `Copied NIC code ${code}` : `Copy NIC code ${code}`}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition hover:brightness-95 active:scale-95 ${
        copied ? "animate-pop" : ""
      }`}
    >
      {copied ? (
        <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" clipRule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 1 1 1.4-1.4l3.8 3.8 6.8-6.8a1 1 0 0 1 1.4 0Z" />
        </svg>
      ) : (
        <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <rect x="7" y="7" width="9" height="10" rx="1.5" />
          <path d="M13 7V4.5A1.5 1.5 0 0 0 11.5 3h-6A1.5 1.5 0 0 0 4 4.5v8A1.5 1.5 0 0 0 5.5 14H7" />
        </svg>
      )}
      {copied ? "Copied" : "Copy code"}
    </button>
  );
}

/** Circular similarity gauge that fills in when the card appears. */
function SimilarityRing({ percent, hue }: { percent: number; hue: number }) {
  const [filled, setFilled] = useState(false);
  const p = palette(hue);
  const radius = 28;
  const circumference = 2 * Math.PI * radius;

  useEffect(() => {
    const id = requestAnimationFrame(() => setFilled(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const offset = filled ? circumference * (1 - Math.min(100, Math.max(0, percent)) / 100) : circumference;

  return (
    <div className="flex shrink-0 flex-col items-center" role="img" aria-label={`Similarity ${percent} percent`}>
      <div className="relative h-[72px] w-[72px]">
        <svg viewBox="0 0 72 72" className="h-full w-full -rotate-90">
          <circle cx="36" cy="36" r={radius} fill="none" stroke={p.soft} strokeWidth="7" />
          <circle
            cx="36"
            cy="36"
            r={radius}
            fill="none"
            stroke={p.accent}
            strokeWidth="7"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            style={{ transition: "stroke-dashoffset 900ms cubic-bezier(0.22, 1, 0.36, 1)" }}
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center font-display text-lg font-semibold tabular-nums" style={{ color: p.ink }}>
          {percent}%
        </span>
      </div>
      <span className="mt-1 text-xs text-ink-soft">similarity</span>
    </div>
  );
}

/** Hierarchy as a stepped, coloured ledger; each level sits one step deeper. */
function HierarchyTrail({ levels, hue, id }: { levels: HierarchyLevel[]; hue: number; id: string }) {
  return (
    <ol
      id={id}
      className="mt-3 space-y-2 border-l-2 pl-4 text-sm"
      style={{ borderColor: palette(hue).soft }}
      aria-label="NIC hierarchy"
    >
      {levels.map((l, i) => {
        const isLast = i === levels.length - 1;
        // Deeper levels get a slightly lighter dot so the path reads broad -> specific.
        const dot = `hsl(${hue} 72% ${34 + i * 7}%)`;
        return (
          <li
            key={`${l.level}-${l.code}-${i}`}
            style={{ marginLeft: `${Math.min(i, 4) * 10}px` }}
            className="relative flex flex-wrap items-baseline gap-x-2"
          >
            <span
              className="absolute -left-[23px] top-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-white"
              style={{ backgroundColor: dot }}
              aria-hidden="true"
            />
            <span className="w-16 shrink-0 text-xs text-ink-faint">{l.level}</span>
            {l.code && (
              <span
                className="rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums"
                style={{ backgroundColor: palette(hue).tint, color: palette(hue).ink }}
              >
                {l.code}
              </span>
            )}
            <span className={isLast ? "font-medium text-ink" : "text-ink-soft"}>{l.title}</span>
          </li>
        );
      })}
    </ol>
  );
}

function ResultCard({ result, rank }: { result: NICResult; rank: number }) {
  const [open, setOpen] = useState(true);
  const section = result.hierarchy.find((l) => l.level === "Section");
  const hue = sectionHue(section?.code, result.code.slice(0, 2));
  const p = palette(hue);
  const trailId = `trail-${result.code}`;

  return (
    <li
      className="group animate-rise rounded-2xl border border-line border-l-[6px] bg-white p-5 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:shadow-lg sm:p-6"
      style={{ borderLeftColor: p.accent, animationDelay: `${rank * 80}ms` }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {rank === 1 && (
              <span className="rounded-full bg-sun px-2.5 py-0.5 text-xs font-semibold text-ink">
                Best match
              </span>
            )}
            {section?.code && (
              <span
                className="rounded-full px-2.5 py-0.5 text-xs font-medium"
                style={{ backgroundColor: p.tint, color: p.ink }}
              >
                Section {section.code}
              </span>
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h3 className="nic-code text-3xl sm:text-4xl" style={{ color: p.ink }}>
              {result.code}
            </h3>
            <CopyButton code={result.code} hue={hue} />
          </div>
        </div>
        <SimilarityRing percent={result.score_percent} hue={hue} />
      </div>

      <p className="mt-4 max-w-prose leading-relaxed text-ink">{result.description}</p>

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={trailId}
        className="mt-4 inline-flex items-center gap-1.5 rounded-md text-sm font-medium transition-colors hover:underline"
        style={{ color: p.ink }}
      >
        <svg
          className={`h-4 w-4 transition-transform ${open ? "rotate-90" : ""}`}
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M7.3 4.3a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4l-5 5a1 1 0 1 1-1.4-1.4L11.6 10 7.3 5.7a1 1 0 0 1 0-1.4Z" />
        </svg>
        {open ? "Hide hierarchy" : "Show hierarchy"}
      </button>

      {open && <HierarchyTrail levels={result.hierarchy} hue={hue} id={trailId} />}
    </li>
  );
}

function ResultsSkeleton({ message }: { message: string }) {
  return (
    <div>
      <p className="mb-4 flex items-center gap-2 text-sm font-medium text-brand-700" role="status">
        <Spinner className="h-4 w-4" />
        <span key={message} className="animate-fade">{message}</span>
      </p>
      <div className="space-y-4" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="animate-pulse rounded-2xl border border-line border-l-[6px] border-l-brand-200 bg-white p-6">
            <div className="h-8 w-36 rounded bg-brand-100" />
            <div className="mt-4 h-3 w-full rounded bg-paper" />
            <div className="mt-2 h-3 w-4/5 rounded bg-paper" />
            <div className="mt-5 h-3 w-1/2 rounded bg-paper" />
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

export default function HomePage() {
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState(5);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  const [messageIdx, setMessageIdx] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const trimmed = query.trim();
  const canSubmit = trimmed.length >= MIN_QUERY_LENGTH && !loading;

  // Load recent searches after mount (localStorage is not available during SSR).
  useEffect(() => setRecent(loadRecent()), []);

  // Rotate the placeholder while the box is empty.
  useEffect(() => {
    if (query !== "") return;
    const id = setInterval(() => setPlaceholderIdx((i) => (i + 1) % PLACEHOLDERS.length), 3500);
    return () => clearInterval(id);
  }, [query]);

  // Cycle the loading message while a search is running.
  useEffect(() => {
    if (!loading) {
      setMessageIdx(0);
      return;
    }
    const id = setInterval(() => setMessageIdx((i) => Math.min(i + 1, LOADING_MESSAGES.length - 1)), 1800);
    return () => clearInterval(id);
  }, [loading]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const rememberSearch = useCallback((text: string) => {
    setRecent((prev) => {
      const next = [text, ...prev.filter((x) => x !== text)].slice(0, MAX_RECENT);
      saveRecent(next);
      return next;
    });
  }, []);

  const clearRecent = () => {
    setRecent([]);
    saveRecent([]);
  };

  const runSearch = useCallback(
    async (text: string) => {
      // Cancel any in-flight request so stale responses never overwrite newer ones.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError(null);

      try {
        const res = await fetch(`${API_URL}/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: text, top_k: topK }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(await readErrorMessage(res));
        setData((await res.json()) as SearchResponse);
        rememberSearch(text);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setData(null);
        setError(
          err instanceof TypeError
            ? `Can't reach the search service at ${API_URL}. Make sure the backend is running.`
            : err instanceof Error
              ? err.message
              : "Something went wrong. Please try again."
        );
      } finally {
        if (abortRef.current === controller) setLoading(false);
      }
    },
    [topK, rememberSearch]
  );

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (canSubmit) void runSearch(trimmed);
  };

  // Ctrl/Cmd + Enter submits from the textarea; plain Enter inserts a new line.
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canSubmit) {
      e.preventDefault();
      void runSearch(trimmed);
    }
  };

  const searchFor = (text: string) => {
    setQuery(text);
    void runSearch(text);
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col px-4 pb-16 pt-6 sm:px-6 sm:pt-10">
      {/* Hero */}
      <header className="relative overflow-hidden rounded-3xl bg-brand-900 px-6 pb-16 pt-10 text-white sm:px-10 sm:pb-20 sm:pt-14">
        {/* Decorative shapes (purely visual) */}
        <div className="pointer-events-none absolute -right-10 -top-12 h-44 w-44 rounded-full bg-coral/90" aria-hidden="true" />
        <div className="pointer-events-none absolute right-24 top-24 h-16 w-16 rounded-full bg-sun" aria-hidden="true" />
        <div className="pointer-events-none absolute -bottom-10 right-1/3 h-28 w-28 rounded-full bg-mint/90" aria-hidden="true" />
        <div className="pointer-events-none absolute -left-8 bottom-6 h-20 w-20 rotate-12 rounded-2xl bg-brand-600" aria-hidden="true" />

        <div className="relative">
          <h1 className="max-w-xl font-display text-3xl font-semibold leading-tight tracking-tight sm:text-5xl">
            Find the NIC 2025 code for your business
          </h1>
          <p className="mt-4 max-w-lg text-brand-100">
            Describe what your business does in plain English. You get the closest official
            codes from India&apos;s National Industrial Classification, with their full hierarchy.
          </p>
        </div>
      </header>

      {/* Search card overlaps the hero */}
      <form
        onSubmit={handleSubmit}
        aria-busy={loading}
        className="relative -mt-10 rounded-2xl border border-line bg-white p-5 shadow-xl shadow-brand-900/10 sm:mx-6 sm:p-6"
      >
        <label htmlFor="query" className="mb-2 block text-sm font-medium">
          What does your business do?
        </label>
        <textarea
          id="query"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          maxLength={MAX_QUERY_LENGTH}
          rows={3}
          placeholder={PLACEHOLDERS[placeholderIdx]}
          className="w-full resize-y rounded-xl border border-line bg-paper/60 px-4 py-3 text-base transition-colors placeholder:text-ink-faint focus:border-brand-600 focus:bg-white"
        />

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-ink-soft">
            <label htmlFor="topk">Results</label>
            <select
              id="topk"
              value={topK}
              onChange={(e) => setTopK(Number(e.target.value))}
              className="rounded-md border border-line bg-white px-2 py-1.5 text-ink"
            >
              {[5, 6, 7].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <span className="ml-2 hidden tabular-nums text-ink-faint sm:inline">
              {query.length}/{MAX_QUERY_LENGTH}
            </span>
          </div>

          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex min-w-[9.5rem] items-center justify-center gap-2 rounded-full bg-coral px-6 py-2.5 font-semibold text-ink shadow-sm transition hover:brightness-95 active:scale-95 disabled:cursor-not-allowed disabled:bg-brand-100 disabled:text-ink-faint disabled:shadow-none"
          >
            {loading ? (<><Spinner /> Searching</>) : "Find codes"}
          </button>
        </div>

        {/* Example chips */}
        <div className="mt-5">
          <p className="mb-2 text-xs text-ink-faint">Try an example</p>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => {
              const p = palette(ex.hue);
              return (
                <button
                  key={ex.text}
                  type="button"
                  onClick={() => searchFor(ex.text)}
                  disabled={loading}
                  style={{ backgroundColor: p.tint, borderColor: p.soft, color: p.ink }}
                  className="rounded-full border px-3 py-1.5 text-sm transition hover:-translate-y-0.5 hover:shadow-md active:scale-95 disabled:opacity-50"
                >
                  {ex.text}
                </button>
              );
            })}
          </div>
        </div>

        {/* Recent searches (stored only in this browser) */}
        {recent.length > 0 && (
          <div className="mt-4 border-t border-line pt-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs text-ink-faint">Recent searches</p>
              <button
                type="button"
                onClick={clearRecent}
                className="rounded text-xs text-ink-faint underline underline-offset-2 hover:text-ink"
              >
                Clear
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {recent.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => searchFor(r)}
                  disabled={loading}
                  title={r}
                  className="max-w-full truncate rounded-full border border-line bg-white px-3 py-1 text-sm text-ink-soft transition hover:border-brand-600 hover:text-brand-700 disabled:opacity-50 sm:max-w-xs"
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
        )}
      </form>

      {/* Results region (announced politely to screen readers) */}
      <section className="mt-10" aria-live="polite">
        {error && (
          <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
            <p className="font-semibold">Search failed</p>
            <p className="mt-1">{error}</p>
            {trimmed.length >= MIN_QUERY_LENGTH && (
              <button
                type="button"
                onClick={() => void runSearch(trimmed)}
                className="mt-3 rounded-full border border-red-300 bg-white px-4 py-1.5 font-medium transition hover:bg-red-100 active:scale-95"
              >
                Try again
              </button>
            )}
          </div>
        )}

        {loading && <ResultsSkeleton message={LOADING_MESSAGES[messageIdx]} />}

        {!loading && data && (
          <div className="space-y-6">
            {/* LLM explanation */}
            {data.explanation && (
              <div className="animate-rise rounded-2xl border border-sun/60 bg-gradient-to-br from-amber-50 via-white to-brand-50 p-5 sm:p-6">
                <div className="flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-sun text-ink" aria-hidden="true">
                    <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                      <path d="M10 1.5l1.9 4.9 4.9 1.9-4.9 1.9L10 15.1l-1.9-4.9L3.2 8.3l4.9-1.9L10 1.5Zm6 10l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1Z" />
                    </svg>
                  </span>
                  <h2 className="font-display text-lg font-semibold text-brand-900">Why these codes</h2>
                </div>
                <p className="mt-3 max-w-prose whitespace-pre-line leading-relaxed text-ink">
                  {data.explanation}
                </p>
              </div>
            )}
            {!data.explanation && data.explanation_error && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                {data.explanation_error}
              </div>
            )}

            {/* Result cards */}
            {data.results.length > 0 ? (
              <div>
                <div className="mb-3 flex items-baseline justify-between">
                  <h2 className="font-display text-xl font-semibold">
                    {data.results.length} closest codes
                  </h2>
                  <p className="text-sm tabular-nums text-ink-faint">{(data.took_ms / 1000).toFixed(1)}s</p>
                </div>
                <ul className="space-y-4">
                  {data.results.map((r, i) => (
                    <ResultCard key={r.code} result={r} rank={i + 1} />
                  ))}
                </ul>
              </div>
            ) : (
              <div className="rounded-2xl border border-line bg-white p-6 text-ink-soft">
                No codes were found. Add more detail about what you make, sell or provide, then search again.
              </div>
            )}
          </div>
        )}
      </section>

      <footer className="mt-auto pt-12 text-sm text-ink-faint">
        Matches come from the official NIC 2025 published by MoSPI. Before you file, confirm your
        code on the{" "}
        <a
          href="https://nicfinder.mospi.gov.in/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-brand-700"
        >
          MoSPI NIC finder
        </a>
        .
      </footer>
    </main>
  );
}
