import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { eq, and, count } from "drizzle-orm";
import { db } from "../db/index.js";
import { markets, bets } from "../db/schema.js";
import { encrypt } from "../utils/crypto.js";
import { generateKeypair } from "../solana/wallet.js";
import { env } from "../env.js";
import { settleMarket } from "../resolver/index.js";

export function registerMarketHandlers(bot: Bot) {
  bot.command("createmarket", async (ctx) => {
    if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") {
      await ctx.reply("This command only works in groups.");
      return;
    }

    const member = await ctx.getChatMember(ctx.from!.id);
    if (!["administrator", "creator"].includes(member.status)) {
      await ctx.reply("Only group admins can create markets.");
      return;
    }

    const input = ctx.match?.trim();
    if (!input) {
      await ctx.reply(
        "Usage: /createmarket <question> | minbet:0.05 | deadline:2025-12-31\n\n" +
        "Example: /createmarket Will BTC hit 100k? | minbet:0.01",
      );
      return;
    }

    const parts = input.split("|").map((p) => p.trim());
    const question = parts[0]!;

    let minBet = "0.01";
    let deadline: Date | null = null;

    for (const part of parts.slice(1)) {
      const [key, value] = part.split(":").map((s) => s.trim());
      if (key === "minbet" && value) {
        const parsed = parseFloat(value);
        if (!isNaN(parsed) && parsed > 0) {
          minBet = parsed.toString();
        }
      } else if (key === "deadline" && value) {
        const parsed = new Date(value);
        if (!isNaN(parsed.getTime())) {
          deadline = parsed;
        }
      }
    }

    const { publicKey, secretKeyBase58 } = generateKeypair();
    const encryptedKey = encrypt(secretKeyBase58, env.ENCRYPTION_KEY);

    const [market] = await db.insert(markets).values({
      groupId: BigInt(ctx.chat.id),
      creatorId: BigInt(ctx.from!.id),
      question,
      minBet,
      deadline,
      marketPublicKey: publicKey,
      marketEncryptedPrivateKey: encryptedKey,
      status: "open",
    }).returning();

    const keyboard = new InlineKeyboard()
      .text("YES (0)", `bet:${market!.id}:yes`)
      .text("NO (0)", `bet:${market!.id}:no`);

    const deadlineText = deadline
      ? `\nDeadline: ${deadline.toISOString().split("T")[0]}`
      : "";

    const msg = await ctx.reply(
      `<b>Market #${market!.id}</b>\n\n` +
      `<b>${question}</b>\n\n` +
      `Min Bet: ${minBet} SOL${deadlineText}\n` +
      `Status: Open\n\n` +
      `Tap YES or NO to place your bet!`,
      { parse_mode: "HTML", reply_markup: keyboard },
    );

    await db.update(markets)
      .set({ messageId: msg.message_id })
      .where(eq(markets.id, market!.id));
  });

  bot.command("closemarket", async (ctx) => {
    if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") return;

    const member = await ctx.getChatMember(ctx.from!.id);
    if (!["administrator", "creator"].includes(member.status)) {
      await ctx.reply("Only group admins can close markets.");
      return;
    }

    const marketId = parseInt(ctx.match?.trim() ?? "");
    if (isNaN(marketId)) {
      await ctx.reply("Usage: /closemarket <marketId>");
      return;
    }

    const market = await db.query.markets.findFirst({
      where: and(eq(markets.id, marketId), eq(markets.groupId, BigInt(ctx.chat.id))),
    });

    if (!market) {
      await ctx.reply("Market not found in this group.");
      return;
    }

    if (market.status !== "open") {
      await ctx.reply(`Market is already ${market.status}.`);
      return;
    }

    await db.update(markets).set({ status: "closed" }).where(eq(markets.id, marketId));

    const [yesCount] = await db.select({ count: count() }).from(bets)
      .where(and(eq(bets.marketId, marketId), eq(bets.side, "yes")));
    const [noCount] = await db.select({ count: count() }).from(bets)
      .where(and(eq(bets.marketId, marketId), eq(bets.side, "no")));

    if (market.messageId) {
      try {
        await ctx.api.editMessageText(
          ctx.chat.id,
          market.messageId,
          `<b>Market #${market.id} [CLOSED]</b>\n\n` +
          `<b>${market.question}</b>\n\n` +
          `YES: ${yesCount!.count} bets | NO: ${noCount!.count} bets\n` +
          `Status: Closed - Awaiting resolution`,
          { parse_mode: "HTML" },
        );
      } catch { /* message may have been deleted */ }
    }

    await ctx.reply(`Market #${marketId} is now closed. No more bets accepted.\n\nUse /resolve ${marketId} yes or /resolve ${marketId} no to settle.`);
  });

  bot.command("resolve", async (ctx) => {
    if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") return;

    const member = await ctx.getChatMember(ctx.from!.id);
    if (!["administrator", "creator"].includes(member.status)) {
      await ctx.reply("Only group admins can resolve markets.");
      return;
    }

    const args = ctx.match?.trim().split(/\s+/);
    if (!args || args.length !== 2) {
      await ctx.reply("Usage: /resolve <marketId> <yes|no>");
      return;
    }

    const marketId = parseInt(args[0]!);
    const winningSide = args[1]!.toLowerCase();

    if (isNaN(marketId) || (winningSide !== "yes" && winningSide !== "no")) {
      await ctx.reply("Usage: /resolve <marketId> <yes|no>");
      return;
    }

    const market = await db.query.markets.findFirst({
      where: and(eq(markets.id, marketId), eq(markets.groupId, BigInt(ctx.chat.id))),
    });

    if (!market) {
      await ctx.reply("Market not found in this group.");
      return;
    }

    if (market.status === "resolved") {
      await ctx.reply("Market is already resolved.");
      return;
    }

    if (market.status === "open") {
      await ctx.reply(`Market #${marketId} is still open. Run /closemarket ${marketId} first to stop bets before resolving.`);
      return;
    }

    if (market.deadline && new Date() < market.deadline) {
      const deadlineStr = market.deadline.toISOString().replace("T", " ").slice(0, 16) + " UTC";
      await ctx.reply(`Cannot resolve yet. Deadline hasn't passed.\n\nDeadline: ${deadlineStr}`);
      return;
    }

    await ctx.reply(`Resolving market #${marketId}... Settling payouts.`);

    try {
      const result = await settleMarket(marketId, winningSide as "yes" | "no");

      if (market.messageId) {
        try {
          await ctx.api.editMessageText(
            ctx.chat.id,
            market.messageId,
            `<b>Market #${market.id} [RESOLVED]</b>\n\n` +
            `<b>${market.question}</b>\n\n` +
            `Winner: <b>${winningSide.toUpperCase()}</b>\n` +
            `Winners paid: ${result.winnerCount}\n` +
            `Total pool: ${result.totalPool.toFixed(4)} SOL`,
            { parse_mode: "HTML" },
          );
        } catch { /* message may have been deleted */ }
      }

      await ctx.reply(
        `Market #${marketId} resolved!\n\n` +
        `Winner: ${winningSide.toUpperCase()}\n` +
        `${result.winnerCount} winners paid out from a pool of ${result.totalPool.toFixed(4)} SOL.`,
      );
    } catch (err) {
      console.error("Settlement failed:", err);
      await ctx.reply("Settlement failed. Please try again.");
    }
  });
}
