import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { eq, and, count } from "drizzle-orm";
import { db } from "../db/index.js";
import { users, markets, bets } from "../db/schema.js";
import { decrypt } from "../utils/crypto.js";
import { getBalance, transferSOL } from "../solana/wallet.js";
import { env } from "../env.js";

export function registerCallbacks(bot: Bot) {
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
