import { integer, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const links = sqliteTable("links", {
  owner: text().notNull(),
  mode: text().notNull(),
  uuid: text().notNull(),
  player: text().notNull(),
}, table => [
  uniqueIndex("link_owner").on(table.owner, table.mode),
  uniqueIndex("link_uuid").on(table.uuid, table.mode),
]);

export const codes = sqliteTable("link_codes", {
  hash: text().primaryKey(),
  owner: text().notNull(),
  mode: text().notNull(),
  expires_at: integer().notNull(),
}, table => [uniqueIndex("code_owner").on(table.owner, table.mode)]);

export const orders = sqliteTable("micet_orders", {
  id: text().primaryKey(),
  owner: text().notNull(),
  uuid: text().notNull(),
  player: text().notNull(),
  sku: text().notNull(),
  mode: text().notNull(),
  status: text().notNull(),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
  detail: text(),
}, table => [uniqueIndex("order_product").on(table.owner, table.uuid, table.mode, table.sku)]);

export const jobs = sqliteTable("bridge_jobs", {
  id: text().primaryKey(),
  owner: text().notNull(),
  kind: text().notNull(),
  mode: text().notNull(),
  payload: text().notNull(),
  status: text().notNull(),
  created_at: integer().notNull(),
  expires_at: integer(),
  lease_until: integer(),
  lease: text(),
  result: text(),
}, table => [
  index("job_queue").on(table.mode, table.status, table.created_at),
  index("job_owner").on(table.owner, table.created_at),
]);

export const bridgeState = sqliteTable("bridge_state", {
  id: text().primaryKey(),
  seen_at: integer().notNull(),
});
