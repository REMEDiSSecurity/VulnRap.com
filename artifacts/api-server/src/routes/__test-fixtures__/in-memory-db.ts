// Shared in-memory database harness used by the report-route test suites
// (`reports.privacy.test.ts`, `reports.diagnostics.test.ts`).
//
// Both suites swap `@workspace/db` for a hand-rolled drizzle stand-in so they
// can exercise the real Express routes without a live Postgres. Keeping that
// stand-in in two places caused Task #265: a mock that drifted in only one
// suite (missing `analysisTracesTable`, an out-of-date `TriageRecommendation`
// shape, an inverted `showInFeed` default) silently flipped 200-path tests to
// 500. Centralising the chain implementation, the default report row, and the
// table-registry pattern means the next route addition only needs one edit.
//
// What lives here:
//   - `BASE_REPORT` / `seedReport(state, overrides)` — the canonical default
//     row that satisfies `reportsTable` and the route's response zod schemas.
//   - `drizzleOrmOverrides` — the `eq`/`or`/`and`/`desc`/`gte`/`isNotNull`/
//     `sql` shims that the in-memory db inspects via `__op` tags.
//   - `createInMemoryDb({ schema, tables, transactionMode })` — wires up the
//     drizzle-shaped chain (select/from/where/limit/orderBy/innerJoin/
//     leftJoin/groupBy + insert/values/.returning/.onConflictDoUpdate) over
//     a list of `TableSpec`s the suite registers.
//   - `makeReportsTableSpec` / `makeHashesTableSpec` /
//     `makeSimilaritiesTableSpec` / `makeStatsTableSpec` — ready-made table
//     handlers with the right insert + snapshot semantics for the four
//     tables both suites share. Suite-specific tables (privacy's
//     `userFeedback`, diagnostics' `analysisTraces`) are passed in inline.

export interface FakeRow extends Record<string, unknown> {}

export type Cond =
  | { __op: "eq"; col: unknown; val: unknown }
  | { __op: "or"; conds: Cond[] }
  | { __op: "and"; conds: Cond[] }
  | { __op: "desc"; col: unknown }
  | { __op: "gte"; col: unknown; val: unknown }
  | { __op: "isNotNull"; col: unknown }
  | { __op: "inArray"; col: unknown; vals: unknown[] }
  | { __op: "sql_fragment" }
  | null
  | undefined;

// Drop-in replacements for the drizzle-orm helpers the routes call. Each one
// returns a tagged object so `applyCond` (below) can inspect the operator
// without depending on drizzle's real SQL builder. Suites spread these into
// `vi.mock("drizzle-orm", ...)` alongside `vi.importActual(...)` so any
// non-overridden export (e.g. `relations`) keeps its real implementation.
export const drizzleOrmOverrides = {
  eq: (col: unknown, val: unknown) => ({ __op: "eq", col, val }),
  or: (...conds: unknown[]) => ({ __op: "or", conds }),
  and: (...conds: unknown[]) => ({ __op: "and", conds }),
  desc: (col: unknown) => ({ __op: "desc", col }),
  gte: (col: unknown, val: unknown) => ({ __op: "gte", col, val }),
  isNotNull: (col: unknown) => ({ __op: "isNotNull", col }),
  inArray: (col: unknown, vals: unknown[]) => ({ __op: "inArray", col, vals }),
  sql: Object.assign(
    (_strings: TemplateStringsArray) => ({ __op: "sql_fragment" }),
    { mapWith: () => ({ __op: "sql_mapped" }) },
  ),
};

// Defaults for a stored report row. Mirrors the columns on `reportsTable`
// that the read-side route handlers spread into their response and that the
// response zod schemas validate. Keeping every nullable column present (even
// at `null`) avoids silent `undefined`-vs-`null` drift between the in-memory
// fixture and a real Postgres row.
//
// Per-test overrides flow through `seedReport(state, overrides)`; tests that
// need extra fields (`vulnrapEngineResults`, an AVRI block, etc.) override
// them at call time.
export const BASE_REPORT: FakeRow = {
  deleteToken: "tok",
  contentHash: "hash",
  simhash: "0",
  minhashSignature: [],
  lshBuckets: [],
  contentText: null,
  redactedText: null,
  contentMode: "full",
  slopScore: 50,
  slopTier: "Questionable",
  qualityScore: 50,
  confidence: 0.5,
  breakdown: {},
  evidence: [],
  similarityMatches: [],
  sectionHashes: {},
  sectionMatches: [],
  redactionSummary: { totalRedactions: 0, categories: {} },
  feedback: [],
  llmSlopScore: null,
  llmFeedback: null,
  llmBreakdown: null,
  authenticityScore: 0,
  validityScore: 0,
  quadrant: "WEAK_HUMAN",
  archetype: "REQUEST_DETAILS",
  humanIndicators: [],
  templateHash: null,
  vulnrapCompositeScore: null,
  vulnrapCompositeLabel: null,
  vulnrapEngineResults: null,
  vulnrapOverridesApplied: null,
  vulnrapCorrelationId: null,
  vulnrapDurationMs: null,
  fileName: null,
  fileSize: 0,
  // Task #265: the public read routes filter on `showInFeed` and 404 hidden
  // reports. Default to visible so the happy-path tests don't all have to
  // remember to flip it; the privacy suite explicitly passes `false` to
  // exercise the hidden-report 404 path.
  showInFeed: true,
};

// Minimum state shape the helper relies on for `reportsTable`: a row list
// plus an auto-incrementing primary key. Suite-specific state extends this
// with whatever extra tables the suite needs (e.g. `feedback`, `traces`).
export interface BaseDbState {
  reports: FakeRow[];
  hashes: FakeRow[];
  similarities: FakeRow[];
  stats: Map<string, number>;
  nextReportId: number;
}

// One table registered with the harness. The harness uses `table` for
// identity-based lookup against the schema export; `getRows` feeds SELECT;
// `insert` performs INSERT (returning the row that should appear in
// `.returning()`, or `null` for fire-and-forget tables like stats).
//
// `snapshot` / `restore` are only consulted when `transactionMode` is
// `"snapshot"` — they let a table participate in transaction rollback
// (e.g. diagnostics' "rolls back the entire transaction when
// analysis_traces insert fails" regression test).
export interface TableSpec {
  table: unknown;
  getRows: () => FakeRow[];
  insert: (row: FakeRow) => FakeRow | null;
  snapshot?: () => unknown;
  restore?: (snap: unknown) => void;
}

export interface InMemoryDbOptions {
  schema: Record<string, unknown>;
  tables: TableSpec[];
  // - "passthrough": `db.transaction(fn)` invokes `fn(db)` directly with no
  //   rollback. Suitable for suites that only assert on top-level
  //   read/insert outcomes (privacy).
  // - "snapshot": every registered TableSpec's `snapshot()` is captured
  //   before `fn(db)` runs and `restore(snap)` is called on throw. Required
  //   for diagnostics' strict-mode trace-failure rollback test.
  transactionMode?: "passthrough" | "snapshot";
}

export interface InMemoryDb {
  db: Record<string, unknown>;
  pool: { end: () => Promise<undefined> };
}

export function createInMemoryDb(options: InMemoryDbOptions): InMemoryDb {
  const { tables, transactionMode = "passthrough" } = options;

  function findColName(table: Record<string, unknown>, col: unknown): string {
    for (const k of Object.keys(table)) {
      if (table[k] === col) return k;
    }
    return "__unknown__";
  }

  function applyCond(
    rows: FakeRow[],
    cond: Cond,
    table: Record<string, unknown>,
  ): FakeRow[] {
    if (!cond || typeof cond !== "object") return rows;
    const op = (cond as { __op?: string }).__op;
    if (op === "eq") {
      const c = cond as { col: unknown; val: unknown };
      const colName = findColName(table, c.col);
      if (colName === "__unknown__") return rows;
      // Column-to-column comparisons (e.g. JOIN ON a.id = b.aId) — when the
      // RHS resolves to a known column, filter on row[lhs] === row[rhs]
      // instead of row[lhs] === literal.
      const valColName = findColName(table, c.val);
      if (valColName !== "__unknown__") {
        return rows.filter((r) => r[colName] === r[valColName]);
      }
      return rows.filter((r) => r[colName] === c.val);
    }
    if (op === "or") {
      const c = cond as { conds: Cond[] };
      return rows.filter((r) =>
        c.conds.some((sub) => applyCond([r], sub, table).length > 0),
      );
    }
    if (op === "and") {
      const c = cond as { conds: Cond[] };
      return c.conds.reduce<FakeRow[]>(
        (acc, sub) => applyCond(acc, sub, table),
        rows,
      );
    }
    if (op === "inArray") {
      const c = cond as { col: unknown; vals: unknown[] };
      const colName = findColName(table, c.col);
      if (colName === "__unknown__") return rows;
      return rows.filter((r) => c.vals.includes(r[colName]));
    }
    // `gte`, `isNotNull`, `sql_fragment` and unknown ops fall through as
    // "no-op filter" — keeps the chain compatible with routes that emit
    // such conditions without forcing every test to model them.
    return rows;
  }

  function findTable(t: unknown): TableSpec | null {
    for (const spec of tables) if (spec.table === t) return spec;
    return null;
  }

  function getTableRows(t: unknown): FakeRow[] {
    const spec = findTable(t);
    return spec ? spec.getRows() : [];
  }

  function selectChain(): Record<string, unknown> {
    let cond: Cond = null;
    let limitN: number | null = null;
    let order: { col: string; dir: "asc" | "desc" } | null = null;
    let baseTable: Record<string, unknown> | null = null;
    let joined: { rows: FakeRow[]; schema: Record<string, unknown> } | null =
      null;

    const chain: Record<string, unknown> = {
      from(t: Record<string, unknown>) {
        baseTable = t;
        return chain;
      },
      where(c: Cond) {
        cond = c;
        return chain;
      },
      limit(n: number) {
        limitN = n;
        return chain;
      },
      orderBy(o: unknown) {
        if ((o as { __op?: string })?.__op === "desc") {
          const targetSchema = joined
            ? joined.schema
            : (baseTable as Record<string, unknown>);
          order = {
            col: findColName(targetSchema, (o as { col: unknown }).col),
            dir: "desc",
          };
        }
        return chain;
      },
      groupBy(_o: unknown) {
        return chain;
      },
      innerJoin(joinTable: unknown, joinCond: Cond) {
        const baseRows = getTableRows(baseTable);
        const joinRows = getTableRows(joinTable);
        const joinSchema = joinTable as Record<string, unknown>;
        const effectiveSchema = { ...baseTable!, ...joinSchema };
        const merged: FakeRow[] = [];
        for (const base of baseRows) {
          for (const jr of joinRows) {
            // `...jr` first, then `...base` so columns colliding by name
            // (e.g. both tables have `id`) resolve to the base table's value
            // — that matches what drizzle does when projecting unqualified
            // columns over a join.
            const combined = { ...jr, ...base };
            if (applyCond([combined], joinCond, effectiveSchema).length > 0) {
              merged.push(combined);
            }
          }
        }
        joined = { rows: merged, schema: effectiveSchema };
        return chain;
      },
      leftJoin(joinTable: unknown, joinCond: Cond) {
        const baseRows = getTableRows(baseTable);
        const joinRows = getTableRows(joinTable);
        const joinSchema = joinTable as Record<string, unknown>;
        const effectiveSchema = { ...baseTable!, ...joinSchema };
        const merged: FakeRow[] = [];
        for (const base of baseRows) {
          const matches: FakeRow[] = [];
          for (const jr of joinRows) {
            const combined = { ...jr, ...base };
            if (applyCond([combined], joinCond, effectiveSchema).length > 0) {
              matches.push(combined);
            }
          }
          merged.push(...(matches.length > 0 ? matches : [{ ...base }]));
        }
        joined = { rows: merged, schema: effectiveSchema };
        return chain;
      },
      then(resolve: (rows: FakeRow[]) => void, reject: (err: unknown) => void) {
        try {
          let rows = joined ? joined.rows : getTableRows(baseTable);
          const effectiveSchema = joined
            ? joined.schema
            : (baseTable as Record<string, unknown>);
          rows = applyCond(rows, cond, effectiveSchema);
          if (order) {
            const o = order;
            rows = [...rows].sort((a, b) => {
              const av = a[o.col] as number | string | Date;
              const bv = b[o.col] as number | string | Date;
              if (av < bv) return o.dir === "desc" ? 1 : -1;
              if (av > bv) return o.dir === "desc" ? -1 : 1;
              return 0;
            });
          }
          if (limitN != null) rows = rows.slice(0, limitN);
          resolve(rows);
        } catch (err) {
          reject(err);
        }
      },
    };
    return chain;
  }

  function doInsert(table: unknown, rows: FakeRow[]): FakeRow[] {
    const spec = findTable(table);
    if (!spec) return [];
    const inserted: FakeRow[] = [];
    for (const r of rows) {
      const result = spec.insert(r);
      if (result) inserted.push(result);
    }
    return inserted;
  }

  function snapshotAll(): unknown[] {
    return tables.map((t) => (t.snapshot ? t.snapshot() : null));
  }
  function restoreAll(snaps: unknown[]) {
    tables.forEach((t, i) => {
      if (t.restore) t.restore(snaps[i]);
    });
  }

  const db: Record<string, unknown> = {
    select(_proj?: unknown) {
      return {
        from(t: Record<string, unknown>) {
          const c = selectChain();
          (c.from as (t: unknown) => unknown)(t);
          return c;
        },
      };
    },
    insert(table: unknown) {
      return {
        values(input: FakeRow | FakeRow[]) {
          const inputs = Array.isArray(input) ? input : [input];
          const op: Record<string, unknown> = {
            returning() {
              return {
                then(
                  resolve: (rows: FakeRow[]) => void,
                  reject: (err: unknown) => void,
                ) {
                  try {
                    resolve(doInsert(table, inputs));
                  } catch (e) {
                    reject(e);
                  }
                },
              };
            },
            onConflictDoUpdate(_o: unknown) {
              return {
                then(
                  resolve: (v: undefined) => void,
                  reject: (err: unknown) => void,
                ) {
                  try {
                    // For stats-style upserts the registered TableSpec.insert
                    // handles "increment on conflict" — we just call it
                    // again. For other tables this collapses to a plain
                    // insert, which matches how the routes use the chain in
                    // tests.
                    doInsert(table, inputs);
                    resolve(undefined);
                  } catch (e) {
                    reject(e);
                  }
                },
              };
            },
            then(
              resolve: (v: undefined) => void,
              reject: (err: unknown) => void,
            ) {
              try {
                doInsert(table, inputs);
                resolve(undefined);
              } catch (e) {
                reject(e);
              }
            },
          };
          return op;
        },
      };
    },
    transaction:
      transactionMode === "snapshot"
        ? async (fn: (tx: Record<string, unknown>) => Promise<unknown>) => {
            const snap = snapshotAll();
            try {
              return await fn(db);
            } catch (err) {
              restoreAll(snap);
              throw err;
            }
          }
        : async (fn: (tx: Record<string, unknown>) => Promise<unknown>) =>
            fn(db),
  };

  return {
    db,
    pool: { end: async () => undefined },
  };
}

// Pre-built TableSpec for `reportsTable`. Adds an auto-incrementing `id` and
// `createdAt` on insert, and supports snapshot-mode rollback by restoring
// both the row list and the next-id counter.
export function makeReportsTableSpec(
  schema: Record<string, unknown>,
  state: BaseDbState,
): TableSpec {
  return {
    table: schema.reportsTable,
    getRows: () => state.reports,
    insert: (r) => {
      const row = {
        ...r,
        id: state.nextReportId++,
        createdAt: r.createdAt ?? new Date(),
      };
      state.reports.push(row);
      return row;
    },
    snapshot: () => ({
      rows: state.reports.map((r) => ({ ...r })),
      next: state.nextReportId,
    }),
    restore: (snap) => {
      const s = snap as { rows: FakeRow[]; next: number };
      state.reports = s.rows;
      state.nextReportId = s.next;
    },
  };
}

export function makeHashesTableSpec(
  schema: Record<string, unknown>,
  state: BaseDbState,
): TableSpec {
  return {
    table: schema.reportHashesTable,
    getRows: () => state.hashes,
    insert: (r) => {
      const row = { ...r };
      state.hashes.push(row);
      return row;
    },
    snapshot: () => state.hashes.map((r) => ({ ...r })),
    restore: (snap) => {
      state.hashes = snap as FakeRow[];
    },
  };
}

export function makeSimilaritiesTableSpec(
  schema: Record<string, unknown>,
  state: BaseDbState,
): TableSpec {
  return {
    table: schema.similarityResultsTable,
    getRows: () => state.similarities,
    insert: (r) => {
      const row = { ...r };
      state.similarities.push(row);
      return row;
    },
    snapshot: () => state.similarities.map((r) => ({ ...r })),
    restore: (snap) => {
      state.similarities = snap as FakeRow[];
    },
  };
}

// `reportStatsTable` is upsert-on-key: every "insert" with a `value` either
// initialises or increments the counter for that key. Returns `null` from
// `insert` because the routes never call `.returning()` on stats.
//
// `getRows` projects the Map back to row objects so any route that reads
// stats sees a consistent shape; the privacy and diagnostics tests don't
// currently assert on those reads but exposing them keeps future routes
// from silently seeing `[]`.
export function makeStatsTableSpec(
  schema: Record<string, unknown>,
  state: BaseDbState,
): TableSpec {
  return {
    table: schema.reportStatsTable,
    getRows: () =>
      Array.from(state.stats.entries()).map(([key, value]) => ({ key, value })),
    insert: (r) => {
      const key = r.key as string;
      const inc = typeof r.value === "number" ? r.value : 1;
      state.stats.set(key, (state.stats.get(key) ?? 0) + inc);
      return null;
    },
    snapshot: () => new Map(state.stats),
    restore: (snap) => {
      state.stats = snap as Map<string, number>;
    },
  };
}

// Reset the four shared tables back to the empty-state defaults. Suite-
// specific state (privacy's `feedback`, diagnostics' `traces` +
// `failTraceInsert`) is reset by the suite alongside this call.
export function resetBaseState(state: BaseDbState): void {
  state.reports = [];
  state.hashes = [];
  state.similarities = [];
  state.stats = new Map();
  state.nextReportId = 1;
}

// Seed a single report row using `BASE_REPORT` defaults. Returns the
// inserted row (with `id` and `createdAt` populated) so tests can reference
// the auto-assigned id when building URLs.
export function seedReport(
  state: BaseDbState,
  overrides: Partial<FakeRow> = {},
): FakeRow {
  const row: FakeRow = {
    ...BASE_REPORT,
    id: state.nextReportId++,
    createdAt: new Date(),
    ...overrides,
  };
  state.reports.push(row);
  return row;
}
