// Self-contained tests for parseReportId. Run with `node parse-report-id.test.js`.
import { strict as assert } from "node:assert";
import { parseReportId } from "./parse-report-id.js";

const cases = [
  // [input, expected]
  // Decimal ids from the URL.
  ["1234", "1234"],
  ["#1234", "1234"],
  ["  1234  ", "1234"],
  ["16", "16"],

  // Prefixed report codes (canonical form).
  ["VR-000B", "11"],
  ["vr-000b", "11"],
  ["vr_000b", "11"],
  ["VR-0010", "16"],
  ["VR-1", "1"],
  ["VR-FFFFFFFF", "4294967295"],

  // Bare report codes — leading zero or hex letter unambiguously identifies them.
  ["000B", "11"],
  ["0010", "16"], // numeric-only bare code; reviewer-flagged case
  ["00FF", "255"],
  ["abcd", "43981"],

  // Junk / empty / out-of-shape inputs.
  ["", null],
  ["   ", null],
  ["0", null],
  ["VR-", null],
  ["VR-000000000", null], // > 8 hex chars
  ["abc xyz", null],
  ["https://vulnrap.com/results/1234", null],
];

let failed = 0;
for (const [input, expected] of cases) {
  const actual = parseReportId(input);
  try {
    assert.equal(actual, expected);
    console.log(`ok  ${JSON.stringify(input)} -> ${JSON.stringify(actual)}`);
  } catch {
    failed += 1;
    console.error(
      `FAIL ${JSON.stringify(input)}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} tests passed`);
