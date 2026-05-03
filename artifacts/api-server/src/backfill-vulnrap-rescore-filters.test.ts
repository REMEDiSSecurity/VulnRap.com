// Integration tests for the rescore-mode SQL filters built by
// `buildRescoreCandidateFilters` in backfill-vulnrap-helpers.ts.
//
// These run against a real Postgres database (DATABASE_URL must be set)
// because the predicates exercise jsonb-specific SQL — `EXISTS`,
// `jsonb_array_elements`, and `coalesce(..., '[]'::jsonb)` — that the
// existing fake-DB harness in routes/reports.feed-fabricated.test.ts
// cannot evaluate. A regression that drops the coalesce, swaps `LIKE
// 'hallucination_%'` for the wrong prefix, or flips the `--rescore`
// branch would still pass mock-DB tests; only this real-DB run catches
// it.
//
// Isolation: each run creates a unique schema (`test_backfill_<rand>`),
// creates a `reports` table inside it that mirrors the columns the
// SELECT touches, and binds a dedicated drizzle client whose
// `search_path` resolves the unqualified `reports` identifier to that
// schema. The schema (and therefore the test table) is dropped in
// afterAll, so concurrent runs against the shared dev database do not
// collide and no public-schema rows are touched.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, asc, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool, reportsTable } from "@workspace/db";
import { buildRescoreCandidateFilters } from "./backfill-vulnrap-helpers";

// A pg PoolClient checked out for the lifetime of the suite. We pin a
// single client (rather than using the shared pool) so the
// `SET search_path` we issue in beforeAll persists across every query
// drizzle runs. Releasing it in afterAll returns it to the shared pool
// for other tests.
//
// We wrap `pool.connect()` in a no-arg helper so TypeScript picks the
// `connect(): Promise<PoolClient>` overload (rather than the callback
// variant whose return type is `void`, which is what `ReturnType<typeof
// pool.connect>` resolves to). That keeps `pg` out of api-server's
// direct devDependencies — we never import `PoolClient` by name.
async function checkoutClient() {
  return await pool.connect();
}
type PoolClient = Awaited<ReturnType<typeof checkoutClient>>;
let client: PoolClient;
let testSchema: string;
// `testDb` is inferred via a no-arg helper so its `$client` type is the
// PoolClient overload (not the default `Pool`); the bare
// `ReturnType<typeof drizzle>` would force `$client: Pool` and fail to
// assign.
function buildTestDb(c: PoolClient) {
  return drizzle({ client: c, schema: { reportsTable } });
}
let testDb: ReturnType<typeof buildTestDb>;

// IDs assigned by Postgres for each seeded row. Captured in beforeAll so
// individual test cases can assert exact id sets without depending on
// serial-sequence state in the test schema.
const ids: {
  nullCompositeNullEvidence: number;
  nullCompositeHallucinationEvidence: number;
  nullCompositeOtherEvidence: number;
  scoredNullEvidence: number;
  scoredHallucinationEvidence: number;
  scoredOtherEvidence: number;
} = {
  nullCompositeNullEvidence: 0,
  nullCompositeHallucinationEvidence: 0,
  nullCompositeOtherEvidence: 0,
  scoredNullEvidence: 0,
  scoredHallucinationEvidence: 0,
  scoredOtherEvidence: 0,
};

beforeAll(async () => {
  client = await checkoutClient();
  // Random suffix keeps parallel test runs (CI matrix, local watch mode,
  // or two devs sharing a database) from clobbering each other.
  const suffix = Math.random().toString(36).slice(2, 10);
  testSchema = `test_backfill_${suffix}`;
  await client.query(`CREATE SCHEMA "${testSchema}"`);
  // search_path puts the test schema first so drizzle's bare `reports`
  // identifier resolves to our table, not the production one in public.
  await client.query(`SET search_path TO "${testSchema}", public`);

  // Minimal `reports` table — only the columns the SELECT under test
  // reads (id, vulnrap_composite_score, evidence) plus the NOT-NULL
  // columns drizzle's reportsTable definition would otherwise complain
  // about if we ever extended this test to do a drizzle insert. We do
  // raw INSERTs here so most NOT-NULL columns can stay omitted; only
  // the ones without a default need to be filled in.
  await client.query(`
    CREATE TABLE "${testSchema}"."reports" (
      "id" serial PRIMARY KEY NOT NULL,
      "content_hash" varchar(64) NOT NULL,
      "simhash" varchar(128) NOT NULL,
      "minhash_signature" jsonb NOT NULL,
      "file_size" integer NOT NULL,
      "vulnrap_composite_score" integer,
      "evidence" jsonb DEFAULT '[]'::jsonb
    )
  `);

  testDb = buildTestDb(client);

  async function insertRow(
    label: string,
    compositeScore: number | null,
    evidence: unknown,
  ): Promise<number> {
    // evidence is passed as-is (including JS `null`) so we can
    // distinguish "NULL evidence column" from "empty array"; the latter
    // would not exercise the coalesce path.
    const result = await client.query<{ id: number }>(
      `INSERT INTO "${testSchema}"."reports"
        (content_hash, simhash, minhash_signature, file_size,
         vulnrap_composite_score, evidence)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb)
       RETURNING id`,
      [
        `hash-${label}`,
        "0",
        "[]",
        0,
        compositeScore,
        evidence === null ? null : JSON.stringify(evidence),
      ],
    );
    return result.rows[0]!.id;
  }

  // Six combinations along two axes:
  //   (composite IS NULL vs already scored) × (NULL evidence vs
  //   evidence with a hallucination_* type vs evidence without one).
  // Together they cover every branch of the helper's predicate.
  ids.nullCompositeNullEvidence = await insertRow(
    "null-composite-null-evidence",
    null,
    null,
  );
  ids.nullCompositeHallucinationEvidence = await insertRow(
    "null-composite-hallucination",
    null,
    [{ type: "hallucination_invented_reference", weight: 25 }],
  );
  ids.nullCompositeOtherEvidence = await insertRow(
    "null-composite-other",
    null,
    [{ type: "low_quality_marker", weight: 5 }],
  );
  ids.scoredNullEvidence = await insertRow("scored-null-evidence", 50, null);
  ids.scoredHallucinationEvidence = await insertRow(
    "scored-hallucination",
    40,
    [
      { type: "low_quality_marker", weight: 5 },
      { type: "hallucination_phantom_citation", weight: 15 },
    ],
  );
  ids.scoredOtherEvidence = await insertRow(
    "scored-other",
    60,
    // Note: cannot use a value like "hallucinationFakeMatch" here as a
    // negative case — SQL LIKE treats `_` as a single-char wildcard, so
    // `hallucinationFakeMatch` actually MATCHES `'hallucination_%'`
    // (the `_` matches the `F`). That is the production behavior of
    // the predicate today and we intentionally do not assert against
    // it. The genuine negative case the predicate guarantees is that
    // the LIKE is anchored at the start of the string (no leading `%`),
    // so a value where `hallucination_` appears mid-string does NOT
    // match.
    [{ type: "x_hallucination_substring_marker", weight: 5 }],
  );
}, 30000);

afterAll(async () => {
  if (client) {
    try {
      await client.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
      // Reset search_path before returning the client to the pool so a
      // subsequent checkout (in a different test file or in production
      // code if this ever runs alongside the API server) starts clean.
      await client.query(`SET search_path TO public`);
    } finally {
      client.release();
    }
  }
});

async function selectCandidateIds(opts: {
  rescore: boolean;
  onlyWithCachedHallucination: boolean;
}): Promise<number[]> {
  const filters = buildRescoreCandidateFilters(opts);
  const rows = await testDb
    .select({ id: reportsTable.id })
    .from(reportsTable)
    .where(and(...filters))
    .orderBy(asc(reportsTable.id));
  return rows.map((r) => r.id);
}

describe("buildRescoreCandidateFilters — real-Postgres integration", () => {
  it("default scope (rescore=false, onlyWithCachedHallucination=false) returns every NULL-composite row regardless of evidence shape", async () => {
    const got = await selectCandidateIds({
      rescore: false,
      onlyWithCachedHallucination: false,
    });
    // Includes the NULL-evidence row — proving the coalesce keeps it
    // alive when the hallucination filter is off (the EXISTS predicate
    // is not even attached to the WHERE clause in this branch).
    expect(got).toEqual([
      ids.nullCompositeNullEvidence,
      ids.nullCompositeHallucinationEvidence,
      ids.nullCompositeOtherEvidence,
    ]);
  });

  it("--only-with-cached-hallucination narrows to NULL-composite rows whose evidence has a hallucination_* element", async () => {
    const got = await selectCandidateIds({
      rescore: false,
      onlyWithCachedHallucination: true,
    });
    // Only the NULL-composite row whose evidence carries a
    // `hallucination_*` type survives. The NULL-evidence row is
    // dropped (EXISTS over coalesce(NULL, '[]') yields false) — but
    // critically the query does not error out, which it would if the
    // coalesce were missing and `jsonb_array_elements(NULL)` ran.
    expect(got).toEqual([ids.nullCompositeHallucinationEvidence]);
  });

  it("--rescore alone returns every row including already-scored ones", async () => {
    const got = await selectCandidateIds({
      rescore: true,
      onlyWithCachedHallucination: false,
    });
    expect(got).toEqual([
      ids.nullCompositeNullEvidence,
      ids.nullCompositeHallucinationEvidence,
      ids.nullCompositeOtherEvidence,
      ids.scoredNullEvidence,
      ids.scoredHallucinationEvidence,
      ids.scoredOtherEvidence,
    ]);
  });

  it("--rescore + --only-with-cached-hallucination returns only rows with a hallucination_* evidence element, including already-scored ones", async () => {
    const got = await selectCandidateIds({
      rescore: true,
      onlyWithCachedHallucination: true,
    });
    expect(got).toEqual([
      ids.nullCompositeHallucinationEvidence,
      ids.scoredHallucinationEvidence,
    ]);
  });

  it("LIKE 'hallucination_%' is start-anchored: types where the prefix appears mid-string are excluded, and arbitrary unrelated types are excluded", async () => {
    // The scoredOtherEvidence row's evidence type is
    // `x_hallucination_substring_marker` — `hallucination_` appears in
    // the middle of the string but not at the start, so the
    // start-anchored LIKE must NOT match it. This guards against a
    // regression that adds a leading `%` to the pattern.
    //
    // The nullCompositeOtherEvidence row's type is `low_quality_marker`
    // — no `hallucination` substring at all, so it must also be
    // excluded. This guards against a regression that drops the LIKE
    // entirely (e.g. matches every non-empty evidence row).
    const got = await selectCandidateIds({
      rescore: true,
      onlyWithCachedHallucination: true,
    });
    expect(got).not.toContain(ids.scoredOtherEvidence);
    expect(got).not.toContain(ids.nullCompositeOtherEvidence);
  });

  it("NULL evidence is handled by coalesce and never throws under --only-with-cached-hallucination", async () => {
    // The two rows with evidence IS NULL must be excluded when
    // hallucination filtering is on, but the query itself must
    // succeed. A regression that drops the coalesce makes
    // jsonb_array_elements(NULL) raise and the entire SELECT errors.
    const got = await selectCandidateIds({
      rescore: true,
      onlyWithCachedHallucination: true,
    });
    expect(got).not.toContain(ids.nullCompositeNullEvidence);
    expect(got).not.toContain(ids.scoredNullEvidence);
  });

  it("emitted SQL contains the coalesce + LIKE 'hallucination_%' shape so a regression that rewrites either piece is caught at the source", async () => {
    // Belt-and-braces: render the predicate to a parameterized SQL
    // string and assert the two structural pieces the task spec calls
    // out (coalesce-over-evidence and the prefix-anchored LIKE) are
    // present. The behavioral assertions above already catch most
    // regressions; this guards against silent rewrites that happen to
    // be functionally equivalent on the seeded rows but drift from
    // the documented predicate shape.
    const filters = buildRescoreCandidateFilters({
      rescore: false,
      onlyWithCachedHallucination: true,
    });
    // drizzle's PgDialect renders `sql` template fragments to a
    // `{ sql, params }` shape; we go through testDb's dialect to keep
    // identifier quoting consistent with the live query path.
    const stmt = testDb
      .select()
      .from(reportsTable)
      .where(and(...filters))
      .toSQL();
    expect(stmt.sql.toLowerCase()).toContain("coalesce");
    expect(stmt.sql).toContain("'hallucination_%'");
    expect(stmt.sql.toLowerCase()).toContain("jsonb_array_elements");
  });
});
