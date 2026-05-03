import { describe, it, expect, beforeEach } from "vitest";
import {
  createRemovalImpactCache,
  computeHandwavyActiveListVersion,
  type RemovalImpactCache,
} from "./handwavy-removal-impact-cache";

describe("computeHandwavyActiveListVersion", () => {
  it("returns a stable string for an empty list", () => {
    expect(computeHandwavyActiveListVersion([])).toBe("[]");
  });

  it("is order-insensitive — only the SET of phrases matters", () => {
    const a = computeHandwavyActiveListVersion([
      { phrase: "alpha" },
      { phrase: "beta" },
    ]);
    const b = computeHandwavyActiveListVersion([
      { phrase: "beta" },
      { phrase: "alpha" },
    ]);
    expect(a).toBe(b);
  });

  it("changes when a phrase is added", () => {
    const before = computeHandwavyActiveListVersion([{ phrase: "alpha" }]);
    const after = computeHandwavyActiveListVersion([
      { phrase: "alpha" },
      { phrase: "beta" },
    ]);
    expect(after).not.toBe(before);
  });

  it("changes when a phrase is removed", () => {
    const before = computeHandwavyActiveListVersion([
      { phrase: "alpha" },
      { phrase: "beta" },
    ]);
    const after = computeHandwavyActiveListVersion([{ phrase: "alpha" }]);
    expect(after).not.toBe(before);
  });

  it("changes when a phrase is renamed (set membership shifts)", () => {
    const before = computeHandwavyActiveListVersion([
      { phrase: "alpha" },
      { phrase: "beta" },
    ]);
    const after = computeHandwavyActiveListVersion([
      { phrase: "alpha" },
      { phrase: "gamma" },
    ]);
    expect(after).not.toBe(before);
  });

  it("phrases with quotes, NULs, or other tricky chars cannot collide between distinct lists", () => {
    const a = computeHandwavyActiveListVersion([{ phrase: 'alpha","beta' }]);
    const b = computeHandwavyActiveListVersion([
      { phrase: "alpha" },
      { phrase: "beta" },
    ]);
    const c = computeHandwavyActiveListVersion([{ phrase: "alpha\u0000beta" }]);
    const d = computeHandwavyActiveListVersion([
      { phrase: "alpha" },
      { phrase: "\u0000beta" },
    ]);
    expect(a).not.toBe(b);
    expect(c).not.toBe(d);
  });
});

describe("createRemovalImpactCache", () => {
  let cache: RemovalImpactCache;

  beforeEach(() => {
    cache = createRemovalImpactCache();
  });

  it("returns undefined on an empty cache", () => {
    expect(cache.get("foo", 2000, "v1")).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("returns the stored entry on a hit with a matching version", () => {
    cache.set("foo", 2000, "v1", { payload: "hello" }, "2026-04-30T00:00:00Z");
    const got = cache.get("foo", 2000, "v1");
    expect(got?.response).toEqual({ payload: "hello" });
    expect(got?.cachedAt).toBe("2026-04-30T00:00:00Z");
    expect(got?.version).toBe("v1");
  });

  it("treats different productionScanLimit values as distinct keys", () => {
    cache.set("foo", 2000, "v1", { payload: "limit-2k" });
    cache.set("foo", 5000, "v1", { payload: "limit-5k" });
    expect(cache.get("foo", 2000, "v1")?.response).toEqual({
      payload: "limit-2k",
    });
    expect(cache.get("foo", 5000, "v1")?.response).toEqual({
      payload: "limit-5k",
    });
  });

  it("treats different phrase strings as distinct keys", () => {
    cache.set("foo", 2000, "v1", { payload: "for-foo" });
    cache.set("bar", 2000, "v1", { payload: "for-bar" });
    expect(cache.get("foo", 2000, "v1")?.response).toEqual({
      payload: "for-foo",
    });
    expect(cache.get("bar", 2000, "v1")?.response).toEqual({
      payload: "for-bar",
    });
  });

  it("evicts a stale entry when the version no longer matches", () => {
    cache.set("foo", 2000, "v1", { payload: "old" });
    expect(cache.size()).toBe(1);
    expect(cache.get("foo", 2000, "v2")).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("invalidate() drops every entry", () => {
    cache.set("foo", 2000, "v1", { payload: "a" });
    cache.set("bar", 2000, "v1", { payload: "b" });
    expect(cache.size()).toBe(2);
    cache.invalidate();
    expect(cache.size()).toBe(0);
    expect(cache.get("foo", 2000, "v1")).toBeUndefined();
    expect(cache.get("bar", 2000, "v1")).toBeUndefined();
  });

  it("set() refreshes an existing entry in place", () => {
    cache.set("foo", 2000, "v1", { payload: "first" }, "2026-04-30T00:00:00Z");
    cache.set("foo", 2000, "v1", { payload: "second" }, "2026-04-30T00:01:00Z");
    expect(cache.size()).toBe(1);
    expect(cache.get("foo", 2000, "v1")?.response).toEqual({
      payload: "second",
    });
    expect(cache.get("foo", 2000, "v1")?.cachedAt).toBe("2026-04-30T00:01:00Z");
  });

  it("evicts least-recently-used entries when the 64-entry cap is exceeded", () => {
    for (let i = 0; i < 70; i++) {
      cache.set(`phrase-${i}`, 2000, "v1", { payload: `p${i}` });
    }
    expect(cache.size()).toBe(64);
    for (let i = 0; i < 6; i++) {
      expect(cache.get(`phrase-${i}`, 2000, "v1")).toBeUndefined();
    }
    for (let i = 6; i < 70; i++) {
      expect(cache.get(`phrase-${i}`, 2000, "v1")?.response).toEqual({
        payload: `p${i}`,
      });
    }
  });

  it("a get() touches the entry so it survives subsequent eviction pressure", () => {
    for (let i = 0; i < 64; i++) {
      cache.set(`p-${i}`, 2000, "v1", { payload: `p${i}` });
    }
    expect(cache.get("p-0", 2000, "v1")).not.toBeUndefined();
    cache.set("p-new", 2000, "v1", { payload: "new" });
    expect(cache.get("p-1", 2000, "v1")).toBeUndefined();
    expect(cache.get("p-0", 2000, "v1")?.response).toEqual({ payload: "p0" });
    expect(cache.get("p-new", 2000, "v1")?.response).toEqual({
      payload: "new",
    });
  });
});
