// Curated barrel for `@workspace/api-zod`.
//
// Orval generates two parallel sets of declarations off the same
// OpenAPI schemas:
//   - `./generated/api` — runtime zod schemas (e.g. `export const
//     ApplyCalibrationBody = zod.object({...})`).
//   - `./generated/types` — TypeScript-only interfaces, some of which
//     share names with the zod schemas (e.g. `export interface
//     ApplyCalibrationBody { ... }`).
// A naive `export *` from both modules collides on the shared names
// (TS2308 ambiguity) — even `export type *` for the second wildcard
// doesn't fix it because TS can't merge value+type pairs across
// distinct re-export sources via wildcards.
//
// The contract this barrel exposes:
//   1. `export *` from `./generated/api` — every consumer gets the
//      runtime zod schema under its natural name (e.g. `import {
//      SubmitFeedbackBody } from "@workspace/api-zod"` resolves to
//      the runtime schema for `.parse()` etc., which is what every
//      api-server route currently relies on).
//   2. Explicit `Type`-suffixed re-exports for the TS-only interfaces
//      whose names collide with a runtime schema. Consumers that need
//      the static interface side write `import { SubmitFeedbackBody
//      Type } from "@workspace/api-zod"`.
//
// Non-colliding TS interfaces from `./generated/types` are not
// re-exported here. The current api-server consumers only need
// runtime values; if a future consumer needs a type-only export that
// doesn't collide, add an explicit `export type { Foo } from "./
// generated/types/foo";` line below — do NOT add a wildcard re-export
// from `./generated/types`, that reintroduces the TS2308 errors. The
// orval config in `lib/api-spec/orval.config.ts` documents this same
// constraint.

export * from "./generated/api";

export type {
  ApplyCalibrationBody as ApplyCalibrationBodyType,
  CheckReportBody as CheckReportBodyType,
  DeleteReportBody as DeleteReportBodyType,
  DeleteReportResponse as DeleteReportResponseType,
  SubmitFeedbackBody as SubmitFeedbackBodyType,
  SubmitReportBody as SubmitReportBodyType,
} from "./generated/types";
