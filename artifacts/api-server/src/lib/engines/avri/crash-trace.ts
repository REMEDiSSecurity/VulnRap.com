// Sprint 11 — shared crash-trace validator.
//
// Sanitizer / debugger / Valgrind / "memcheck"-style stack traces are the
// strongest single piece of evidence for a MEMORY_CORRUPTION report. They
// also happen to be one of the easiest things for an AI-slop author to
// fake: paste a plausible header, list a few "frame N:" lines, and the
// gold-signal regex fires. This validator inspects the actual frames and
// flags the trace as "stripped" (low value) when the frames carry no
// resolvable symbol, no source file:line, or are filled with placeholder
// tokens like "<symbol stripped>" or "+0xZZZZ".
//
// A legitimate sanitizer trace virtually always carries either a real
// symbol (e.g. `mozilla::webgpu::CommandEncoder::Finalize()`) or a source
// path with line number (e.g. `parser/parse.c:418`) on most frames. A
// stripped trace from a slop report has neither.

export interface CrashTraceEvaluation {
  /** Number of frame-style lines detected in the text. */
  framesAnalyzed: number;
  /** Frames that carry a real symbol or source location AND no placeholder. */
  goodFrames: number;
  /** Frames containing a placeholder token (e.g. "<symbol stripped>"). */
  placeholderFrames: number;
  /** True iff the trace looks stripped/placeholder enough to discount. */
  isStripped: boolean;
  /** Human-readable explanation, set when isStripped. */
  reason: string | null;
}

// Frame-line shapes we recognize:
//   #0 0x... in foo_bar(...) src/file.c:42        (ASAN/Valgrind)
//   ==12345==    #1 0x... in foo_bar src/file.c:42 (ASAN with prefix)
//   frame 0: <symbol stripped> in libserver        (debugger/memcheck-style)
//   [memcheck] frame 0: ...                        (custom analyzer prefix)
const FRAME_LINES_RE =
  /^[ \t>|]*(?:\[[^\]\n]+\]\s*)?(?:==\d+==\s*)?(?:#\d+|frame\s+\d+:)\s+\S.*$/gim;

const PLACEHOLDER_TOKENS: RegExp[] = [
  /<\s*symbol\s+stripped\s*>/i,
  /<\s*no\s+symbol\s*>/i,
  /<\s*stripped\s*>/i,
  /<\s*unknown\s*>/i,
  /\?\?\s*\(\?\?:\s*0\s*\)/, // glibc backtrace_symbols "??(??:0)"
  /\bunknown\s+function\b/i,
  // Hex literal with a non-hex letter (G–Z) or "?", e.g. 0xZZZZ, 0xXXXX.
  /\b0x[0-9A-Fa-f?]*[G-Zg-z?][0-9A-Fa-f?G-Zg-z]*\b/,
];

// Source location: a recognizable code-file extension, optionally followed
// by ":<line>". This is what makes a frame actionable.
const SOURCE_LOCATION_RE =
  /[\w\-./]+\.(?:c|h|cc|cpp|cxx|hpp|m|mm|rs|go|java|kt|swift|py|js|ts|php|rb|cs)\b(?::\d+)?/i;

// A "real" symbol token: an identifier that looks like a function name
// (ends with `(` or `_`), or a namespaced/qualified symbol (contains `::`
// or starts with a `mod::` style prefix). We deliberately exclude common
// connector words ("in", "at", "from", "by") and library-tag-only tokens
// like "libserver" so a frame that names *only* a shared object doesn't
// count as resolved.
const SYMBOL_TOKEN_RES: RegExp[] = [
  /\b[A-Za-z_][A-Za-z0-9_]{1,}\s*\(/, // foo(, foo_bar(
  /\b[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_:]*/, // ns::Class::method
  /\b__[A-Za-z_][A-Za-z0-9_]+\b/, // __interceptor_free, __asan_memcpy
];

function looksLikeRealSymbol(line: string): boolean {
  return SYMBOL_TOKEN_RES.some((re) => re.test(line));
}

function hasPlaceholder(line: string): boolean {
  return PLACEHOLDER_TOKENS.some((re) => re.test(line));
}

export function evaluateCrashTrace(text: string): CrashTraceEvaluation {
  const matches = text.match(FRAME_LINES_RE) ?? [];
  const framesAnalyzed = matches.length;
  if (framesAnalyzed === 0) {
    return {
      framesAnalyzed: 0,
      goodFrames: 0,
      placeholderFrames: 0,
      isStripped: false,
      reason: null,
    };
  }

  let goodFrames = 0;
  let placeholderFrames = 0;
  for (const line of matches) {
    if (hasPlaceholder(line)) {
      placeholderFrames++;
      continue;
    }
    if (SOURCE_LOCATION_RE.test(line) || looksLikeRealSymbol(line)) {
      goodFrames++;
    }
  }

  // A trace must have at least 3 frames before we judge it. With ≥3
  // frames, fewer than 40% "good" frames marks it as stripped/slop. We
  // also fire when the majority of frames carry an explicit placeholder
  // token, even if the absolute "good" count is borderline.
  const isStripped =
    framesAnalyzed >= 3 &&
    (goodFrames / framesAnalyzed < 0.4 ||
      placeholderFrames >= Math.ceil(framesAnalyzed / 2));

  let reason: string | null = null;
  if (isStripped) {
    if (placeholderFrames >= Math.ceil(framesAnalyzed / 2)) {
      reason = `Crash trace has ${placeholderFrames}/${framesAnalyzed} frames with placeholder symbols/offsets`;
    } else {
      reason = `Crash trace has ${framesAnalyzed - goodFrames}/${framesAnalyzed} frames with no resolvable symbol or source location`;
    }
  }

  return { framesAnalyzed, goodFrames, placeholderFrames, isStripped, reason };
}

/** Per-family map of gold-signal IDs whose value depends entirely on a
 * tool-emitted crash/race trace being legitimate. When a trace is
 * stripped/placeholder, points awarded for these signals must be revoked.
 *
 * MEMORY_CORRUPTION: ASAN/Valgrind sanitizer traces and the generic
 *   "stack trace with offset" pattern can all be faked by pasting a
 *   plausible header followed by `<symbol stripped>` frames.
 * RACE_CONCURRENCY: ThreadSanitizer / Helgrind / DRD output uses the
 *   same `#N 0x... in ...` frame shape as ASAN, and is just as easy to
 *   fake. The TSan/Helgrind gold signal must therefore also depend on
 *   the trace surviving the stripped-frame validator.
 *
 * Other families (e.g. REQUEST_SMUGGLING) rely on raw protocol bytes
 * rather than tool-emitted frames; they have no entries here and the
 * validator is not run for them.
 */
export const CRASH_TRACE_GOLD_SIGNAL_IDS_BY_FAMILY: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  MEMORY_CORRUPTION: new Set([
    "asan_or_sanitizer",
    "valgrind",
    "stack_trace_with_offset",
  ]),
  RACE_CONCURRENCY: new Set([
    "tsan_or_helgrind",
  ]),
};

/** Returns the set of gold-signal IDs to revoke for the given family when
 * the crash/race trace is stripped, or null if the family does not rely
 * on a tool-emitted trace. */
export function crashTraceGoldSignalIdsFor(
  familyId: string,
): ReadonlySet<string> | null {
  return CRASH_TRACE_GOLD_SIGNAL_IDS_BY_FAMILY[familyId] ?? null;
}

/** @deprecated Kept for backwards compatibility with callers that only
 * cared about MEMORY_CORRUPTION. Prefer `crashTraceGoldSignalIdsFor()`. */
export const CRASH_TRACE_GOLD_SIGNAL_IDS: ReadonlySet<string> =
  CRASH_TRACE_GOLD_SIGNAL_IDS_BY_FAMILY.MEMORY_CORRUPTION;
