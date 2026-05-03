// Task #645 — Reviewer audit log.
//
// Append-only paper trail of every reviewer mutation that hits the API.
// Populated by the audit-log middleware mounted on the calibration and
// test-fixtures routers, surfaced read-only via GET /api/audit-log.
//
// `actor` is the best-effort identity of the caller, derived from (in
// priority order) the `reviewer` field on the JSON body, the
// `X-Reviewer-Name` header, or "anonymous" when neither is supplied.
// The reviewer token itself is never stored — only the fact of a
// successful (or failed) reviewer-gated mutation.
//
// `request_payload` carries the parsed JSON body with secret-shaped
// keys redacted (see middlewares/audit-log-middleware.ts). It is
// nullable because some endpoints accept multipart/form-data or no
// body at all.

import {
  pgTable,
  serial,
  varchar,
  jsonb,
  timestamp,
  integer,
  index,
} from "drizzle-orm/pg-core";

export const auditLogTable = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    actor: varchar("actor", { length: 200 }).notNull(),
    method: varchar("method", { length: 10 }).notNull(),
    endpoint: varchar("endpoint", { length: 500 }).notNull(),
    requestPayload: jsonb("request_payload").$type<unknown>(),
    queryParams: jsonb("query_params").$type<unknown>(),
    responseStatus: integer("response_status").notNull(),
    ip: varchar("ip", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_audit_log_created_at").on(table.createdAt),
    index("idx_audit_log_actor").on(table.actor),
    index("idx_audit_log_endpoint").on(table.endpoint),
  ],
);

export type AuditLogEntry = typeof auditLogTable.$inferSelect;
export type InsertAuditLogEntry = typeof auditLogTable.$inferInsert;
