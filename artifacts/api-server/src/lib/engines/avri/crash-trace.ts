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
  /** Sprint 13B-2: structural fabrication markers detected against the trace
   * (round function offsets, frame-number gaps, thread-id inconsistency,
   * round heap region size). Each detector is a small independently-testable
   * predicate; ≥2 markers means the trace is internally inconsistent in ways
   * a real sanitizer never produces. */
  structuralMarkers: StructuralMarker[];
  /** Sprint 13B-2: true when ≥2 structural markers fire. The AVRI engine
   * treats this the same as `isStripped` for gold-signal revocation but
   * surfaces a separate STRUCTURAL_FABRICATION indicator + diagnostic. */
  hasStructuralFabrication: boolean;
}

/** A single structural-fabrication tell detected against a crash trace.
 * Sprint 13B-2 ships four detectors keyed by `id` so the diagnostics panel
 * can render exactly which markers fired without re-running the regexes. */
export interface StructuralMarker {
  id:
    | "round_function_offsets"
    | "frame_numbering_gaps"
    | "thread_id_inconsistency"
    | "round_heap_region_size";
  description: string;
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

// Sprint 13B-2 structural detectors -------------------------------------------
//
// Each detector returns a single StructuralMarker (or null). They are kept
// small and side-effect-free so we can unit-test them in isolation and so the
// hallucination detector can call `detectStructuralFabrication()` without
// repeating the trace tokenisation.

/** "Round" or zero function offset, e.g. `func+0x0`, `func+0x100`,
 * `func+0x1000`. Real function offsets are byte distances into a function;
 * they are almost never zero (the first instruction of a prologue) and almost
 * never sit on a 256/4096/65536-byte boundary. We require ≥2 such offsets in
 * frame lines before flagging — a single round offset can show up legitimately
 * (e.g. tail-call to a function start). */
function isRoundFunctionOffset(hex: string): boolean {
  const h = hex.toLowerCase();
  if (h === "0") return true;
  // Two or more trailing zeros AND at least one non-zero leading nybble.
  // Matches "100", "200", "a00", "1000", "10000", ... but NOT "10" (just one
  // trailing zero — far more common in real binaries) or "0".
  return /^[1-9a-f][0-9a-f]*0{2,}$/i.test(h);
}

function detectRoundFunctionOffsets(frameLines: string[]): StructuralMarker | null {
  // Match `name+0xOFFSET` inside frame lines. The capture is the offset hex.
  // We deliberately restrict to frame lines (not the whole text) so prose
  // discussing a bug ("the patch sits at func+0x100") doesn't trigger us.
  const re = /\b\w+\+0x([0-9a-fA-F]+)\b/g;
  const roundOffsets: string[] = [];
  for (const line of frameLines) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      if (isRoundFunctionOffset(m[1])) {
        roundOffsets.push(`0x${m[1]}`);
      }
    }
  }
  if (roundOffsets.length >= 2) {
    return {
      id: "round_function_offsets",
      description: `${roundOffsets.length} frames carry round/zero function offsets (${roundOffsets.slice(0, 4).join(", ")}); real offsets are non-zero and non-round`,
    };
  }
  return null;
}

/** Frame-numbering gaps within a stack block. Real ASan/TSan output is
 * contiguous — `#0, #1, #2, ...` with no gaps. Hand-edited slop traces
 * sometimes skip a number (`#0, #1, #3`). A reset to `#0` is allowed
 * (ASan emits multiple blocks per error: READ, freed-by, allocated-by). */
function detectFrameNumberingGaps(frameLines: string[]): StructuralMarker | null {
  const numRe = /(?:^|[^\w#])(?:#(\d+)|frame\s+(\d+):)/i;
  let prev = -1;
  for (const line of frameLines) {
    const m = line.match(numRe);
    if (!m) continue;
    const n = Number(m[1] ?? m[2]);
    if (!Number.isFinite(n)) continue;
    if (n === 0) {
      prev = 0;
      continue;
    }
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    if (n > prev + 1 && prev >= 0) {
      return {
        id: "frame_numbering_gaps",
        description: `Frame numbering jumps from #${prev} to #${n}; real sanitizer output is contiguous within a block`,
      };
    }
    // n <= prev (and n != 0): treat as a new block reset point so we don't
    // double-flag re-numbered output that was concatenated incorrectly.
    prev = n;
  }
  return null;
}

/** Thread-ID inconsistency: a thread block declares `T0`/`T1`/etc. but the
 * report header carries no `==PID==` tag at all. Real ASan/TSan output always
 * emits `==<pid>==ERROR: ...` ahead of the per-thread blocks; pasting only
 * the thread blocks (or fabricating them outright) produces a thread mention
 * with no PID anchor. */
function detectThreadIdInconsistency(text: string): StructuralMarker | null {
  if (!/\bthread\s+T\d+\b/i.test(text)) return null;
  if (/==\d+==/.test(text)) return null;
  return {
    id: "thread_id_inconsistency",
    description: "Trace references `thread T0`/`T1` but no `==<pid>==` header is present (real ASan/TSan output always anchors thread blocks to a PID)",
  };
}

/** Round-or-hex heap region size. Real ASan formats heap region sizes in
 * decimal with brackets — `8-byte region [0x602000000010,0x602000000018)`.
 * Hand-rolled fabrications often write `region size: 0x100` (256 bytes,
 * suspiciously round, and in hex which ASan never uses). Either tell flags. */
function detectRoundHeapRegionSize(text: string): StructuralMarker | null {
  // 1. Hex region size — wrong format regardless of value.
  const hexM = text.match(/\bregion\s*size\s*:\s*0x([0-9a-fA-F]+)\b/i);
  if (hexM) {
    return {
      id: "round_heap_region_size",
      description: `Heap "region size: 0x${hexM[1]}" in hex; real ASan emits "<N>-byte region [0x..., 0x...)" in decimal`,
    };
  }
  // 2. Decimal region size that lands on an exact 256/4096/65536 boundary
  //    AND lacks the bracketed range. Real allocators round up unpredictably,
  //    so a textbook 256/1024/4096 with no [start,end) is a fabrication tell.
  const decM = text.match(/\bregion\s*size\s*:\s*(\d+)\b(?!\s*\[)/i);
  if (decM) {
    const v = Number(decM[1]);
    if (v > 0 && (v === 256 || v === 1024 || v === 4096 || v === 65536)) {
      return {
        id: "round_heap_region_size",
        description: `Heap "region size: ${v}" is a textbook power-of-two with no bracketed range; real ASan emits "<N>-byte region [0x..., 0x...)"`,
      };
    }
  }
  return null;
}

/** Run all four structural-fabrication detectors and return the markers that
 * fired. Exported so the hallucination detector can hook the same predicates
 * without re-tokenising the trace. */
export function detectStructuralFabrication(text: string): StructuralMarker[] {
  const frameLines = text.match(FRAME_LINES_RE) ?? [];
  const markers: StructuralMarker[] = [];
  const a = detectRoundFunctionOffsets(frameLines);
  if (a) markers.push(a);
  const b = detectFrameNumberingGaps(frameLines);
  if (b) markers.push(b);
  const c = detectThreadIdInconsistency(text);
  if (c) markers.push(c);
  const d = detectRoundHeapRegionSize(text);
  if (d) markers.push(d);
  return markers;
}

export function evaluateCrashTrace(text: string): CrashTraceEvaluation {
  const matches = text.match(FRAME_LINES_RE) ?? [];
  const framesAnalyzed = matches.length;
  const structuralMarkers = detectStructuralFabrication(text);
  const hasStructuralFabrication = structuralMarkers.length >= 2;

  if (framesAnalyzed === 0) {
    return {
      framesAnalyzed: 0,
      goodFrames: 0,
      placeholderFrames: 0,
      isStripped: false,
      reason: null,
      structuralMarkers,
      hasStructuralFabrication,
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

  return {
    framesAnalyzed,
    goodFrames,
    placeholderFrames,
    isStripped,
    reason,
    structuralMarkers,
    hasStructuralFabrication,
  };
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
