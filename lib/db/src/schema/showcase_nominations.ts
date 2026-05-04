import {
  pgTable,
  serial,
  integer,
  varchar,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

export const showcaseNominationsTable = pgTable(
  "showcase_nominations",
  {
    id: serial("id").primaryKey(),
    reportId: integer("report_id").notNull(),
    reason: text("reason").notNull(),
    email: varchar("email", { length: 320 }),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    ipHmac: varchar("ip_hmac", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_showcase_nominations_status_created_at").on(
      table.status,
      table.createdAt,
    ),
    index("idx_showcase_nominations_ip_hmac_created_at").on(
      table.ipHmac,
      table.createdAt,
    ),
    index("idx_showcase_nominations_report_id").on(table.reportId),
  ],
);

export type ShowcaseNomination =
  typeof showcaseNominationsTable.$inferSelect;
export type InsertShowcaseNomination =
  typeof showcaseNominationsTable.$inferInsert;
