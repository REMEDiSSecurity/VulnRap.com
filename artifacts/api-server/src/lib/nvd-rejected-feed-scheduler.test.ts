// Task #1335 — Coverage for the NVD-rejected feed refresher.
//
// The scheduler exists so the CVE-validation pre-filter's `rejected_cve`
// lane actually fires in production — until #1335 nothing populated the
// in-process Map and rr-153 always landed as a MISS. These tests pin the
// contract reviewers care about:
//
//   1. The feed fetcher pages until it has every rejected id, filters to
//      `vulnStatus === "Rejected"` (defensive against the noRejected
//      param ever changing semantics), and de-duplicates across pages.
//   2. A successful tick primes `lookupNvdStatus` and writes the
//      persisted JSON file atomically.
//   3. The loader survives missing / malformed files (returns
//      `{ loaded: 0 }`) and successfully re-primes the cache for legit
//      files. The smoke harness relies on this for rr-153.
//   4. The scheduler is gated on NVD_REJECTED_FEED_ENABLED for fetches,
//      but the disk loader runs unconditionally so quarantine coverage
//      is hot at boot even with the periodic refetch disabled.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  fetchRejectedCveFeed,
  loadPersistedNvdRejectedCache,
  runNvdRejectedFeedTick,
  __testing,
} from "./nvd-rejected-feed-scheduler";
import { lookupNvdStatus, clearNvdCache } from "./pre-filters/cve-validation";
import { runPreFilters } from "./pre-filters";

const ORIGINAL_ENABLED = process.env.NVD_REJECTED_FEED_ENABLED;
const ORIGINAL_CACHE_PATH = process.env.NVD_REJECTED_CACHE_PATH;

let tmpDir = "";
let cachePath = "";

beforeEach(async () => {
  clearNvdCache();
  __testing.resetSchedulerStatus();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "nvd-rejected-"));
  cachePath = path.join(tmpDir, "nvd-rejected.json");
  process.env.NVD_REJECTED_CACHE_PATH = cachePath;
  delete process.env.NVD_REJECTED_FEED_ENABLED;
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  if (ORIGINAL_ENABLED === undefined) {
    delete process.env.NVD_REJECTED_FEED_ENABLED;
  } else {
    process.env.NVD_REJECTED_FEED_ENABLED = ORIGINAL_ENABLED;
  }
  if (ORIGINAL_CACHE_PATH === undefined) {
    delete process.env.NVD_REJECTED_CACHE_PATH;
  } else {
    process.env.NVD_REJECTED_CACHE_PATH = ORIGINAL_CACHE_PATH;
  }
});

function makeNvdResponse(
  ids: string[],
  opts: { startIndex: number; resultsPerPage: number; totalResults: number },
) {
  return {
    kind: "ok" as const,
    attempts: 1,
    value: {
      async json() {
        return {
          startIndex: opts.startIndex,
          resultsPerPage: opts.resultsPerPage,
          totalResults: opts.totalResults,
          vulnerabilities: ids.map((id) => ({
            cve: { id, vulnStatus: "Rejected" },
          })),
        };
      },
    } as unknown as Response,
  };
}

describe("fetchRejectedCveFeed", () => {
  it("pages through the NVD feed until totalResults is reached and dedupes", async () => {
    const pageSize = 2;
    const calls: string[] = [];
    const fakeFetch = vi.fn(async (opts: { url: string }) => {
      calls.push(opts.url);
      if (opts.url.includes("startIndex=0")) {
        return makeNvdResponse(["CVE-2025-1", "CVE-2025-2"], {
          startIndex: 0,
          resultsPerPage: pageSize,
          totalResults: 3,
        });
      }
      if (opts.url.includes("startIndex=2")) {
        return makeNvdResponse(["CVE-2025-2", "CVE-2025-3"], {
          startIndex: 2,
          resultsPerPage: pageSize,
          totalResults: 3,
        });
      }
      throw new Error("unexpected url: " + opts.url);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ids = await fetchRejectedCveFeed({ pageSize, fetch: fakeFetch as any });
    expect(ids).toEqual(["CVE-2025-1", "CVE-2025-2", "CVE-2025-3"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("startIndex=0");
    expect(calls[1]).toContain("startIndex=2");
    // The noRejected=false flag is what makes NVD include rejected rows
    // in the response — drop it and this whole module silently goes dark.
    expect(calls[0]).toContain("noRejected=false");
  });

  it("ignores non-rejected entries that sneak into the response", async () => {
    const fakeFetch = vi.fn(async () => ({
      kind: "ok" as const,
      attempts: 1,
      value: {
        async json() {
          return {
            startIndex: 0,
            resultsPerPage: 3,
            totalResults: 3,
            vulnerabilities: [
              { cve: { id: "CVE-2025-1", vulnStatus: "Rejected" } },
              { cve: { id: "CVE-2025-2", vulnStatus: "Analyzed" } },
              { cve: { id: "CVE-2025-3", vulnStatus: "Rejected" } },
            ],
          };
        },
      } as unknown as Response,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ids = await fetchRejectedCveFeed({ pageSize: 10, fetch: fakeFetch as any });
    expect(ids).toEqual(["CVE-2025-1", "CVE-2025-3"]);
  });

  it("throws on an upstream failure so the scheduler re-arms at the retry cadence", async () => {
    const fakeFetch = vi.fn(async () => ({
      kind: "unavailable" as const,
      reason: "network" as const,
      attempts: 4,
      detail: "ECONNRESET",
    }));
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchRejectedCveFeed({ pageSize: 10, fetch: fakeFetch as any }),
    ).rejects.toThrow(/upstream unavailable/);
  });

  it("throws (does not truncate) when totalResults exceeds maxPages × pageSize", async () => {
    // NVD has no server-side rejected-only filter, so we page the full
    // corpus client-side. The page cap MUST refuse to truncate — if a
    // future corpus grows past the configured cap, we want a loud
    // failure and a preserved previous cache, NOT a silently incomplete
    // snapshot.
    const pageSize = 10;
    const maxPages = 2;
    const totalResults = 1000;
    const fakeFetch = vi.fn(async (opts: { url: string }) => {
      const m = opts.url.match(/startIndex=(\d+)/);
      const startIndex = m ? Number.parseInt(m[1]!, 10) : 0;
      return makeNvdResponse(
        [`CVE-2025-${startIndex}`],
        { startIndex, resultsPerPage: pageSize, totalResults },
      );
    });
    await expect(
      fetchRejectedCveFeed({
        pageSize,
        maxPages,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fetch: fakeFetch as any,
      }),
    ).rejects.toThrow(/page cap exhausted/);
    expect(fakeFetch).toHaveBeenCalledTimes(maxPages);
  });
});

describe("runNvdRejectedFeedTick", () => {
  it("is a no-op when the scheduler is disabled (never touches disk or the cache)", async () => {
    const fakeFetch = vi.fn();
    const result = await runNvdRejectedFeedTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetch: fakeFetch as any,
      cachePath,
    });
    expect(result).toEqual({ ok: true, ranTick: false });
    expect(fakeFetch).not.toHaveBeenCalled();
    await expect(fs.stat(cachePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("primes the in-process cache and writes the persisted file on a successful tick", async () => {
    process.env.NVD_REJECTED_FEED_ENABLED = "1";
    const fakeFetch = vi.fn(async () =>
      makeNvdResponse(["CVE-2025-99999", "CVE-2024-12345"], {
        startIndex: 0,
        resultsPerPage: 2000,
        totalResults: 2,
      }),
    );
    const result = await runNvdRejectedFeedTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetch: fakeFetch as any,
      cachePath,
    });
    expect(result.ok).toBe(true);
    expect(result.ranTick).toBe(true);
    expect(result.count).toBe(2);
    expect(lookupNvdStatus("CVE-2025-99999")).toBe("REJECT");
    expect(lookupNvdStatus("CVE-2024-12345")).toBe("REJECT");

    const written = JSON.parse(await fs.readFile(cachePath, "utf-8")) as {
      cves: string[];
      fetchedAt: string;
    };
    expect(written.cves).toEqual(["CVE-2024-12345", "CVE-2025-99999"]);
    expect(typeof written.fetchedAt).toBe("string");
    expect(Number.isFinite(Date.parse(written.fetchedAt))).toBe(true);
  });

  it("returns ok=false (not throw) when the feed fetcher blows up so the scheduler retries", async () => {
    process.env.NVD_REJECTED_FEED_ENABLED = "1";
    const fakeFetch = vi.fn(async () => ({
      kind: "unavailable" as const,
      reason: "timeout" as const,
      attempts: 4,
      detail: "deadline exceeded",
    }));
    const result = await runNvdRejectedFeedTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetch: fakeFetch as any,
      cachePath,
    });
    expect(result).toEqual({ ok: false, ranTick: true });
    // A failed tick must NOT overwrite the persisted cache — that's
    // the whole point of "skip a tick rather than mix partial pages".
    await expect(fs.stat(cachePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("loadPersistedNvdRejectedCache", () => {
  it("returns { loaded: 0 } and never throws when the file is missing", async () => {
    const result = await loadPersistedNvdRejectedCache(cachePath);
    expect(result).toEqual({ loaded: 0, fetchedAt: null });
  });

  it("returns { loaded: 0 } and never throws when the file is unparseable", async () => {
    await fs.writeFile(cachePath, "this is not json{");
    const result = await loadPersistedNvdRejectedCache(cachePath);
    expect(result.loaded).toBe(0);
  });

  it("primes the pre-filter cache from a well-formed persisted file (rr-153 path)", async () => {
    await __testing.writePersistedRejectedCache(cachePath, [
      "CVE-2025-99999",
      "CVE-2023-44444",
    ]);
    const result = await loadPersistedNvdRejectedCache(cachePath);
    expect(result.loaded).toBe(2);
    expect(result.fetchedAt).not.toBeNull();
    expect(lookupNvdStatus("CVE-2025-99999")).toBe("REJECT");
    expect(lookupNvdStatus("CVE-2023-44444")).toBe("REJECT");
  });

  it("integration: rr-153 quarantines via `rejected_cve` once the persisted cache is loaded", async () => {
    // End-to-end pin of the task #1335 contract: with the persisted
    // cache loaded, the pre-filter pipeline must surface
    // `rejected_cve` (not just any CVE flag) on a report referencing
    // a known-rejected id. Without the cache load this fires only
    // `format`/`future_year` flags; with the cache load `rejected_cve`
    // joins them and rr-153 becomes a deterministic HIT in the smoke.
    await __testing.writePersistedRejectedCache(cachePath, ["CVE-2025-99999"]);
    // Simulate a fresh boot — the in-memory map is empty until the
    // loader runs.
    clearNvdCache();
    const rr153Text =
      "# Heap-buffer-overflow in libfoo (CVE-2025-99999)\n\n" +
      "Severity: Critical. Reproducer attached separately.";
    const before = runPreFilters({ rawText: rr153Text });
    expect(before.flags).not.toContain("rejected_cve");

    const result = await loadPersistedNvdRejectedCache(cachePath);
    expect(result.loaded).toBe(1);

    const after = runPreFilters({ rawText: rr153Text });
    expect(after.flags).toContain("rejected_cve");
    expect(after.shouldQuarantine).toBe(true);
  });

  it("round-trips through the tick → load path so a fresh boot picks up the previous fetch", async () => {
    process.env.NVD_REJECTED_FEED_ENABLED = "1";
    const fakeFetch = vi.fn(async () =>
      makeNvdResponse(["CVE-2025-99999"], {
        startIndex: 0,
        resultsPerPage: 2000,
        totalResults: 1,
      }),
    );
    await runNvdRejectedFeedTick({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetch: fakeFetch as any,
      cachePath,
    });
    // Simulate a process restart by dropping the in-memory map and
    // re-loading exclusively from disk.
    clearNvdCache();
    expect(lookupNvdStatus("CVE-2025-99999")).toBeNull();
    const result = await loadPersistedNvdRejectedCache(cachePath);
    expect(result.loaded).toBe(1);
    expect(lookupNvdStatus("CVE-2025-99999")).toBe("REJECT");
  });
});
