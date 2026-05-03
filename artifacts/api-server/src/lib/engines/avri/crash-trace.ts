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
 * Sprint 13B-2 ships four shape detectors (the first four IDs below),
 * Sprint 13B-2 / Task #303 adds three bounds detectors (the next three),
 * and Task #316 adds two more shape detectors aimed at the report sections
 * that LLMs most often pad — register dumps and memory-map listings — so
 * the diagnostics panel can render exactly which markers fired without
 * re-running the regexes. */
export interface StructuralMarker {
  id:
    | "round_function_offsets"
    | "frame_numbering_gaps"
    | "thread_id_inconsistency"
    | "round_heap_region_size"
    // Task #303: bounds checks on the same trace fields. Whereas the four
    // shape detectors above flag suspiciously round/missing values, these
    // three flag values that look plausible at a glance but violate the
    // structural envelope a real sanitizer respects.
    | "implausible_function_offset"
    | "implausible_thread_id"
    | "region_size_vs_access_size"
    // Task #316: shape checks against two report sections LLMs commonly
    // fabricate alongside the stack — x86/x64 register dumps with values
    // that are textbook-round or repeated across registers, and
    // /proc/self/maps listings whose ranges overlap, are zero-size, sit
    // below the Linux mmap_min_addr, or are not 4 KiB page-aligned.
    | "fabricated_register_state"
    | "fabricated_memory_map"
    // Task #434: shape check against the ASan "Shadow bytes around the
    // buggy address" section — the single most-faked artifact in
    // AI-generated MEMORY_CORRUPTION reports. Real ASan emits rows of
    // exactly 16 hex byte pairs, marks the buggy-address row with `=>`,
    // and prints a multi-line legend (Addressable: 00, Heap left
    // redzone: fa, Freed heap region: fd, …). A fabricated block
    // routinely picks the wrong row width, omits the `=>` marker, or
    // skips the legend entirely.
    | "malformed_shadow_bytes"
    // Task #608: semantic check on the same ASan "Shadow bytes around the
    // buggy address" section — the buggy byte enclosed in `[ ]` on the
    // `=>` row must match the bug class declared in the
    // `ERROR: AddressSanitizer: <bug-class>` header. Real ASan tags the
    // buggy byte with the shadow value matching the bug class
    // (heap-use-after-free → fd, heap-buffer-overflow → fa/fb/01-07,
    // stack-buffer-overflow → f1/f2/f3, …). LLM fabrications routinely
    // paint the buggy row with a value picked at random from the legend
    // without consulting the header. Task #434's structural detector
    // catches wrong row width / missing `=>` / absent legend; this one
    // closes the residual gap where the *shape* checks all pass but the
    // grid pattern *contradicts* the declared bug class.
    | "shadow_byte_class_mismatch"
    // Task #433: ≥3 distinct thread IDs appear across the role-tagged
    // anchors of a single ASan/TSan trace (the "READ/WRITE thread T<x>"
    // block header, "freed by thread T<y>", "previously allocated by
    // thread T<z>"). The Sprint 13B-2 `thread_id_inconsistency` detector
    // already catches a `thread T<n>` mention with no `==<pid>==` header;
    // this one catches the inverse — a header is present but the body's
    // thread IDs disagree with each other across roles, which real
    // sanitizer output never does (the same thread typically dominates,
    // and the IDs cluster in a small range).
    | "thread_id_mismatch"
    // Task #455: shape check against `/proc/self/status` excerpts (the
    // `VmPeak` / `VmSize` / `VmRSS` block). Real kernels emit
    // pseudo-random page-aligned kB counts (e.g. `VmRSS: 4232 kB`); LLM
    // fabrications routinely pick textbook power-of-two kB values
    // (`VmRSS: 1024 kB`, `VmSize: 65536 kB`) across multiple Vm fields.
    // The `fabricated_register_state` marker is also extended in this
    // task to recognise ARM64 (X0..X30, W0..W30, PSTATE) and RISC-V
    // (x0..x31) register names so non-x86 fabricated dumps are caught
    // by the same predicate rather than slipping through entirely.
    | "fabricated_proc_status";
  description: string;
  /** Task #451: location of the offending excerpt inside the original
   * report text, so the diagnostics panel can make each marker bullet
   * clickable and the report-text panel can scroll to the exact line that
   * tripped the detector. `start`/`end` are character offsets into the
   * `text` argument that was passed to `detectStructuralFabrication`;
   * `line` is the 1-based line number containing `start`. Optional so
   * legacy persisted reports analyzed before this field shipped continue
   * to render normally. */
  range?: { start: number; end: number; line: number };
}

/** A frame line tagged with its position in the original text. The frame
 * detectors (round offsets, numbering gaps, implausible offsets) need to
 * know not just the line content but where that content lives in the
 * source so they can attach a `range` to the marker they emit. */
interface FrameLine {
  /** Raw frame line content (matches `FRAME_LINES_RE`). */
  text: string;
  /** Character offset of the first character of `text` in the original
   * input string passed to `detectStructuralFabrication`. */
  start: number;
  /** 1-based line number of `start` in the original input string. */
  line: number;
}

/** Count newlines preceding `index` to produce the 1-based line number of
 * the character at `index`. Cheap O(index) walk — fine for the trace-
 * length inputs we evaluate (≤50 KiB after `sanitizeForAnalysis`). */
function lineNumberAt(text: string, index: number): number {
  let line = 1;
  const cap = Math.min(index, text.length);
  for (let i = 0; i < cap; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

function rangeAt(
  text: string,
  start: number,
  length: number,
): { start: number; end: number; line: number } {
  const safeStart = Math.max(0, Math.min(start, text.length));
  const safeEnd = Math.max(
    safeStart,
    Math.min(safeStart + length, text.length),
  );
  return {
    start: safeStart,
    end: safeEnd,
    line: lineNumberAt(text, safeStart),
  };
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

function detectRoundFunctionOffsets(
  frames: FrameLine[],
  text: string,
): StructuralMarker | null {
  // Match `name+0xOFFSET` inside frame lines. The capture is the offset hex.
  // We deliberately restrict to frame lines (not the whole text) so prose
  // discussing a bug ("the patch sits at func+0x100") doesn't trigger us.
  const re = /\b\w+\+0x([0-9a-fA-F]+)\b/g;
  const roundOffsets: string[] = [];
  let firstHit: FrameLine | null = null;
  for (const f of frames) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(f.text)) !== null) {
      if (isRoundFunctionOffset(m[1])) {
        roundOffsets.push(`0x${m[1]}`);
        if (!firstHit) firstHit = f;
      }
    }
  }
  if (roundOffsets.length >= 2 && firstHit) {
    return {
      id: "round_function_offsets",
      description: `${roundOffsets.length} frames carry round/zero function offsets (${roundOffsets.slice(0, 4).join(", ")}); real offsets are non-zero and non-round`,
      range: rangeAt(text, firstHit.start, firstHit.text.length),
    };
  }
  return null;
}

/** Frame-numbering gaps within a stack block. Real ASan/TSan output is
 * contiguous — `#0, #1, #2, ...` with no gaps. Hand-edited slop traces
 * sometimes skip a number (`#0, #1, #3`). A reset to `#0` is allowed
 * (ASan emits multiple blocks per error: READ, freed-by, allocated-by). */
function detectFrameNumberingGaps(
  frames: FrameLine[],
  text: string,
): StructuralMarker | null {
  const numRe = /(?:^|[^\w#])(?:#(\d+)|frame\s+(\d+):)/i;
  let prev = -1;
  for (const f of frames) {
    const m = f.text.match(numRe);
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
        range: rangeAt(text, f.start, f.text.length),
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
  const m = /\bthread\s+T\d+\b/i.exec(text);
  if (!m) return null;
  if (/==\d+==/.test(text)) return null;
  return {
    id: "thread_id_inconsistency",
    description:
      "Trace references `thread T0`/`T1` but no `==<pid>==` header is present (real ASan/TSan output always anchors thread blocks to a PID)",
    range: rangeAt(text, m.index, m[0].length),
  };
}

/** Round-or-hex heap region size. Real ASan formats heap region sizes in
 * decimal with brackets — `8-byte region [0x602000000010,0x602000000018)`.
 * Hand-rolled fabrications often write `region size: 0x100` (256 bytes,
 * suspiciously round, and in hex which ASan never uses). Either tell flags. */
function detectRoundHeapRegionSize(text: string): StructuralMarker | null {
  // 1. Hex region size — wrong format regardless of value.
  const hexRe = /\bregion\s*size\s*:\s*0x([0-9a-fA-F]+)\b/i;
  const hexM = hexRe.exec(text);
  if (hexM) {
    return {
      id: "round_heap_region_size",
      description: `Heap "region size: 0x${hexM[1]}" in hex; real ASan emits "<N>-byte region [0x..., 0x...)" in decimal`,
      range: rangeAt(text, hexM.index, hexM[0].length),
    };
  }
  // 2. Decimal region size that lands on an exact 256/4096/65536 boundary
  //    AND lacks the bracketed range. Real allocators round up unpredictably,
  //    so a textbook 256/1024/4096 with no [start,end) is a fabrication tell.
  const decRe = /\bregion\s*size\s*:\s*(\d+)\b(?!\s*\[)/i;
  const decM = decRe.exec(text);
  if (decM) {
    const v = Number(decM[1]);
    if (v > 0 && (v === 256 || v === 1024 || v === 4096 || v === 65536)) {
      return {
        id: "round_heap_region_size",
        description: `Heap "region size: ${v}" is a textbook power-of-two with no bracketed range; real ASan emits "<N>-byte region [0x..., 0x...)"`,
        range: rangeAt(text, decM.index, decM[0].length),
      };
    }
  }
  return null;
}

// Task #303 bounds detectors -------------------------------------------------
//
// The Sprint 13B-2 shape detectors above catch traces that pick suspiciously
// round/missing values. These three bounds detectors catch traces whose
// values *look* plausible but violate the structural envelope sanitizers
// respect — implausibly small/large function offsets, thread/PID identifiers
// outside the realistic sanitizer ranges, and heap region sizes that can't
// possibly satisfy the access-size header.

/** Implausible function offsets in `in <symbol>+0x<offset>` frame fragments.
 * Real ASan offsets are byte distances into the live function — they are
 * almost never inside the prologue (offsets 1..3) and almost never imply a
 * function larger than 1 MiB (offset ≥ 0x100000). The 1 MiB bound is set
 * deliberately above the typical "huge" function (kernel `main`,
 * `nghttp2_session_mem_recv`, …) so a real fat function never trips it.
 *
 * The match is restricted to `in <symbol>+0x...` fragments so binary-relative
 * offsets like `(curl+0x4abf1a)` or `(server+0x4f2a31)` — which legitimately
 * run into the multi-megabyte range — are NOT considered. */
const IN_FN_OFFSET_RE = /\bin\s+([A-Za-z_][\w:]*)\+0x([0-9a-fA-F]+)\b/g;
const TINY_OFFSET_MAX = 0x4; // exclusive — values 0x1, 0x2, 0x3 sit in the prologue
const HUGE_OFFSET_MIN = 0x100000; // inclusive — implies a 1 MiB+ function

function detectImplausibleFunctionOffsets(
  frames: FrameLine[],
  text: string,
): StructuralMarker | null {
  const tells: string[] = [];
  let firstHit: FrameLine | null = null;
  for (const f of frames) {
    IN_FN_OFFSET_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IN_FN_OFFSET_RE.exec(f.text)) !== null) {
      const fn = m[1];
      const offsetHex = m[2];
      const value = parseInt(offsetHex, 16);
      if (!Number.isFinite(value)) continue;
      if (value > 0 && value < TINY_OFFSET_MAX) {
        tells.push(`${fn}+0x${offsetHex} (in prologue)`);
        if (!firstHit) firstHit = f;
      } else if (value >= HUGE_OFFSET_MIN) {
        tells.push(`${fn}+0x${offsetHex} (implies ≥1 MiB function)`);
        if (!firstHit) firstHit = f;
      }
    }
  }
  if (tells.length >= 2 && firstHit) {
    return {
      id: "implausible_function_offset",
      description: `${tells.length} frames carry function offsets outside realistic bounds (${tells.slice(0, 3).join(", ")}); real offsets sit between the prologue and the function epilogue`,
      range: rangeAt(text, firstHit.start, firstHit.text.length),
    };
  }
  return null;
}

/** Implausible thread/PID identifiers anchored to the report header
 * (`==<pid>==`) and the per-thread blocks (`thread T<n>`). On Linux PIDs
 * range 1..4_194_304; sanitizer thread IDs start at T0 and rarely climb
 * past T64 (T1024 is already a wildly threaded process). Values outside
 * those envelopes don't appear in any real sanitizer output we've seen. */
const PID_RE = /==(\d+)==/g;
const THREAD_T_RE = /\bthread\s+T(\d+)\b/gi;
const LINUX_PID_MAX = 4_194_304;
const PLAUSIBLE_THREAD_MAX = 1024;

function detectImplausibleThreadIds(text: string): StructuralMarker | null {
  // PID side: 0 or > LINUX_PID_MAX is impossible on Linux.
  PID_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PID_RE.exec(text)) !== null) {
    const pid = Number(m[1]);
    if (!Number.isFinite(pid)) continue;
    if (pid === 0 || pid > LINUX_PID_MAX) {
      return {
        id: "implausible_thread_id",
        description: `PID ${pid} in \`==${m[1]}==\` header is outside the realistic Linux PID range (1..${LINUX_PID_MAX})`,
        range: rangeAt(text, m.index, m[0].length),
      };
    }
  }
  // Thread side: T<n> with n > PLAUSIBLE_THREAD_MAX.
  THREAD_T_RE.lastIndex = 0;
  while ((m = THREAD_T_RE.exec(text)) !== null) {
    const n = Number(m[1]);
    if (!Number.isFinite(n)) continue;
    if (n > PLAUSIBLE_THREAD_MAX) {
      return {
        id: "implausible_thread_id",
        description: `Thread \`T${n}\` is outside the realistic sanitizer thread-id range (T0..T${PLAUSIBLE_THREAD_MAX}); real reports rarely climb past a couple of dozen`,
        range: rangeAt(text, m.index, m[0].length),
      };
    }
  }
  return null;
}

/** Heap region size compared against the access-size header. Real ASan
 * reports never claim a 0-byte allocated region, and for non-overflow bug
 * classes (heap-use-after-free, double-free) the access size must fit
 * inside the chunk that was originally allocated — `READ of size 8` on a
 * `2-byte region` is structurally impossible. Buffer-overflow classes
 * legitimately report access > region (that's the bug), so they're
 * excluded from the access-vs-region comparison; the 0-byte check still
 * applies to them. */
const ACCESS_SIZE_RE = /(?:READ|WRITE)\s+of\s+size\s+(\d+)/i;
const REGION_BRACKETED_RE = /\b(\d+)-byte\s+region\s*\[/i;
const REGION_DECIMAL_RE = /\bregion\s*size\s*:\s*(\d+)\b(?!\s*\[)/i;
const OVERFLOW_BUG_RE =
  /(?:heap[-\s]buffer[-\s]overflow|stack[-\s]buffer[-\s]overflow|global[-\s]buffer[-\s]overflow|heap[-\s]buffer[-\s]underflow|heap\s+overflow|stack\s+overflow)/i;
const NON_OVERFLOW_BUG_RE =
  /(?:heap[-\s]use[-\s]after[-\s]free|use[-\s]after[-\s]free|double[-\s]free|use[-\s]after[-\s]return|use[-\s]after[-\s]scope)/i;

function detectRegionSizeVsAccessSize(text: string): StructuralMarker | null {
  let regionSize: number | null = null;
  let regionMatch: RegExpExecArray | null = null;
  const bracketRe = new RegExp(
    REGION_BRACKETED_RE.source,
    REGION_BRACKETED_RE.flags,
  );
  const bracketM = bracketRe.exec(text);
  if (bracketM) {
    regionSize = Number(bracketM[1]);
    regionMatch = bracketM;
  } else {
    const decRe = new RegExp(REGION_DECIMAL_RE.source, REGION_DECIMAL_RE.flags);
    const decM = decRe.exec(text);
    if (decM) {
      regionSize = Number(decM[1]);
      regionMatch = decM;
    }
  }
  if (regionSize === null || !Number.isFinite(regionSize) || !regionMatch)
    return null;

  if (regionSize === 0) {
    return {
      id: "region_size_vs_access_size",
      description:
        "Heap region size is reported as 0 bytes; real allocations are non-zero",
      range: rangeAt(text, regionMatch.index, regionMatch[0].length),
    };
  }

  const accessRe = new RegExp(ACCESS_SIZE_RE.source, ACCESS_SIZE_RE.flags);
  const accessM = accessRe.exec(text);
  if (!accessM) return null;
  const accessSize = Number(accessM[1]);
  if (!Number.isFinite(accessSize) || accessSize <= 0) return null;

  // Buffer-overflow bugs legitimately read past the region; skip them.
  if (OVERFLOW_BUG_RE.test(text) && !NON_OVERFLOW_BUG_RE.test(text))
    return null;
  // Only enforce the comparison when the bug class is one where the access
  // is supposed to fit inside the originally-allocated chunk (UAF / DF).
  if (!NON_OVERFLOW_BUG_RE.test(text)) return null;

  if (accessSize > regionSize) {
    return {
      id: "region_size_vs_access_size",
      description: `Access size ${accessSize} exceeds the reported ${regionSize}-byte region for a use-after-free / double-free; the access on a freed chunk fits inside the original allocation`,
      // Anchor on the access-size header — it is the more specific claim
      // the report makes ("READ of size N") and points reviewers at the
      // bug class declaration line rather than the heap metadata footer.
      range: rangeAt(text, accessM.index, accessM[0].length),
    };
  }
  return null;
}

// Task #316 register-dump and memory-map detectors -----------------------
//
// LLMs that pad a fabricated crash report with "supporting evidence" almost
// always reach for two more sections beyond the stack frames: a register
// dump (RAX/RBX/...) and a /proc/self/maps memory listing. Real values for
// both look pseudo-random — actual ASLR addresses, mixed page offsets,
// non-overlapping ascending mappings — but a fabrication tends to land on
// textbook-round register values and zero/overlapping/impossibly-low map
// ranges. These two detectors catch those patterns.

// x86 / x86-64 / ARM64 / RISC-V general-purpose register names. Matches
// `RAX: 0x...`, `rax = 0x...`, `RAX 0x...`, `EIP=0x...`, `X0: 0x...`,
// `x10 = 0x...`, `W3: 0x...`, `PSTATE: 0x...` and the lowercase variants.
// The optional `:`/`=`/whitespace separator covers the most common dump
// shapes (gdb `info registers`, sigaction handler `ucontext_t` print,
// ASan/HWASan abort banner). RFLAGS / EFLAGS / PSTATE are included so a
// fab dump that pads the status word too counts toward the entry total.
//
// Task #455 extends this from x86-only to also accept the ARM64 X0..X30 /
// W0..W30 register file (with PSTATE) and the RISC-V x0..x31 register
// file. The case-insensitive `[XW]` covers ARM64 X/W and RISC-V x in one
// alternative; the digit subgroup `(?:[0-9]|[12][0-9]|3[01])` includes
// 31 for RISC-V (ARM64 maxes out at 30, so X31 simply never appears in
// real ARM64 traces). This is the cheapest way to make the existing
// `detectFabricatedRegisterState` predicate fire on the ARM64 / RISC-V
// dumps LLMs reach for when fabricating non-x86 crash reports.
const REGISTER_DUMP_RE =
  /\b(R[ABCD]X|R[SD]I|R[BS]P|R(?:8|9|1[0-5])|RIP|RFLAGS|E[ABCD]X|E[SD]I|E[BS]P|EIP|EFLAGS|[XW](?:[0-9]|[12][0-9]|3[01])|PSTATE)\b\s*[:=]?\s*0x([0-9a-fA-F]+)\b/gi;

/** A register value is "suspiciously round" when it sits on a 16-bit
 * (≥3 trailing hex zeros) page boundary AND is short enough that it cannot
 * be a realistic ASLR pointer (≤6 hex digits — i.e. < 0x1_000000 = 16 MiB).
 * Real register dumps include some page-aligned 12-digit pointers (mmap'd
 * regions, code segments, stack pointers); those are NOT short and so do
 * not trip this predicate. Single small constants (0, 0xff, errno-sized
 * values) are also excluded so a `RAX: 0x0` after a syscall is fine. */
function isSuspiciousRegisterValue(hex: string): boolean {
  const stripped = hex.toLowerCase().replace(/^0+/, "") || "0";
  if (stripped === "0") return false;
  if (stripped.length <= 2) return false;
  if (stripped.length <= 6 && /^[1-9a-f][0-9a-f]*0{3,}$/i.test(stripped))
    return true;
  return false;
}

function detectFabricatedRegisterState(text: string): StructuralMarker | null {
  REGISTER_DUMP_RE.lastIndex = 0;
  const entries: {
    name: string;
    value: string;
    index: number;
    length: number;
  }[] = [];
  let m: RegExpExecArray | null;
  while ((m = REGISTER_DUMP_RE.exec(text)) !== null) {
    entries.push({
      name: m[1].toUpperCase(),
      value: m[2].toLowerCase(),
      index: m.index,
      length: m[0].length,
    });
  }
  // Need at least four register lines before judging — fewer than that is
  // a one-off mention of a pointer value, not a dump.
  if (entries.length < 4) return null;

  // Identical-value tell: fab dumps frequently repeat the same value across
  // several registers (e.g. `RAX = RBX = RCX = 0x4141414141414141`). Build
  // the set of values that appear in ≥3 register entries; trivial values
  // (single-hex-digit constants like `0x0` / `0xa`) are excluded so a real
  // dump where R8..R15 are all zero after a fresh frame setup doesn't trip
  // the rule.
  const valueCounts = new Map<string, number>();
  for (const e of entries) {
    const v = e.value.replace(/^0+/, "") || "0";
    if (v.length <= 1) continue;
    valueCounts.set(v, (valueCounts.get(v) ?? 0) + 1);
  }
  const repeatedValues = new Set<string>();
  for (const [v, count] of valueCounts) {
    if (count >= 3) repeatedValues.add(v);
  }
  // An entry is suspicious if either tell fires; every entry is counted at
  // most once even when both checks would catch it.
  let suspicious = 0;
  let firstSuspicious: (typeof entries)[number] | null = null;
  for (const e of entries) {
    const stripped = e.value.replace(/^0+/, "") || "0";
    if (isSuspiciousRegisterValue(e.value) || repeatedValues.has(stripped)) {
      suspicious++;
      if (!firstSuspicious) firstSuspicious = e;
    }
  }

  if (
    suspicious >= 4 &&
    suspicious / entries.length >= 0.5 &&
    firstSuspicious
  ) {
    return {
      id: "fabricated_register_state",
      description: `${suspicious}/${entries.length} register values are textbook-round (≤6 hex digits with ≥3 trailing zeros) or repeated across registers; real register dumps are pseudo-random pointers/constants`,
      range: rangeAt(text, firstSuspicious.index, firstSuspicious.length),
    };
  }
  return null;
}

// `/proc/self/maps` line shape:
//   55f4a1c89000-55f4a1c8a000 r-xp 00000000 fd:00 12345 /usr/bin/bash
// We anchor at line start (multiline flag) and require the 4-char perms
// field as the disambiguator — that combination very rarely occurs outside
// a real or fabricated maps listing, so false positives on stack-frame
// hex pairs are not a concern. Allow an optional `0x` prefix because some
// LLM dumps add it even though real /proc/self/maps never does.
const MAPS_LINE_RE =
  /^[ \t]*(?:0x)?([0-9a-fA-F]{4,16})-(?:0x)?([0-9a-fA-F]{4,16})[ \t]+([-rwxsp]{4})(?=[ \t]|$)/gm;
// Linux's default `vm.mmap_min_addr` is 65536 (0x10000). Userspace mappings
// below that address are rejected by the kernel, so any fabricated maps
// line claiming a range starting at e.g. `00001000-00002000` is structurally
// impossible regardless of process or kernel version.
const MMAP_MIN_ADDR = BigInt("0x10000");
// Linux memory mappings are always page-aligned. The smallest page size
// supported by mainstream architectures (x86-64, ARM64 4K mode, RISC-V
// Sv39/Sv48) is 4 KiB = 0x1000, so both `start` and `end` of every real
// /proc/self/maps row are multiples of 0x1000. A fabricated row that picks
// arbitrary hex digits (e.g. `55f4a1c89123-55f4a1c8a456`) violates this.
const PAGE_SIZE = BigInt("0x1000");

function detectFabricatedMemoryMap(text: string): StructuralMarker | null {
  MAPS_LINE_RE.lastIndex = 0;
  const ranges: {
    start: bigint;
    end: bigint;
    index: number;
    length: number;
  }[] = [];
  let m: RegExpExecArray | null;
  while ((m = MAPS_LINE_RE.exec(text)) !== null) {
    // The regex restricts both groups to [0-9a-fA-F]+, so the BigInt
    // parses are infallible.
    ranges.push({
      start: BigInt("0x" + m[1]),
      end: BigInt("0x" + m[2]),
      index: m.index,
      length: m[0].length,
    });
  }
  // Need ≥2 lines before judging — a stray hex-hex pair on its own line
  // followed by a perms-shaped token is highly unlikely but we don't want
  // to fire on a single accidental match.
  if (ranges.length < 2) return null;

  // 1. Inverted / zero-size range — physically impossible.
  for (const r of ranges) {
    if (r.end <= r.start) {
      return {
        id: "fabricated_memory_map",
        description: `Memory-map range 0x${r.start.toString(16)}-0x${r.end.toString(16)} has end ≤ start; real /proc/self/maps entries are non-empty (end strictly greater than start)`,
        range: rangeAt(text, r.index, r.length),
      };
    }
  }

  // 2. Range below mmap_min_addr — userspace can't map there.
  for (const r of ranges) {
    if (r.start < MMAP_MIN_ADDR) {
      return {
        id: "fabricated_memory_map",
        description: `Memory-map range starts at 0x${r.start.toString(16)} which is below Linux mmap_min_addr (0x10000); real userspace mappings never sit in the low 64 KiB`,
        range: rangeAt(text, r.index, r.length),
      };
    }
  }

  // 3. Non-page-aligned start or end — every kernel rounds VMAs to the page
  // boundary (≥4 KiB on every supported arch), so an arbitrary low-nibble
  // value is a tell that the LLM made the address up.
  for (const r of ranges) {
    if (r.start % PAGE_SIZE !== BigInt(0) || r.end % PAGE_SIZE !== BigInt(0)) {
      return {
        id: "fabricated_memory_map",
        description: `Memory-map range 0x${r.start.toString(16)}-0x${r.end.toString(16)} is not 4 KiB page-aligned; real /proc/self/maps entries always start and end on page boundaries`,
        range: rangeAt(text, r.index, r.length),
      };
    }
  }

  // 4. Overlapping ranges — kernel coalesces or splits, never overlaps.
  // Sort by start address but preserve the original (index, length) so the
  // marker range still points at a real source line in `text`.
  const sorted = [...ranges].sort((a, b) =>
    a.start < b.start ? -1 : a.start > b.start ? 1 : 0,
  );
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      return {
        id: "fabricated_memory_map",
        description: `Memory-map range 0x${sorted[i].start.toString(16)}-0x${sorted[i].end.toString(16)} overlaps the previous range ending at 0x${sorted[i - 1].end.toString(16)}; real /proc/self/maps entries never overlap`,
        range: rangeAt(text, sorted[i].index, sorted[i].length),
      };
    }
  }

  return null;
}

// Task #455 /proc/self/status detector --------------------------------
//
// LLMs that pad a fabricated crash report beyond the stack and the
// register dump frequently reach for a `/proc/self/status` excerpt next.
// The kernel emits a stable line shape — `<Vm field>:<whitespace><N> kB` —
// so the section is easy to mimic, but the actual values are pseudo-random
// page-aligned kB counts (e.g. `VmRSS: 4232 kB`, `VmPeak: 25876 kB`) that
// are very rarely exact powers of two. Fabricated excerpts almost always
// reach for textbook values like `VmRSS: 1024 kB`, `VmSize: 65536 kB`,
// `VmHWM: 16384 kB` — values that look "neat" but the kernel essentially
// never emits.
//
// We require ≥3 Vm-field lines before judging (so a one-off `VmRSS: 1024
// kB` mention in prose can't trigger the rule) and ≥2 of those lines must
// carry an exact power-of-two kB value at or above 1 MiB. The 1 MiB floor
// keeps the rule from firing on small fields like `VmStk: 132 kB` or
// `VmExe: 36 kB`, where small powers of two (4, 8, 16, 32, 64, 128, 256,
// 512) can show up legitimately for tiny processes.
const PROC_STATUS_VM_RE =
  /^[ \t]*(VmPeak|VmSize|VmLck|VmPin|VmHWM|VmRSS|VmData|VmStk|VmExe|VmLib|VmPTE|VmSwap)\s*:\s*(\d+)\s*kB\b/gim;
const VM_POWER_OF_TWO_FLOOR_KB = 1024; // 1 MiB

function isPowerOfTwo(n: number): boolean {
  if (!Number.isFinite(n) || n <= 0) return false;
  // JS bitwise operators truncate to int32; use log2 so we stay correct
  // for VmSize values that legitimately exceed 2 GiB (≥ 2_097_152 kB).
  const log = Math.log2(n);
  return Number.isInteger(log);
}

function detectFabricatedProcStatus(text: string): StructuralMarker | null {
  PROC_STATUS_VM_RE.lastIndex = 0;
  const entries: {
    name: string;
    value: number;
    index: number;
    length: number;
  }[] = [];
  let m: RegExpExecArray | null;
  while ((m = PROC_STATUS_VM_RE.exec(text)) !== null) {
    const v = Number(m[2]);
    if (Number.isFinite(v)) {
      entries.push({
        name: m[1],
        value: v,
        index: m.index,
        length: m[0].length,
      });
    }
  }
  if (entries.length < 3) return null;

  const suspicious = entries.filter(
    (e) => e.value >= VM_POWER_OF_TWO_FLOOR_KB && isPowerOfTwo(e.value),
  );
  if (suspicious.length >= 2) {
    const summary = suspicious
      .slice(0, 4)
      .map((s) => `${s.name}: ${s.value} kB`)
      .join(", ");
    return {
      id: "fabricated_proc_status",
      description: `${suspicious.length}/${entries.length} /proc/self/status Vm fields are exact powers of two ≥ 1 MiB (${summary}); real kernels emit pseudo-random page-aligned kB counts`,
      range: rangeAt(text, suspicious[0].index, suspicious[0].length),
    };
  }
  return null;
}

// Task #434 ASan shadow-bytes detector ----------------------------------
//
// Real ASan output emits a "Shadow bytes around the buggy address:" header
// followed by a fixed-width grid: each row is `0x<addr>: bb bb bb bb bb bb
// bb bb bb bb bb bb bb bb bb bb` — exactly 16 hex byte pairs, with the row
// containing the buggy address marked by a leading `=>` and the buggy byte
// itself bracketed (`[fd]`). Below the grid is a multi-line legend mapping
// each shadow byte value to its meaning (`Addressable: 00`, `Heap left
// redzone: fa`, `Freed heap region: fd`, …).
//
// Fabricated shadow blocks routinely deviate from those invariants in three
// ways: rows that don't carry 16 byte pairs (LLMs pick 8 or 4 because the
// resulting block "looks shorter and more readable"), no `=>` marker on any
// row (the LLM doesn't know which row carries the buggy address), and no
// legend at all (the LLM stops generating after the grid). This detector
// fires when a "Shadow bytes" section is *present* and trips any of those
// three checks — it never fires on traces that legitimately omit the
// section, since plenty of real reports paste only the stack frames.

const SHADOW_BYTES_HEADER_RE =
  /Shadow\s+bytes\s+around\s+the\s+buggy\s+address[ \t]*:?[ \t]*/i;
// A shadow row line: optional leading `=>`, an address `0x<hex>:`, then a
// run of hex byte pairs separated by whitespace, with optional `[ ]`
// bracketing the buggy byte. The row contents are captured so the byte
// count can be measured; non-row lines (the legend, blank separators,
// surrounding prose) do not match.
const SHADOW_ROW_RE =
  /^[ \t]*(=>)?[ \t]*0x[0-9a-fA-F]+:[ \t]+([0-9a-fA-F\[\]\s]+?)[ \t]*$/;
// Legend entry: a named shadow-byte category followed by `:` and a hex
// pair. Matching any one of these anywhere in the report is enough to
// satisfy the legend-presence check; ASan emits ten or so categories so
// fabricators that drop the legend miss all of them at once.
const SHADOW_LEGEND_RE =
  /\b(?:Addressable|Partially\s+addressable|Heap\s+left\s+redzone|Heap\s+right\s+redzone|Freed\s+heap\s+region|Stack\s+left\s+redzone|Stack\s+mid\s+redzone|Stack\s+right\s+redzone|Stack\s+after\s+return|Stack\s+use\s+after\s+scope|Global\s+redzone|Global\s+init\s+order|Poisoned\s+by\s+user|Container\s+overflow|Array\s+cookie|Intra\s+object\s+redzone|ASan\s+internal|Left\s+alloca\s+redzone|Right\s+alloca\s+redzone|Shadow\s+gap)\s*:\s*[0-9a-fA-F]{2}/i;
const EXPECTED_SHADOW_ROW_WIDTH = 16;

function detectMalformedShadowBytes(text: string): StructuralMarker | null {
  const headerMatch = SHADOW_BYTES_HEADER_RE.exec(text);
  if (!headerMatch) return null;

  // Scan the lines following the header and collect contiguous shadow
  // rows. A blank line is allowed inside the block (some pretty-printers
  // insert one between the buggy row and its neighbours); the first
  // non-blank non-row line ends the block (typically the legend header
  // `Shadow byte legend (...)` or surrounding prose).
  const headerEnd = headerMatch.index + headerMatch[0].length;
  const after = text.slice(headerEnd);
  // Track per-line offsets back into the original `text` so each error
  // marker can carry an accurate `range`. We split on `\n` (preserving
  // CRLF length via the +1 below, since the regex matched both `\r\n` and
  // `\n` boundaries equally for our purposes).
  const lines = after.split(/\r?\n/);
  let cursor = headerEnd;
  let hasBuggyMarker = false;
  const rows: { width: number; raw: string; index: number; length: number }[] =
    [];
  // Preserve the per-row newline length so cursor stays accurate even when
  // the trace mixes `\n` and `\r\n` line endings.
  const newlineLengths: number[] = [];
  let scanIdx = headerEnd;
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i].length;
    const after2 = text.slice(scanIdx + len, scanIdx + len + 2);
    const nl = after2.startsWith("\r\n") ? 2 : after2.startsWith("\n") ? 1 : 0;
    newlineLengths.push(nl);
    scanIdx += len + nl;
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = cursor;
    cursor += line.length + (newlineLengths[i] ?? 0);
    if (line.trim() === "") continue;
    const m = line.match(SHADOW_ROW_RE);
    if (!m) break;
    if (m[1]) hasBuggyMarker = true;
    // Normalise the captured byte run: strip the bracket characters
    // (which only mark the buggy byte, not a separator) and split on
    // whitespace. Keep only tokens that look like exactly a 2-digit hex
    // pair; anything else means the row is malformed in a way the row
    // regex didn't already reject.
    const bytes = m[2]
      .replace(/[\[\]]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 0);
    if (!bytes.every((b) => /^[0-9a-fA-F]{2}$/.test(b))) {
      return {
        id: "malformed_shadow_bytes",
        description: `Shadow byte row contains non-hex-pair tokens: "${line.trim()}"`,
        range: rangeAt(text, lineStart, line.length),
      };
    }
    rows.push({
      width: bytes.length,
      raw: line.trim(),
      index: lineStart,
      length: line.length,
    });
  }

  if (rows.length === 0) {
    return {
      id: "malformed_shadow_bytes",
      description: `Trace contains "Shadow bytes around the buggy address" header but no shadow rows follow it; real ASan always prints the grid after the header`,
      range: rangeAt(text, headerMatch.index, headerMatch[0].length),
    };
  }

  const wrongWidth = rows.find((r) => r.width !== EXPECTED_SHADOW_ROW_WIDTH);
  if (wrongWidth) {
    return {
      id: "malformed_shadow_bytes",
      description: `Shadow byte row has ${wrongWidth.width} hex byte pairs (expected ${EXPECTED_SHADOW_ROW_WIDTH}): "${wrongWidth.raw}"`,
      range: rangeAt(text, wrongWidth.index, wrongWidth.length),
    };
  }

  if (!hasBuggyMarker) {
    return {
      id: "malformed_shadow_bytes",
      description: `Shadow bytes section is missing the "=>" buggy-address marker on every row; real ASan always marks the row containing the faulting address`,
      // No single buggy row to point at — anchor on the section header so
      // reviewers land on the start of the grid.
      range: rangeAt(text, headerMatch.index, headerMatch[0].length),
    };
  }

  if (!SHADOW_LEGEND_RE.test(text)) {
    return {
      id: "malformed_shadow_bytes",
      description: `Shadow bytes section lacks the legend (e.g., "Addressable: 00", "Heap left redzone: fa", "Freed heap region: fd"); real ASan output always emits the legend below the grid`,
      range: rangeAt(text, headerMatch.index, headerMatch[0].length),
    };
  }

  return null;
}

// Task #608 ASan shadow-byte class-mismatch detector --------------------
//
// Task #434 added the structural `malformed_shadow_bytes` detector that
// catches shadow blocks with the wrong row width, a missing `=>` marker,
// or an absent legend. It does NOT catch a deeper class of fakes: a
// shadow block whose grid *pattern* contradicts the declared bug class
// — for example, a buggy row painted entirely with `fa` (heap left
// redzone) under a `heap-use-after-free` header (whose buggy byte should
// be `fd`, "Freed heap region"). Those reports survive the shape checks
// because the row width, marker, and legend are all present.
//
// Real ASan tags the bracketed buggy byte on the `=>` row with the
// shadow value matching the bug class:
//   heap-use-after-free / double-free / bad-free  → fd
//   heap-buffer-overflow / heap-buffer-underflow  → fa / fb / 01..07
//   stack-buffer-overflow / stack-buffer-underflow / stack-overflow
//                                                 → f1 / f2 / f3
//   stack-use-after-return                        → f5
//   stack-use-after-scope                         → f8
//   global-buffer-overflow                        → f9
//   container-overflow                            → fc
//   intra-object-overflow                         → bb
//   use-after-poison                              → f7
//   dynamic-stack-buffer-overflow                 → cb / cc
// LLM fabrications routinely paint the buggy row with a value picked at
// random from the legend without consulting the header.
//
// This detector fires when:
//   1. A "Shadow bytes around the buggy address" section is present, AND
//   2. The `=>` row carries a bracketed `[xx]` buggy byte, AND
//   3. The `ERROR: AddressSanitizer: <bug-class>` header declares a
//      recognised bug class, AND
//   4. The bracketed byte is NOT in the expected set for that bug class.
// Traces that omit the shadow section, omit the `=>` row, or use an
// unrecognised bug class are left to the existing shape detector and
// to the trace-validity scoring.

interface BugClassExpectation {
  pattern: RegExp;
  label: string;
  expected: ReadonlySet<string>;
}

// `ERROR: AddressSanitizer: <bug-class> ...` — the bug class is the
// hyphenated/space-separated phrase between the `:` and the next
// punctuation/`on address`/end-of-line. We capture a generous slice and
// run the per-class patterns against it (and against the surrounding
// header line as a fallback) so wrappers like `==N==ERROR:
// AddressSanitizer: heap-use-after-free on address ...` classify cleanly.
const ASAN_BUG_CLASS_HEADER_RE =
  /AddressSanitizer\s*:\s*([A-Za-z][A-Za-z0-9_-]*(?:[-\s][A-Za-z0-9_]+){0,5})/i;

// `[xx]` bracketed buggy byte on the `=>` row. ASan brackets exactly one
// byte per row; if a fabrication brackets multiple we take the first.
const SHADOW_BUGGY_BYTE_RE = /\[([0-9a-fA-F]{2})\]/;

// Order matters: more specific patterns come first so e.g.
// `stack-use-after-return` matches its dedicated entry before falling
// through to the generic `use-after-...` rules.
const BUG_CLASS_EXPECTATIONS: readonly BugClassExpectation[] = [
  {
    pattern: /stack[-\s]use[-\s]after[-\s]return/i,
    label: "stack-use-after-return",
    expected: new Set(["f5"]),
  },
  {
    pattern: /stack[-\s]use[-\s]after[-\s]scope/i,
    label: "stack-use-after-scope",
    expected: new Set(["f8"]),
  },
  {
    pattern: /heap[-\s]use[-\s]after[-\s]free/i,
    label: "heap-use-after-free",
    expected: new Set(["fd"]),
  },
  {
    pattern: /(?:double[-\s]free|bad[-\s]free|invalid[-\s]free)/i,
    label: "double-free/bad-free",
    expected: new Set(["fd"]),
  },
  {
    pattern: /global[-\s]buffer[-\s](?:overflow|underflow)/i,
    label: "global-buffer-overflow",
    expected: new Set(["f9"]),
  },
  {
    pattern: /container[-\s]overflow/i,
    label: "container-overflow",
    expected: new Set(["fc"]),
  },
  {
    pattern: /intra[-\s]object[-\s](?:overflow|redzone)/i,
    label: "intra-object-overflow",
    expected: new Set(["bb"]),
  },
  {
    pattern: /use[-\s]after[-\s]poison/i,
    label: "use-after-poison",
    expected: new Set(["f7"]),
  },
  {
    pattern: /dynamic[-\s]stack[-\s]buffer[-\s](?:overflow|underflow)/i,
    label: "dynamic-stack-buffer-overflow",
    expected: new Set(["cb", "cc"]),
  },
  {
    pattern: /stack[-\s]buffer[-\s](?:overflow|underflow)|stack[-\s]overflow/i,
    label: "stack-buffer-overflow",
    expected: new Set(["f1", "f2", "f3"]),
  },
  {
    pattern: /heap[-\s]buffer[-\s](?:overflow|underflow)|heap[-\s]overflow/i,
    label: "heap-buffer-overflow",
    expected: new Set(["fa", "fb", "01", "02", "03", "04", "05", "06", "07"]),
  },
  // Fallback for plain `use-after-free` (no `heap-` prefix). ASan emits
  // this only for the heap variant in practice; the stack variants always
  // carry their `stack-` prefix.
  {
    pattern: /use[-\s]after[-\s]free/i,
    label: "use-after-free",
    expected: new Set(["fd"]),
  },
];

function classifyAsanBugClass(
  text: string,
): { label: string; expected: ReadonlySet<string> } | null {
  const headerM = ASAN_BUG_CLASS_HEADER_RE.exec(text);
  if (!headerM) return null;
  const bugClassPhrase = headerM[1];
  for (const exp of BUG_CLASS_EXPECTATIONS) {
    if (exp.pattern.test(bugClassPhrase)) {
      return { label: exp.label, expected: exp.expected };
    }
  }
  // Fall back to matching against the whole header line (some generators
  // wrap the bug class onto the next line or insert extra punctuation
  // the phrase regex stops at).
  const lineEnd = text.indexOf("\n", headerM.index);
  const headerSlice = text.slice(
    headerM.index,
    lineEnd === -1 ? text.length : lineEnd,
  );
  for (const exp of BUG_CLASS_EXPECTATIONS) {
    if (exp.pattern.test(headerSlice)) {
      return { label: exp.label, expected: exp.expected };
    }
  }
  return null;
}

function detectShadowByteClassMismatch(text: string): StructuralMarker | null {
  // No shadow-bytes section → nothing to evaluate. The cheap header probe
  // also short-circuits the bug-class regex on traces that don't paint a
  // grid at all.
  const headerMatch = SHADOW_BYTES_HEADER_RE.exec(text);
  if (!headerMatch) return null;

  // Locate the `=>` row carrying a `[xx]` buggy-byte marker. We only scan
  // shadow rows immediately following the header so a `[xx]` token in
  // surrounding prose can't be mistaken for the buggy byte.
  const headerEnd = headerMatch.index + headerMatch[0].length;
  const after = text.slice(headerEnd);
  const lines = after.split(/\r?\n/);
  // Recompute per-line newline lengths exactly like
  // `detectMalformedShadowBytes` so cursor math stays accurate across
  // mixed `\n` / `\r\n` line endings.
  const newlineLengths: number[] = [];
  let scanIdx = headerEnd;
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i].length;
    const ahead = text.slice(scanIdx + len, scanIdx + len + 2);
    const nl = ahead.startsWith("\r\n") ? 2 : ahead.startsWith("\n") ? 1 : 0;
    newlineLengths.push(nl);
    scanIdx += len + nl;
  }
  let buggyByte: string | null = null;
  let buggyRange: { start: number; length: number } | null = null;
  let cursor = headerEnd;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = cursor;
    cursor += line.length + (newlineLengths[i] ?? 0);
    if (line.trim() === "") continue;
    const rowM = line.match(SHADOW_ROW_RE);
    if (!rowM) break; // first non-row line ends the grid
    if (!rowM[1]) continue; // not the `=>` row
    const buggyM = SHADOW_BUGGY_BYTE_RE.exec(line);
    if (!buggyM) continue; // `=>` row but no `[xx]` — leave to the shape detector
    buggyByte = buggyM[1].toLowerCase();
    buggyRange = {
      start: lineStart + (buggyM.index ?? 0),
      length: buggyM[0].length,
    };
    break;
  }
  if (!buggyByte || !buggyRange) return null;

  const cls = classifyAsanBugClass(text);
  if (!cls) return null;
  if (cls.expected.has(buggyByte)) return null;

  const expectedList = [...cls.expected].slice(0, 6).join(", ");
  return {
    id: "shadow_byte_class_mismatch",
    description: `Shadow grid buggy byte \`[${buggyByte}]\` contradicts the declared bug class "${cls.label}" (expected one of: ${expectedList}); real ASan tags the buggy byte with the shadow value matching the bug class`,
    range: rangeAt(text, buggyRange.start, buggyRange.length),
  };
}

// Task #433 thread-ID-mismatch detector ------------------------------------
//
// Sprint 13B-2's `thread_id_inconsistency` catches `thread T<n>` mentions
// with no `==<pid>==` header at all. Task #303's `implausible_thread_id`
// catches T<n> values outside the realistic envelope (PID 0 / >4_194_304,
// thread T<n> with n>1024). Neither catches the most common LLM tell:
// a header IS present and every individual T<n> is in range, but the
// body's per-role thread IDs don't agree — `READ ... thread T0`, `freed
// by thread T7`, `previously allocated by thread T2`. In real ASan/TSan
// output the same thread ID typically dominates the role anchors of a
// single error report (most often used == freed == allocated for a UAF;
// TSan races are a 2-thread writer/reader pair). Three or more distinct
// thread IDs scattered across the role anchors of one error report is
// the heuristic tell this detector picks up.

// Role-anchored "thread T<n>" patterns. We deliberately scope to the
// canonical role positions a real sanitizer emits, NOT bare "thread T<n>"
// in prose, so a writer who mentions threads in their narrative doesn't
// trip the rule. The intent is "role anchors only" so we have a tight
// signal even for short report excerpts.
const THREAD_ROLE_RES: RegExp[] = [
  // ASan / TSan block header: "READ of size 8 at 0x... thread T0",
  //   "WRITE of size 4 at 0x... by thread T1", "Read of size 8 ... by thread T3",
  //   "Previous read of size 8 at 0x... by thread T1".
  /\b(?:READ|WRITE|read|write)\s+of\s+size\s+\d+\s+at\s+0x[0-9a-fA-F]+\s+(?:by\s+)?thread\s+T(\d+)/gi,
  // ASan free-by trailer.
  /\bfreed\s+by\s+thread\s+T(\d+)/gi,
  // ASan allocated-by / previously-allocated-by trailer.
  /\b(?:previously\s+)?allocated\s+by\s+thread\s+T(\d+)/gi,
];

function detectThreadIdMismatch(text: string): StructuralMarker | null {
  const ids = new Set<number>();
  // Track the earliest role-anchor hit so we can anchor the marker's
  // `range` (Task #451) on the first offending line in the report.
  let firstHit: { index: number; length: number } | null = null;
  for (const re of THREAD_ROLE_RES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) ids.add(n);
      if (firstHit === null || m.index < firstHit.index) {
        firstHit = { index: m.index, length: m[0].length };
      }
    }
  }
  // Per the task spec: 3+ distinct role-tagged thread IDs in a single
  // trace is the firing condition. Single-thread UAFs and 2-thread TSan
  // races fall below this threshold by construction; the four named
  // legit fixtures (T1-01-uaf-libfoo, T1-AVRI-firefox-uaf,
  // T1-AVRI-cve-2025-0725-curl, SYMBOL_RICH_TSAN_TRACE) all use ≤2
  // distinct role-tagged thread IDs and stay below.
  if (ids.size < 3 || firstHit === null) return null;
  const sorted = [...ids].sort((a, b) => a - b);
  return {
    id: "thread_id_mismatch",
    description: `Trace references ${ids.size} distinct thread IDs across role anchors (T${sorted.join(", T")}); real sanitizer output keeps the role-tagged thread IDs of a single error report consistent (used == freed == allocated for a UAF, or a 2-thread writer/reader pair for a TSan race)`,
    range: rangeAt(text, firstHit.index, firstHit.length),
  };
}

/** Build the list of frame lines tagged with their position in `text` so
 * the frame-based detectors can attach a `range` to the marker they emit.
 * `FRAME_LINES_RE` is a global multiline regex; `matchAll` gives us every
 * match's start index in the source. */
function collectFrameLines(text: string): FrameLine[] {
  const out: FrameLine[] = [];
  // `FRAME_LINES_RE` is shared module state with `lastIndex`; clone it so
  // we never reset state for callers iterating the regex elsewhere.
  const re = new RegExp(FRAME_LINES_RE.source, FRAME_LINES_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({
      text: m[0],
      start: m.index,
      line: lineNumberAt(text, m.index),
    });
    // Guard against zero-length matches advancing the cursor by hand —
    // `FRAME_LINES_RE` requires non-empty matches but we keep this for
    // safety in case the pattern ever loosens.
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

/** Run all structural-fabrication detectors and return the markers that
 * fired. Exported so the hallucination detector can hook the same predicates
 * without re-tokenising the trace. */
export function detectStructuralFabrication(text: string): StructuralMarker[] {
  const frames = collectFrameLines(text);
  const markers: StructuralMarker[] = [];
  const a = detectRoundFunctionOffsets(frames, text);
  if (a) markers.push(a);
  const b = detectFrameNumberingGaps(frames, text);
  if (b) markers.push(b);
  const c = detectThreadIdInconsistency(text);
  if (c) markers.push(c);
  const d = detectRoundHeapRegionSize(text);
  if (d) markers.push(d);
  // Task #303 bounds detectors.
  const e = detectImplausibleFunctionOffsets(frames, text);
  if (e) markers.push(e);
  const f = detectImplausibleThreadIds(text);
  if (f) markers.push(f);
  const g = detectRegionSizeVsAccessSize(text);
  if (g) markers.push(g);
  // Task #316 register-dump and memory-map detectors.
  const h = detectFabricatedRegisterState(text);
  if (h) markers.push(h);
  const i = detectFabricatedMemoryMap(text);
  if (i) markers.push(i);
  // Task #434 shadow-bytes detector.
  const j1 = detectMalformedShadowBytes(text);
  if (j1) markers.push(j1);
  // Task #608 shadow-byte class-mismatch detector. The shape detector
  // above catches wrong row width / missing `=>` / absent legend; this
  // semantic check fires when the *bracketed buggy byte* contradicts the
  // bug class declared in the ASan header even though the grid shape is
  // intact.
  const j1b = detectShadowByteClassMismatch(text);
  if (j1b) markers.push(j1b);
  // Task #433 thread-ID-mismatch detector.
  const j2 = detectThreadIdMismatch(text);
  if (j2) markers.push(j2);
  // Task #455 /proc/self/status detector. The companion ARM64/RISC-V
  // register-name extension is wired in via the shared REGISTER_DUMP_RE
  // and so is already exercised by `detectFabricatedRegisterState` above.
  const k = detectFabricatedProcStatus(text);
  if (k) markers.push(k);
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
  RACE_CONCURRENCY: new Set(["tsan_or_helgrind"]),
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
