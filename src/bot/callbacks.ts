import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { CallbackQueryContext } from "grammy";
import { eq, and, count } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, markets, bets } from "../db/schema.js";
import { encrypt, decrypt } from "../utils/crypto.js";
import { generateKeypair, getBalance, transferSOL } from "../solana/wallet.js";
import { env } from "../env.js";
import { getFixtures, type Fixture } from "../txline/client.js";

// Market type definitions for display and question generation
const MARKET_TYPES = {
  winner: { label: "Match Winner", needsThreshold: false, needsTeam: false },
  over_under_goals: { label: "Over/Under Goals", needsThreshold: true, needsTeam: false },
  both_score: { label: "Both Teams Score", needsThreshold: false, needsTeam: false },
  clean_sheet: { label: "Clean Sheet", needsThreshold: false, needsTeam: true },
  ht_winner: { label: "Halftime Leader", needsThreshold: false, needsTeam: false },
  over_under_corners: { label: "Over/Under Corners", needsThreshold: true, needsTeam: false },
  over_under_cards: { label: "Over/Under Cards", needsThreshold: true, needsTeam: false },
} as const;

type MarketTypeKey = keyof typeof MARKET_TYPES;

// Threshold presets per market type
const THRESHOLD_OPTIONS: Record<string, number[]> = {
  over_under_goals: [1, 2, 3, 4, 5],
  over_under_corners: [7, 8, 9, 10, 11],
  over_under_cards: [2, 3, 4, 5, 6],
};

function buildQuestion(
  marketType: string,
  fixture: Fixture,
  threshold?: number | null,
  targetTeam?: number | null,
): string {
  const home = fixture.Participant1;
  const away = fixture.Participant2;
  switch (marketType) {
    case "winner": return `Will ${home} beat ${away}?`;
    case "over_under_goals": return `Will there be more than ${threshold} goals in ${home} vs ${away}?`;
    case "both_score": return `Will both ${home} and ${away} score?`;
    case "clean_sheet": {
      const team = (targetTeam ?? 1) === 1 ? home : away;
      return `Will ${team} keep a clean sheet vs ${(targetTeam ?? 1) === 1 ? away : home}?`;
    }
    case "ht_winner": return `Will ${home} be leading at halftime vs ${away}?`;
    case "over_under_corners": return `Will there be more than ${threshold} corners in ${home} vs ${away}?`;
    case "over_under_cards": return `Will there be more than ${threshold} yellow cards in ${home} vs ${away}?`;
    default: return `${home} vs ${away}`;
  }
}

export function registerCallbacks(bot: Bot) {
  // Step 1: User taps a fixture → show market type selection
  bot.callbackQuery(/^fix:(\d+):(\d+)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^fix:(\d+):(\d+)$/);
    if (!match) return;

    const draftMarketId = parseInt(match[1]!);
    const fixtureId = parseInt(match[2]!);

    const market = await db.query.markets.findFirst({
      where: eq(markets.id, draftMarketId),
    });

    if (!market || market.status !== "draft") {
      await ctx.answerCallbackQuery({ text: "This market has already been set up.", show_alert: true });
      return;
    }

    // Save the fixture ID on the draft so subsequent callbacks know the fixture
    await db.update(markets).set({ fixtureId, status: "fixture_selected" }).where(eq(markets.id, draftMarketId));

    // Show market type buttons
    const keyboard = new InlineKeyboard();
    for (const [key, def] of Object.entries(MARKET_TYPES)) {
      keyboard.row().text(def.label, `mtype:${draftMarketId}:${key}`);
    }

    // Fetch fixture name for display
    let fixtureName = "the selected match";
    try {
      const fixtures = await getFixtures();
      const f = fixtures.find((f) => f.FixtureId === fixtureId);
      if (f) fixtureName = `${f.Participant1} vs ${f.Participant2}`;
    } catch { /* use fallback name */ }

    await ctx.editMessageText(
      `<b>Market #${draftMarketId}</b>\n\n` +
      `Match: <b>${fixtureName}</b>\n\n` +
      `Select the market type:`,
      { parse_mode: "HTML", reply_markup: keyboard },
    );

    await ctx.answerCallbackQuery();
  });

  // Step 2: User picks a market type
  bot.callbackQuery(/^mtype:(\d+):(\w+)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^mtype:(\d+):(\w+)$/);
    if (!match) return;

    const marketId = parseInt(match[1]!);
    const marketType = match[2]! as MarketTypeKey;
    const typeDef = MARKET_TYPES[marketType];

    if (!typeDef) {
      await ctx.answerCallbackQuery({ text: "Unknown market type.", show_alert: true });
      return;
    }

    const market = await db.query.markets.findFirst({
      where: eq(markets.id, marketId),
    });

    if (!market || market.status !== "fixture_selected") {
      await ctx.answerCallbackQuery({ text: "This market has already been set up.", show_alert: true });
      return;
    }

    // If market type needs a threshold, show threshold options
    if (typeDef.needsThreshold) {
      const options = THRESHOLD_OPTIONS[marketType] ?? [1, 2, 3, 4, 5];
      const keyboard = new InlineKeyboard();
      for (const t of options) {
        keyboard.text(`More than ${t}`, `thresh:${marketId}:${marketType}:${t}`);
      }
      keyboard.row();

      await ctx.editMessageText(
        `<b>Market #${marketId}</b>\n\n` +
        `Type: <b>${typeDef.label}</b>\n\n` +
        `Pick the threshold:`,
        { parse_mode: "HTML", reply_markup: keyboard },
      );
      await ctx.answerCallbackQuery();
      return;
    }

    // If market type needs a team selection (clean_sheet)
    if (typeDef.needsTeam) {
      let fixture: Fixture | undefined;
      try {
        const fixtures = await getFixtures();
        fixture = fixtures.find((f) => f.FixtureId === market.fixtureId);
      } catch { /* fallback below */ }

      const homeName = fixture?.Participant1 ?? "Home Team";
      const awayName = fixture?.Participant2 ?? "Away Team";

      const keyboard = new InlineKeyboard()
        .text(homeName, `team:${marketId}:${marketType}:1`)
        .text(awayName, `team:${marketId}:${marketType}:2`);

      await ctx.editMessageText(
        `<b>Market #${marketId}</b>\n\n` +
        `Type: <b>${typeDef.label}</b>\n\n` +
        `Which team keeps a clean sheet?`,
        { parse_mode: "HTML", reply_markup: keyboard },
      );
      await ctx.answerCallbackQuery();
      return;
    }

    // No extra input needed — open the market directly
    await openMarket(ctx, marketId, marketType, null, null);
  });

  // Step 3a: User picks a threshold for over/under markets
  bot.callbackQuery(/^thresh:(\d+):(\w+):(\d+)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^thresh:(\d+):(\w+):(\d+)$/);
    if (!match) return;

    const marketId = parseInt(match[1]!);
    const marketType = match[2]!;
    const threshold = parseInt(match[3]!);

    await openMarket(ctx, marketId, marketType, threshold, null);
  });

  // Step 3b: User picks a team for clean_sheet
  bot.callbackQuery(/^team:(\d+):(\w+):(\d)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^team:(\d+):(\w+):(\d)$/);
    if (!match) return;

    const marketId = parseInt(match[1]!);
    const marketType = match[2]!;
    const targetTeam = parseInt(match[3]!);

    await openMarket(ctx, marketId, marketType, null, targetTeam);
  });

  // Shared function: finalize a draft market into an open market
  async function openMarket(
    ctx: CallbackQueryContext<Context>,
    marketId: number,
    marketType: string,
    threshold: number | null,
    targetTeam: number | null,
  ) {
    const market = await db.query.markets.findFirst({
      where: eq(markets.id, marketId),
    });

    if (!market || market.status !== "fixture_selected") {
      await ctx.answerCallbackQuery({ text: "This market has already been set up.", show_alert: true });
      return;
    }

    // Fetch fixture details
    let fixture: Fixture | undefined;
    try {
      const fixtures = await getFixtures();
      fixture = fixtures.find((f) => f.FixtureId === market.fixtureId);
    } catch (err) {
      console.error("Failed to fetch fixtures:", err);
      await ctx.answerCallbackQuery({ text: "Failed to load fixture. Try again.", show_alert: true });
      return;
    }

    if (!fixture) {
      await ctx.answerCallbackQuery({ text: "Fixture not found. Match may have started.", show_alert: true });
      return;
    }

    const { publicKey, secretKeyBase58 } = generateKeypair();
    const encryptedKey = encrypt(secretKeyBase58, env.ENCRYPTION_KEY);
    const question = buildQuestion(marketType, fixture, threshold, targetTeam);
    const messageId = ctx.callbackQuery.message?.message_id ?? null;

    await db.update(markets).set({
      question,
      marketType,
      threshold: threshold?.toString() ?? null,
      targetTeam,
      marketPublicKey: publicKey,
      marketEncryptedPrivateKey: encryptedKey,
      status: "open",
      messageId,
    }).where(eq(markets.id, marketId));

    const keyboard = new InlineKeyboard()
      .text("YES (0)", `bet:${marketId}:yes`)
      .text("NO (0)", `bet:${marketId}:no`);

    const matchDate = new Date(fixture.StartTime).toISOString().split("T")[0];
    const typeDef = MARKET_TYPES[marketType as MarketTypeKey];
    const deadlineText = market.deadline
      ? `\nDeadline: ${market.deadline.toISOString().split("T")[0]}`
      : "";

    await ctx.editMessageText(
      `<b>Market #${marketId}</b>\n\n` +
      `<b>${question}</b>\n\n` +
      `Type: ${typeDef?.label ?? marketType}\n` +
      `Competition: ${fixture.Competition}\n` +
      `Match Date: ${matchDate}\n` +
      `Min Bet: ${parseFloat(market.minBet)} SOL${deadlineText}\n` +
      `Status: Open\n\n` +
      `Tap YES or NO to place your bet!`,
      { parse_mode: "HTML", reply_markup: keyboard },
    );

    await ctx.answerCallbackQuery();
  }

  // Bet placement callback (unchanged logic)
  bot.callbackQuery(/^bet:(\d+):(yes|no)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^bet:(\d+):(yes|no)$/);
    if (!match) return;

    const marketId = parseInt(match[1]!);
    const side = match[2]! as "yes" | "no";
    const telegramId = BigInt(ctx.from.id);

    const user = await db.query.users.findFirst({
      where: eq(users.telegramId, telegramId),
    });

    if (!user) {
      await ctx.answerCallbackQuery({
        text: "You need an account first! DM me and send /start",
        show_alert: true,
      });
      return;
    }

    const market = await db.query.markets.findFirst({
      where: eq(markets.id, marketId),
    });

    if (!market || market.status !== "open") {
      await ctx.answerCallbackQuery({ text: "This market is no longer open for betting.", show_alert: true });
      return;
    }

    if (!market.marketPublicKey) {
      await ctx.answerCallbackQuery({ text: "Market wallet not configured.", show_alert: true });
      return;
    }

    if (market.deadline && new Date() > market.deadline) {
      await ctx.answerCallbackQuery({ text: "Betting deadline has passed.", show_alert: true });
      return;
    }

    const existingBet = await db.query.bets.findFirst({
      where: and(eq(bets.marketId, marketId), eq(bets.userId, telegramId)),
    });

    if (existingBet) {
      await ctx.answerCallbackQuery({
        text: `You already bet ${existingBet.side.toUpperCase()} on this market.`,
        show_alert: true,
      });
      return;
    }

    const minBet = parseFloat(market.minBet);

    const balance = await getBalance(user.publicKey);
    if (balance < minBet + 0.000005) {
      await ctx.answerCallbackQuery({
        text: `Insufficient balance. You need at least ${minBet} SOL. Your balance: ${balance.toFixed(4)} SOL. DM me /deposit for instructions.`,
        show_alert: true,
      });
      return;
    }

    try {
      const secretKey = decrypt(user.encryptedPrivateKey, env.ENCRYPTION_KEY);
      const txSig = await transferSOL(secretKey, market.marketPublicKey, minBet);

      await db.insert(bets).values({
        marketId,
        userId: telegramId,
        side,
        amount: minBet.toString(),
        txSignature: txSig,
      });

      await ctx.answerCallbackQuery({
        text: `Bet placed! ${minBet} SOL on ${side.toUpperCase()}`,
        show_alert: true,
      });

      const [yesCount] = await db.select({ count: count() }).from(bets)
        .where(and(eq(bets.marketId, marketId), eq(bets.side, "yes")));
      const [noCount] = await db.select({ count: count() }).from(bets)
        .where(and(eq(bets.marketId, marketId), eq(bets.side, "no")));

      const keyboard = new InlineKeyboard()
        .text(`YES (${yesCount!.count})`, `bet:${marketId}:yes`)
        .text(`NO (${noCount!.count})`, `bet:${marketId}:no`);

      try {
        await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
      } catch { /* race condition, ignore */ }
    } catch (err) {
      console.error("Bet failed:", err);
      await ctx.answerCallbackQuery({ text: "Bet failed. Please try again.", show_alert: true });
    }
  });
}
