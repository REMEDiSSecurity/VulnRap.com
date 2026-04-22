import { describe, it, expect } from "vitest";
import { evaluateCrashTrace } from "./crash-trace.js";
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
