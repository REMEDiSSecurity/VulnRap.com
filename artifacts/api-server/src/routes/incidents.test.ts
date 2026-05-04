// Task #1117 — Atomic write test for the incidents write path.
//
// incidents.ts exposes __testing.writeIncidentsFile which calls
// atomicWriteJsonFileSync directly. We use it here to verify that no
// .tmp sibling files survive a successful write — the same guarantee
// the route handler gets via atomicWriteJsonFileSync.

import os from "node:os";
import path from "node:path";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { __testing } from "./incidents";

describe("incidents __testing.writeIncidentsFile — no .tmp siblings (Task #1117)", () => {
  let tmpDir: string;
  let incidentsPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "incidents-atomic-"));
    incidentsPath = path.join(tmpDir, "incidents.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("leaves only the incidents file and no .tmp siblings after a successful write", () => {
    const data = {
      $comment: "Task #1117 atomic-write test",
      version: "1.0.0",
      incidents: [
        {
          id: "inc-atomic-001",
          date: "2026-05-04",
          duration: "2h",
          severity: "low",
          summary: "Atomic write probe.",
          rootCause: "Test only.",
          remediation: "None.",
        },
      ],
    };

    __testing.writeIncidentsFile(incidentsPath, data);

    const entries = readdirSync(tmpDir);
    expect(entries).toEqual(["incidents.json"]);

    const persisted = JSON.parse(readFileSync(incidentsPath, "utf8")) as {
      incidents: Array<{ id: string }>;
    };
    expect(persisted.incidents).toHaveLength(1);
    expect(persisted.incidents[0]!.id).toBe("inc-atomic-001");
  });

  it("leaves no .tmp siblings after multiple successive writes", () => {
    for (let i = 0; i < 4; i++) {
      __testing.writeIncidentsFile(incidentsPath, {
        version: `1.0.${i}`,
        incidents: [],
      });
    }
    const entries = readdirSync(tmpDir);
    expect(entries).toEqual(["incidents.json"]);
  });
});
