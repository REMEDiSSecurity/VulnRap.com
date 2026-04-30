import { describe, it, expect } from "vitest";
import { evaluateCrashTrace, detectStructuralFabrication } from "./crash-trace.js";
import { runEngine2Avri } from "./engine2-avri.js";
import { FAMILIES_BY_ID } from "./families.js";
import { extractSignals } from "../extractors.js";

const MEM = FAMILIES_BY_ID.MEMORY_CORRUPTION;
const RACE = FAMILIES_BY_ID.RACE_CONCURRENCY;

const SYMBOL_RICH_TRACE = `# Heap Use-After-Free in libfoo
\`\`\`asan
==12345==ERROR: AddressSanitizer: heap-use-after-free on address 0x60200000a1c0
READ of size 8 at 0x60200000a1c0 thread T0
    #0 0x55e9b8c2f3d1 in foo_finalize parser/parse.c:418
    #1 0x55e9b8c2e210 in foo_main parser/main.c:88
freed by thread T0 here:
    #0 0x7f0001 in __interceptor_free
    #1 0x55e9b8c2f1aa in parser/parse.c:412
\`\`\``;

const SYMBOL_STRIPPED_TRACE = `# Memory safety violation in request parsing path
\`\`\`
[memcheck] invalid access detected at offset +0xZZZZ
[memcheck]   frame 0: <symbol stripped> in libserver
[memcheck]   frame 1: <symbol stripped> in libserver
[memcheck]   frame 2: <symbol stripped> in libserver
[memcheck]   frame 3: <symbol stripped> in libnet
[memcheck]   frame 4: <symbol stripped> in main
[memcheck] aborting after first error
\`\`\``;

const PADDED_SLOP_TRACE = `# Heap-use-after-free crash in our shipped binary
==31337==ERROR: AddressSanitizer: heap-use-after-free on address 0xZZZZZZZZ
READ of size 8 at 0xZZZZZZZZ thread T0
    #0 0xXXXXXX in <symbol stripped>
    #1 0xXXXXXX in <symbol stripped>
    #2 0xXXXXXX in <symbol stripped>
    #3 0xXXXXXX in <symbol stripped>
freed by thread T0 here:
    #0 0xXXXXXX in <symbol stripped>
The crash is reproducible against the shipped binary which is the realistic
attack surface; rebuilding with debug symbols is left as an exercise.
Severity: Critical. use-after-free, sanitizer crash, segmentation fault.
size 8 bytes at offset 0. /usr/lib/libserver.c referenced.`;

describe("evaluateCrashTrace", () => {
  it("does not flag a symbol-rich sanitizer trace", () => {
    const r = evaluateCrashTrace(SYMBOL_RICH_TRACE);
    expect(r.framesAnalyzed).toBeGreaterThanOrEqual(4);
    expect(r.isStripped).toBe(false);
    expect(r.goodFrames).toBeGreaterThanOrEqual(r.framesAnalyzed - 1);
  });

  it("flags a memcheck trace whose frames are all <symbol stripped>", () => {
    const r = evaluateCrashTrace(SYMBOL_STRIPPED_TRACE);
    expect(r.framesAnalyzed).toBeGreaterThanOrEqual(5);
    expect(r.isStripped).toBe(true);
    expect(r.placeholderFrames).toBeGreaterThanOrEqual(5);
    expect(r.reason).toMatch(/placeholder|resolvable/);
  });

  it("flags a padded slop trace that would otherwise hit the sanitizer gold pattern", () => {
    const r = evaluateCrashTrace(PADDED_SLOP_TRACE);
    expect(r.isStripped).toBe(true);
    expect(r.goodFrames).toBe(0);
  });

  it("returns 0 frames for prose with no crash trace", () => {
    const r = evaluateCrashTrace("There is a use-after-free somewhere. Trust me.");
    expect(r.framesAnalyzed).toBe(0);
    expect(r.isStripped).toBe(false);
  });
});

describe("runEngine2Avri — stripped crash trace integration", () => {
  it("keeps a high AVRI score for the symbol-rich legit trace", () => {
    const sig = extractSignals(SYMBOL_RICH_TRACE);
    const result = runEngine2Avri(sig, SYMBOL_RICH_TRACE, MEM);
    expect(result.detail.rawAvriScore).toBeGreaterThanOrEqual(40);
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).not.toContain("STRIPPED_CRASH_TRACE");
  });

  it("revokes trace gold hits and pushes the AVRI score down for a stripped/padded slop trace", () => {
    const sig = extractSignals(PADDED_SLOP_TRACE);
    const result = runEngine2Avri(sig, PADDED_SLOP_TRACE, MEM);
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).toContain("STRIPPED_CRASH_TRACE");
    // The crash-trace gold IDs should be absent from the surviving goldHits.
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).not.toContain("asan_or_sanitizer");
    expect(survivingIds).not.toContain("stack_trace_with_offset");
    // And the raw AVRI score must stay below the YELLOW threshold (40).
    expect(result.detail.rawAvriScore).toBeLessThan(40);
  });

  it("still flags T3-14-style memcheck slop as RED-tier AVRI", () => {
    const sig = extractSignals(SYMBOL_STRIPPED_TRACE);
    const result = runEngine2Avri(sig, SYMBOL_STRIPPED_TRACE, MEM);
    expect(result.detail.rawAvriScore).toBeLessThan(40);
  });
});

// ---------------------------------------------------------------------------
// RACE_CONCURRENCY — TSan/Helgrind tool output is just as fakeable as ASAN.
// The validator must run for RACE_CONCURRENCY too and revoke the
// `tsan_or_helgrind` gold signal when the trace is stripped.
// ---------------------------------------------------------------------------

const SYMBOL_RICH_TSAN_TRACE = `# Data race in connection pool reaper
\`\`\`tsan
WARNING: ThreadSanitizer: data race (pid=4711)
  Write of size 8 at 0x7b0400000040 by thread T3:
    #0 net::Pool::reap(net::Conn*) src/net/pool.cc:184 (server+0x4f2a31)
    #1 net::Pool::tick() src/net/pool.cc:212 (server+0x4f2c80)
    #2 std::__1::__thread_proxy<...>(void*) thread:373 (server+0x91d40e)

  Previous read of size 8 at 0x7b0400000040 by thread T1:
    #0 net::Pool::checkout() src/net/pool.cc:97 (server+0x4f1a02)
    #1 http::Server::accept_loop() src/http/server.cc:441 (server+0x612b10)
    #2 std::__1::__thread_proxy<...>(void*) thread:373 (server+0x91d40e)

  Mutex M88 (0x7b1000000a40) created at:
    #0 pthread_mutex_init <null> (libtsan.so.0+0x4d2a8)
    #1 net::Pool::Pool() src/net/pool.cc:31 (server+0x4f0d40)

SUMMARY: ThreadSanitizer: data race src/net/pool.cc:184 in net::Pool::reap
\`\`\`
Repro: run \`./server --threads 8\` under \`tsan\` and hit /healthz concurrently
from two clients (thread 1 / thread 2 interleave); the race fires on the
second iteration.`;

const SYMBOL_STRIPPED_TSAN_TRACE = `# Data race in our shipped server binary
\`\`\`
WARNING: ThreadSanitizer: data race (pid=31337)
  Write of size 8 at 0xZZZZZZZZ by thread Ta:
    #0 0xXXXXXX in <symbol stripped>
    #1 0xXXXXXX in <symbol stripped>
    #2 0xXXXXXX in <symbol stripped>
    #3 0xXXXXXX in <symbol stripped>
  Previous read of size 8 at 0xZZZZZZZZ by thread Tb:
    #0 0xXXXXXX in <symbol stripped>
    #1 0xXXXXXX in <symbol stripped>
    #2 0xXXXXXX in <symbol stripped>
SUMMARY: ThreadSanitizer: data race in <symbol stripped>
\`\`\`
The race is reproducible against the shipped binary; rebuilding with debug
symbols is left as an exercise. Severity: Critical. tsan crash on the
shipped binary which is the realistic attack surface.`;

describe("runEngine2Avri — stripped RACE_CONCURRENCY trace integration", () => {
  it("keeps the tsan_or_helgrind gold hit for a symbol-rich legit TSan trace", () => {
    const sig = extractSignals(SYMBOL_RICH_TSAN_TRACE);
    const result = runEngine2Avri(sig, SYMBOL_RICH_TSAN_TRACE, RACE);
    const goldIds = result.detail.goldHits.map((g) => g.id);
    expect(goldIds).toContain("tsan_or_helgrind");
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).not.toContain("STRIPPED_CRASH_TRACE");
  });

  it("revokes tsan_or_helgrind and pushes AVRI down for a stripped TSan slop trace", () => {
    const sig = extractSignals(SYMBOL_STRIPPED_TSAN_TRACE);
    const result = runEngine2Avri(sig, SYMBOL_STRIPPED_TSAN_TRACE, RACE);
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).toContain("STRIPPED_CRASH_TRACE");
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).not.toContain("tsan_or_helgrind");
    expect(result.detail.rawAvriScore).toBeLessThan(40);
  });
});

// --- Sprint 13B-2: structural fabrication detector tests ----------------------

describe("detectStructuralFabrication — individual predicates", () => {
  it("flags ≥2 round/zero function offsets (round_function_offsets)", () => {
    const trace = `==99999==ERROR: AddressSanitizer: heap-use-after-free
READ of size 8 at 0xdeadbeef thread T0
    #0 0x4001000 in foo+0x0 src/foo.c:42
    #1 0x4001100 in bar+0x100 src/bar.c:88
    #2 0x4001200 in baz+0x1000 src/baz.c:99`;
    const ids = detectStructuralFabrication(trace).map((m) => m.id);
    expect(ids).toContain("round_function_offsets");
  });

  it("does NOT flag a single round offset (one round offset is allowed)", () => {
    const trace = `==1234==ERROR: AddressSanitizer: heap-use-after-free
    #0 0x4001000 in foo+0x0 src/foo.c:42
    #1 0x4001100 in bar+0x4abf1a src/bar.c:88
    #2 0x4001200 in baz+0x1c4d3 src/baz.c:99`;
    const ids = detectStructuralFabrication(trace).map((m) => m.id);
    expect(ids).not.toContain("round_function_offsets");
  });

  it("flags frame-numbering gaps (frame_numbering_gaps)", () => {
    const trace = `==99999==ERROR: AddressSanitizer
    #0 0x123 in foo src/foo.c:1
    #1 0x456 in bar src/bar.c:2
    #3 0x789 in baz src/baz.c:3`;
    const ids = detectStructuralFabrication(trace).map((m) => m.id);
    expect(ids).toContain("frame_numbering_gaps");
  });

  it("does NOT flag a clean #0,#1,#2 then reset to #0,#1 (multi-block ASan)", () => {
    const trace = `==1234==ERROR: AddressSanitizer: heap-use-after-free
READ of size 8 at 0xa1c0 thread T0
    #0 0x123 in foo src/foo.c:1
    #1 0x456 in bar src/bar.c:2
    #2 0x789 in baz src/baz.c:3
freed by thread T0 here:
    #0 0xabc in __interceptor_free
    #1 0xdef in destroy src/foo.c:99`;
    const ids = detectStructuralFabrication(trace).map((m) => m.id);
    expect(ids).not.toContain("frame_numbering_gaps");
  });

  it("flags thread-id mention without ==PID== anchor (thread_id_inconsistency)", () => {
    const trace = `WARNING: ThreadSanitizer: data race
  Read of size 4 by thread T1:
    #0 0x123 in foo src/foo.c:1
    #1 0x456 in bar src/bar.c:2`;
    const ids = detectStructuralFabrication(trace).map((m) => m.id);
    expect(ids).toContain("thread_id_inconsistency");
  });

  it("does NOT flag thread mention WITH ==PID== anchor", () => {
    const trace = `==12345==WARNING: ThreadSanitizer: data race
  Read of size 4 by thread T1:
    #0 0x123 in foo src/foo.c:1
    #1 0x456 in bar src/bar.c:2`;
    const ids = detectStructuralFabrication(trace).map((m) => m.id);
    expect(ids).not.toContain("thread_id_inconsistency");
  });

  it("flags hex-formatted region size (round_heap_region_size)", () => {
    const trace = `==99999==ERROR: AddressSanitizer
    #0 0x123 in foo src/foo.c:1
0x60200000 is located 0 bytes inside of region size: 0x100`;
    const ids = detectStructuralFabrication(trace).map((m) => m.id);
    expect(ids).toContain("round_heap_region_size");
  });

  it("flags textbook-power-of-two decimal region size with no bracketed range", () => {
    const trace = `==99999==ERROR: AddressSanitizer
    #0 0x123 in foo src/foo.c:1
allocated by thread T0; region size: 4096`;
    const ids = detectStructuralFabrication(trace).map((m) => m.id);
    expect(ids).toContain("round_heap_region_size");
  });

  it("does NOT flag a real ASan-style bracketed region", () => {
    const trace = `==12345==ERROR: AddressSanitizer
    #0 0x123 in foo src/foo.c:1
0x602000000010 is located 0 bytes inside of 8-byte region [0x602000000010,0x602000000018)`;
    const ids = detectStructuralFabrication(trace).map((m) => m.id);
    expect(ids).not.toContain("round_heap_region_size");
  });
});

// --- Task #303: bounds-based structural detectors ---------------------------

describe("detectStructuralFabrication — Task #303 bounds detectors", () => {
  it("flags ≥2 in-prologue function offsets (implausible_function_offset)", () => {
    const trace = `==12345==ERROR: AddressSanitizer: heap-use-after-free
READ of size 8 at 0x6020abcd thread T0
    #0 0x4001000 in handle_request+0x1 src/server.c:412
    #1 0x4001100 in worker_loop+0x2 src/worker.c:88
    #2 0x4001200 in dispatch+0x3 src/dispatch.c:42`;
    const ids = detectStructuralFabrication(trace).map((m) => m.id);
    expect(ids).toContain("implausible_function_offset");
  });

  it("flags ≥2 huge function offsets (implies ≥1 MiB function)", () => {
    const trace = `==12345==ERROR: AddressSanitizer: heap-use-after-free
    #0 0x4001000 in handle_request+0x100200 src/server.c:412
    #1 0x4001100 in worker_loop+0x4abf1a src/worker.c:88
    #2 0x4001200 in dispatch+0x123abc src/dispatch.c:42`;
    const ids = detectStructuralFabrication(trace).map((m) => m.id);
    expect(ids).toContain("implausible_function_offset");
  });

  it("does NOT flag binary-relative offsets like (curl+0x4abf1a)", () => {
    // Binary offsets in parentheses can legitimately run multi-megabyte
    // (the binary's `.text` section is huge); the bounds check only looks
    // at function offsets that come right after `in <symbol>`.
    const trace = `==54321==ERROR: AddressSanitizer: heap-buffer-overflow
WRITE of size 4294934527 at 0x611000009f80 thread T0
    #0 0x4abf1a in __asan_memcpy (curl+0x4abf1a)
    #1 0x55c1aa in inflate_stream lib/content_encoding.c:297
    #2 0x55b0ee in Curl_unencode_gzip_write lib/content_encoding.c:412`;
    const ids = detectStructuralFabrication(trace).map((m) => m.id);
    expect(ids).not.toContain("implausible_function_offset");
  });

  it("does NOT flag a single tiny offset (one is allowed)", () => {
    // Only `+0x1` is implausible; `+0x40` is well inside realistic bounds.
    const trace = `==12345==ERROR: AddressSanitizer: heap-use-after-free
    #0 0x4001000 in handle_request+0x1 src/server.c:412
    #1 0x4001100 in worker_loop+0x40 src/worker.c:88`;
    const ids = detectStructuralFabrication(trace).map((m) => m.id);
    expect(ids).not.toContain("implausible_function_offset");
  });

  it("flags PID 0 in ==N== header (implausible_thread_id)", () => {
    const trace = `==0==ERROR: AddressSanitizer: heap-use-after-free
READ of size 8 at 0x6020abcd thread T0
    #0 0x4001000 in foo src/foo.c:1`;
    const ids = detectStructuralFabrication(trace).map((m) => m.id);
    expect(ids).toContain("implausible_thread_id");
  });

  it("flags PID > Linux max (4_194_304)", () => {
    const trace = `==9999999==ERROR: AddressSanitizer: heap-use-after-free
    #0 0x4001000 in foo src/foo.c:1`;
    const ids = detectStructuralFabrication(trace).map((m) => m.id);
    expect(ids).toContain("implausible_thread_id");
  });

  it("flags thread T<n> with n > 1024", () => {
    const trace = `==12345==ERROR: AddressSanitizer: heap-use-after-free
READ of size 8 at 0x6020abcd thread T99999
    #0 0x4001000 in foo src/foo.c:1`;
    const ids = detectStructuralFabrication(trace).map((m) => m.id);
    expect(ids).toContain("implausible_thread_id");
  });

  it("does NOT flag realistic PID + T0 / T1 / T3", () => {
    const trace = `==31415==ERROR: AddressSanitizer: heap-use-after-free
READ of size 8 at 0x6190001a3c80 thread T0
    #0 0x7f9b22c1f3d1 in foo src/foo.c:1
Previous read of size 8 at 0x7b0400000040 by thread T3:`;
    const ids = detectStructuralFabrication(trace).map((m) => m.id);
    expect(ids).not.toContain("implausible_thread_id");
  });

  it("flags region size = 0 (region_size_vs_access_size)", () => {
    const trace = `==12345==ERROR: AddressSanitizer: heap-use-after-free
READ of size 8 at 0x6020abcd thread T0
    #0 0x4001000 in foo src/foo.c:1
0x6020abcd is located 0 bytes inside of region size: 0`;
    const ids = detectStructuralFabrication(trace).map((m) => m.id);
    expect(ids).toContain("region_size_vs_access_size");
  });

  it("flags access size > region size for a use-after-free", () => {
    const trace = `==12345==ERROR: AddressSanitizer: heap-use-after-free
READ of size 8 at 0x6020abcd thread T0
    #0 0x4001000 in foo src/foo.c:1
allocated by thread T0; region size: 4`;
    const ids = detectStructuralFabrication(trace).map((m) => m.id);
    expect(ids).toContain("region_size_vs_access_size");
  });

  it("does NOT flag access > region for a heap-buffer-overflow (that's the bug)", () => {
    const trace = `==12345==ERROR: AddressSanitizer: heap-buffer-overflow
WRITE of size 16 at 0x6020abcd thread T0
    #0 0x4001000 in foo src/foo.c:1
allocated by thread T0; region size: 8`;
    const ids = detectStructuralFabrication(trace).map((m) => m.id);
    expect(ids).not.toContain("region_size_vs_access_size");
  });

  it("does NOT flag access ≤ region for a use-after-free (legit)", () => {
    const trace = `==12345==ERROR: AddressSanitizer: heap-use-after-free
READ of size 8 at 0x602000000010 thread T0
    #0 0x4001000 in foo src/foo.c:1
0x602000000010 is located 0 bytes inside of 8-byte region [0x602000000010,0x602000000018)`;
    const ids = detectStructuralFabrication(trace).map((m) => m.id);
    expect(ids).not.toContain("region_size_vs_access_size");
  });
});

describe("evaluateCrashTrace — structural fabrication aggregation", () => {
  it("hasStructuralFabrication is true only when ≥2 markers fire", () => {
    // Only round_function_offsets should fire here.
    const oneMarker = `    #0 0x123 in foo+0x0 src/foo.c:1
    #1 0x456 in bar+0x100 src/bar.c:2
    #2 0x789 in baz src/baz.c:3`;
    const r1 = evaluateCrashTrace(oneMarker);
    expect(r1.structuralMarkers.length).toBeGreaterThanOrEqual(1);
    expect(r1.hasStructuralFabrication).toBe(false);

    // round_function_offsets + frame_numbering_gaps = 2 markers → fab.
    const twoMarkers = `    #0 0x123 in foo+0x0 src/foo.c:1
    #1 0x456 in bar+0x100 src/bar.c:2
    #3 0x789 in baz src/baz.c:3`;
    const r2 = evaluateCrashTrace(twoMarkers);
    expect(r2.structuralMarkers.length).toBeGreaterThanOrEqual(2);
    expect(r2.hasStructuralFabrication).toBe(true);
  });

  it("legit symbol-rich trace does not trigger structural fabrication", () => {
    const r = evaluateCrashTrace(SYMBOL_RICH_TRACE);
    expect(r.hasStructuralFabrication).toBe(false);
  });

  it("legit symbol-rich TSan trace does not trigger structural fabrication", () => {
    const r = evaluateCrashTrace(SYMBOL_RICH_TSAN_TRACE);
    expect(r.hasStructuralFabrication).toBe(false);
  });
});

const FABRICATED_ASAN_TRACE = `# Heap-use-after-free in libserver request handler
\`\`\`asan
ERROR: AddressSanitizer: heap-use-after-free on address 0x60200000a000
READ of size 8 at 0x60200000a000 by thread T0
    #0 0x4001000 in handle_request+0x0 src/server.c:412
    #1 0x4001100 in worker_loop+0x100 src/worker.c:88
    #2 0x4001200 in dispatch+0x1000 src/dispatch.c:42
    #4 0x4001300 in main+0x100 src/main.c:99
0x60200000a000 is located 0 bytes inside of region size: 0x100
\`\`\`
The crash is reproducible against the shipped binary which is the realistic
attack surface; rebuilding with debug symbols is left as an exercise.`;

describe("runEngine2Avri — structural fabrication integration", () => {
  it("revokes trace gold signal and emits STRUCTURAL_FABRICATION indicator", () => {
    const sig = extractSignals(FABRICATED_ASAN_TRACE);
    const result = runEngine2Avri(sig, FABRICATED_ASAN_TRACE, MEM);
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).toContain("STRUCTURAL_FABRICATION");
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).not.toContain("asan_or_sanitizer");
    expect(survivingIds).not.toContain("stack_trace_with_offset");
    expect(result.detail.rawAvriScore).toBeLessThan(40);
  });

  it("does NOT emit STRUCTURAL_FABRICATION for the symbol-rich legit trace", () => {
    const sig = extractSignals(SYMBOL_RICH_TRACE);
    const result = runEngine2Avri(sig, SYMBOL_RICH_TRACE, MEM);
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).not.toContain("STRUCTURAL_FABRICATION");
  });
});
