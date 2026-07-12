import { pgTable, serial, bigint, varchar, text, timestamp, integer, numeric, unique } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  telegramId: bigint("telegram_id", { mode: "bigint" }).notNull().unique(),
  username: varchar("username", { length: 255 }),
  encryptedPrivateKey: text("encrypted_private_key").notNull(),
  publicKey: varchar("public_key", { length: 44 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const markets = pgTable("markets", {
  id: serial("id").primaryKey(),
  groupId: bigint("group_id", { mode: "bigint" }).notNull(),
  creatorId: bigint("creator_id", { mode: "bigint" }).notNull(),
  // nullable: set after fixture is selected from TxLINE
  question: text("question"),
  minBet: numeric("min_bet", { precision: 18, scale: 9 }).notNull().default("0.01"),
  deadline: timestamp("deadline"),
  startTime: timestamp("start_time"),
  // nullable: generated after fixture is selected
  marketPublicKey: varchar("market_public_key", { length: 44 }),
  marketEncryptedPrivateKey: text("market_encrypted_private_key"),
  // links this market to a TxLINE fixture for auto-resolution
  fixtureId: integer("fixture_id"),
  // market type: winner, over_under_goals, both_score, clean_sheet, ht_winner, over_under_corners, over_under_cards
  marketType: varchar("market_type", { length: 30 }).notNull().default("winner"),
  // threshold for over/under markets (e.g. 2 means "more than 2")
  threshold: numeric("threshold", { precision: 10, scale: 1 }),
  // for clean_sheet: which team (1 = home, 2 = away)
  targetTeam: integer("target_team"),
  // draft → fixture_selected → open → closed → resolved
  status: varchar("status", { length: 20 }).notNull().default("open"),
  winningSide: varchar("winning_side", { length: 3 }),
  messageId: integer("message_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const bets = pgTable("bets", {
  id: serial("id").primaryKey(),
  marketId: integer("market_id").notNull().references(() => markets.id),
  userId: bigint("user_id", { mode: "bigint" }).notNull(),
  side: varchar("side", { length: 3 }).notNull(),
  amount: numeric("amount", { precision: 18, scale: 9 }).notNull(),
  txSignature: varchar("tx_signature", { length: 128 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  unique("unique_bet_per_user_per_market").on(table.marketId, table.userId),
]);
