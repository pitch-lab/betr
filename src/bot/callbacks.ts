import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { eq, and, count } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, markets, bets } from "../db/schema.js";
import { encrypt, decrypt } from "../utils/crypto.js";
import { generateKeypair, getBalance, transferSOL } from "../solana/wallet.js";
import { env } from "../env.js";
import { getFixtures, type Fixture } from "../txline/client.js";

export function registerCallbacks(bot: Bot) {
  // Fired when a user taps a fixture from the list posted by /createmarket
  bot.callbackQuery(/^fix:(\d+):(\d+)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^fix:(\d+):(\d+)$/);
    if (!match) return;

    const draftMarketId = parseInt(match[1]!);
    const fixtureId = parseInt(match[2]!);

    // Load draft market — must still be in draft status
    const market = await db.query.markets.findFirst({
      where: eq(markets.id, draftMarketId),
    });

    if (!market || market.status !== "draft") {
      await ctx.answerCallbackQuery({
        text: "This market has already been set up.",
        show_alert: true,
      });
      return;
    }

    // Re-fetch fixtures to get full details for the selected fixture
    let fixture: Fixture | undefined;
    try {
      const fixtures = await getFixtures();
      fixture = fixtures.find((f) => f.FixtureId === fixtureId);
    } catch (err) {
      console.error("Failed to fetch fixtures:", err);
      await ctx.answerCallbackQuery({
        text: "Failed to load fixture details. Please try again.",
        show_alert: true,
      });
      return;
    }

    if (!fixture) {
      await ctx.answerCallbackQuery({
        text: "Fixture not found. The match may have already started.",
        show_alert: true,
      });
      return;
    }

    // Generate the market escrow keypair now that a fixture is chosen
    const { publicKey, secretKeyBase58 } = generateKeypair();
    const encryptedKey = encrypt(secretKeyBase58, env.ENCRYPTION_KEY);
    const question = `Will ${fixture.Participant1} beat ${fixture.Participant2}?`;
    const messageId = ctx.callbackQuery.message?.message_id ?? null;

    await db.update(markets).set({
      fixtureId: fixture.FixtureId,
      question,
      marketPublicKey: publicKey,
      marketEncryptedPrivateKey: encryptedKey,
      status: "open",
      messageId,
    }).where(eq(markets.id, draftMarketId));

    const keyboard = new InlineKeyboard()
      .text("YES (0)", `bet:${draftMarketId}:yes`)
      .text("NO (0)", `bet:${draftMarketId}:no`);

    const matchDate = new Date(fixture.StartTime).toISOString().split("T")[0];
    const deadlineText = market.deadline
      ? `\nDeadline: ${market.deadline.toISOString().split("T")[0]}`
      : "";

    await ctx.editMessageText(
      `<b>Market #${draftMarketId}</b>\n\n` +
      `<b>${question}</b>\n\n` +
      `Competition: ${fixture.Competition}\n` +
      `Match Date: ${matchDate}\n` +
      `Min Bet: ${parseFloat(market.minBet)} SOL${deadlineText}\n` +
      `Status: Open\n\n` +
      `Tap YES or NO to place your bet!`,
      { parse_mode: "HTML", reply_markup: keyboard },
    );

    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery(/^bet:(\d+):(yes|no)$/, async (ctx) => {
    const match = ctx.callbackQuery.data.match(/^bet:(\d+):(yes|no)$/);
    if (!match) return;

    const marketId = parseInt(match[1]!);
    const side = match[2]! as "yes" | "no";
    const telegramId = BigInt(ctx.from.id);

    // Look up user
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

    // Look up market
    const market = await db.query.markets.findFirst({
      where: eq(markets.id, marketId),
    });

    if (!market || market.status !== "open") {
      await ctx.answerCallbackQuery({
        text: "This market is no longer open for betting.",
        show_alert: true,
      });
      return;
    }

    // Safety guard: open markets always have a keypair, but check anyway
    if (!market.marketPublicKey) {
      await ctx.answerCallbackQuery({
        text: "Market wallet not configured.",
        show_alert: true,
      });
      return;
    }

    // Check deadline
    if (market.deadline && new Date() > market.deadline) {
      await ctx.answerCallbackQuery({
        text: "Betting deadline has passed.",
        show_alert: true,
      });
      return;
    }

    // Check for existing bet
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

    // Check balance
    const balance = await getBalance(user.publicKey);
    if (balance < minBet + 0.000005) {
      await ctx.answerCallbackQuery({
        text: `Insufficient balance. You need at least ${minBet} SOL. Your balance: ${balance.toFixed(4)} SOL. DM me /deposit for instructions.`,
        show_alert: true,
      });
      return;
    }

    // Execute bet
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

      // Update button counts
      const [yesCount] = await db.select({ count: count() }).from(bets)
        .where(and(eq(bets.marketId, marketId), eq(bets.side, "yes")));
      const [noCount] = await db.select({ count: count() }).from(bets)
        .where(and(eq(bets.marketId, marketId), eq(bets.side, "no")));

      const keyboard = new InlineKeyboard()
        .text(`YES (${yesCount!.count})`, `bet:${marketId}:yes`)
        .text(`NO (${noCount!.count})`, `bet:${marketId}:no`);

      try {
        await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
      } catch { /* message not modified - race condition, ignore */ }
    } catch (err) {
      console.error("Bet failed:", err);
      await ctx.answerCallbackQuery({
        text: "Bet failed. Please try again.",
        show_alert: true,
      });
    }
  });
}
