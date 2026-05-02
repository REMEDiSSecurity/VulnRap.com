import sys

path = 'artifacts/api-server/src/lib/engines/avri/crash-trace.ts'
with open(path, 'r') as f:
    content = f.read()

start_marker = '<<<<<<< HEAD'
mid_marker = '======='
end_marker = '>>>>>>> 3da7e70 (Task #451: clickable structural-fabrication markers jump report panel to line)'

start_idx = content.find(start_marker)
mid_idx = content.find(mid_marker, start_idx)
end_idx = content.find(end_marker, mid_idx)

if start_idx == -1 or mid_idx == -1 or end_idx == -1:
    print(f"Markers not found: start={start_idx}, mid={mid_idx}, end={end_idx}")
    sys.exit(1)

line_end = content.find('\n', end_idx) + 1

new_block = """// Task #433 thread-ID-mismatch detector ------------------------------------
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
  /\\b(?:READ|WRITE|read|write)\\s+of\\s+size\\s+\\d+\\s+at\\s+0x[0-9a-fA-F]+\\s+(?:by\\s+)?thread\\s+T(\\d+)/gi,
  // ASan free-by trailer.
  /\\bfreed\\s+by\\s+thread\\s+T(\\d+)/gi,
  // ASan allocated-by / previously-allocated-by trailer.
  /\\b(?:previously\\s+)?allocated\\s+by\\s+thread\\s+T(\\d+)/gi,
];

function detectThreadIdMismatch(text: string): StructuralMarker | null {
  const ids = new Set<number>();
  let firstMatch: { index: number; length: number } | null = null;
  for (const re of THREAD_ROLE_RES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) {
        ids.add(n);
        if (!firstMatch) firstMatch = { index: m.index, length: m[0].length };
      }
    }
  }
  // Per the task spec: 3+ distinct role-tagged thread IDs in a single
  // trace is the firing condition. Single-thread UAFs and 2-thread TSan
  // races fall below this threshold by construction; the four named
  // legit fixtures (T1-01-uaf-libfoo, T1-AVRI-firefox-uaf,
  // T1-AVRI-cve-2025-0725-curl, SYMBOL_RICH_TSAN_TRACE) all use \u22642
  // distinct role-tagged thread IDs and stay below.
  if (ids.size < 3) return null;
  const sorted = [...ids].sort((a, b) => a - b);
  return {
    id: "thread_id_mismatch",
    description: `Trace references ${ids.size} distinct thread IDs across role anchors (T${sorted.join(", T")}); real sanitizer output keeps the role-tagged thread IDs of a single error report consistent (used == freed == allocated for a UAF, or a 2-thread writer/reader pair for a TSan race)`,
    range: firstMatch ? rangeAt(text, firstMatch.index, firstMatch.length) : undefined,
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
    // Guard against zero-length matches advancing the cursor by hand \u2014
    // `FRAME_LINES_RE` requires non-empty matches but we keep this for
    // safety in case the pattern ever loosens.
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}
"""

new_content = content[:start_idx] + new_block.strip() + content[line_end:]
with open(path, 'w') as f:
    f.write(new_content)
