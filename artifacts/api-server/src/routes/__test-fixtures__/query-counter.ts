// Reusable query-budget harness for in-process route tests.
//
// The problem: every route test suite that wants to assert "this handler
// fires at most N db.select() calls" would otherwise need to duplicate the
// same counter / reset / wrap boilerplate. This file extracts that pattern
// into two composable pieces so any future test can opt in trivially.
//
// Usage (see reports.query-budget.test.ts for a complete example):
//
//   // 1. Create a counter at module level and bridge it across the vi.mock
//   //    hoisting boundary via globalThis (vi.mock factory is hoisted to the
//   //    top of the file, so it runs before module-level statements, but the
//   //    factory itself is called lazily — after module init — so globalThis
//   //    assignments made at module level are visible inside the factory).
//   const selectCounter = createSelectCounter();
//   (globalThis as any).__myCounter = selectCounter;
//
//   vi.mock("@workspace/db", async () => {
//     const c = (globalThis as any).__myCounter as SelectCounter;
//     const { db: raw, pool } = createInMemoryDb({ ... });
//     return { db: withSelectCounter(raw, c), pool, ... };
//   });
//
//   beforeEach(() => selectCounter.reset());
//
//   it("fires at most N selects", async () => {
//     await request("GET", "/api/reports/1");
//     expect(selectCounter.count).toBeLessThanOrEqual(N);
//   });

export interface SelectCounter {
  count: number;
  reset(): void;
}

export function createSelectCounter(): SelectCounter {
  const c: SelectCounter = {
    count: 0,
    reset() {
      c.count = 0;
    },
  };
  return c;
}

// Returns a new db object that is identical to `db` in every way, except
// that every call to `db.select(...)` also increments `counter.count`.
// All other methods (insert, transaction, execute) pass through unchanged.
//
// The spread + override pattern (instead of a Proxy) keeps the object
// shape transparent to vitest's vi.mock and avoids any Proxy-related
// compatibility surprises with drizzle's chain inspection.
export function withSelectCounter(
  db: Record<string, unknown>,
  counter: SelectCounter,
): Record<string, unknown> {
  const origSelect = db.select as (...args: unknown[]) => unknown;
  return {
    ...db,
    select(...args: unknown[]) {
      counter.count++;
      return origSelect(...args);
    },
  };
}
