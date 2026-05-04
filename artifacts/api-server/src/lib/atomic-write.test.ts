// Tests for the shared atomicWriteJsonFileSync helper.

import os from "node:os";
import path from "node:path";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { atomicWriteJsonFileSync } from "./atomic-write";

describe("atomicWriteJsonFileSync", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "atomic-write-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes valid JSON to the target path", () => {
    const filePath = path.join(tmpDir, "out.json");
    atomicWriteJsonFileSync(filePath, { hello: "world", n: 42 });
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    expect(parsed).toEqual({ hello: "world", n: 42 });
  });

  it("leaves no .tmp sibling after a successful write", () => {
    const filePath = path.join(tmpDir, "state.json");
    atomicWriteJsonFileSync(filePath, { a: 1 });
    const entries = readdirSync(tmpDir);
    expect(entries).toEqual(["state.json"]);
  });

  it("leaves no .tmp siblings after multiple successive writes", () => {
    const filePath = path.join(tmpDir, "state.json");
    for (let i = 0; i < 5; i++) {
      atomicWriteJsonFileSync(filePath, { i });
    }
    const entries = readdirSync(tmpDir);
    expect(entries).toEqual(["state.json"]);
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { i: number };
    expect(parsed.i).toBe(4);
  });

  it("creates the parent directory if it does not exist", () => {
    const nested = path.join(tmpDir, "a", "b", "c");
    const filePath = path.join(nested, "data.json");
    atomicWriteJsonFileSync(filePath, { ok: true });
    expect(existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    expect(parsed).toEqual({ ok: true });
    const entries = readdirSync(nested);
    expect(entries).toEqual(["data.json"]);
  });

  it("overwrites an existing file atomically", () => {
    const filePath = path.join(tmpDir, "state.json");
    atomicWriteJsonFileSync(filePath, { v: 1 });
    atomicWriteJsonFileSync(filePath, { v: 2 });
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { v: number };
    expect(parsed.v).toBe(2);
    const entries = readdirSync(tmpDir);
    expect(entries).toEqual(["state.json"]);
  });

  it("serializes with 2-space indentation and a trailing newline", () => {
    const filePath = path.join(tmpDir, "pretty.json");
    atomicWriteJsonFileSync(filePath, { x: 1 });
    const raw = readFileSync(filePath, "utf8");
    expect(raw).toBe('{\n  "x": 1\n}\n');
  });
});
