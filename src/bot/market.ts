import type { Bot } from "grammy";
import { InlineKeyboard } from "grammy";
import { eq, and, count } from "drizzle-orm";
import { db } from "../db/index.js";
import { markets, bets } from "../db/schema.js";
import { settleMarket } from "../resolver/index.js";
import { getFixtures, getScore, determineOutcome } from "../txline/client.js";

export function registerMarketHandlers(bot: Bot) {
  bot.command("createmarket", async (ctx) => {
    if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") {
      await ctx.reply("This command only works in groups.");
      return;
    }

    const args = ctx.match?.trim().split(/\s+/);
    if (!args || args.length !== 2) {
      await ctx.reply(
        "Usage: /createmarket <bet_amount> <deadline>\n\n" +
        "Example: /createmarket 0.01 2026-07-15",
      );
      return;
    }

    const minBet = parseFloat(args[0]!);
    if (isNaN(minBet) || minBet <= 0) {
      await ctx.reply("Invalid bet amount. Must be a positive number.");
      return;
    }

    const deadline = new Date(args[1]!);
    if (isNaN(deadline.getTime())) {
      await ctx.reply("Invalid deadline. Use format: YYYY-MM-DD");
      return;
    }

    // Fetch upcoming fixtures from TxLINE before inserting anything
    let fixtures: Awaited<ReturnType<typeof getFixtures>>;
    try {
      fixtures = await getFixtures();
    } catch (err) {
      console.error("Failed to fetch fixtures:", err);
      await ctx.reply("Failed to fetch upcoming fixtures. Please try again.");
      return;
    }

    if (fixtures.length === 0) {
      await ctx.reply("No upcoming fixtures available at this time.");
      return;
    }

    // Insert draft market — no question or keypair yet, waiting for fixture selection
    const [draft] = await db.insert(markets).values({
      groupId: BigInt(ctx.chat.id),
      creatorId: BigInt(ctx.from!.id),
      minBet: minBet.toString(),
      deadline,
      status: "draft",
    }).returning();

    // Show each fixture as its own button row (max 10)
    const keyboard = new InlineKeyboard();
    for (const fixture of fixtures.slice(0, 10)) {
      const matchDate = new Date(fixture.StartTime).toISOString().split("T")[0];
      keyboard.row().text(
        `${fixture.Participant1} vs ${fixture.Participant2} (${matchDate})`,
        `fix:${draft!.id}:${fixture.FixtureId}`,
      );
    }

    await ctx.reply(
      `<b>Select a match to create a market:</b>\n\nMin Bet: ${minBet} SOL | Deadline: ${args[1]}`,
      { parse_mode: "HTML", reply_markup: keyboard },
    );
  });

  bot.command("closemarket", async (ctx) => {
    if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") return;

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

    if (market.status === "draft") {
      await ctx.reply(`Market #${marketId} hasn't been set up yet. A fixture needs to be selected first.`);
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

    const args = ctx.match?.trim().split(/\s+/).filter(Boolean) ?? [];

    const marketId = parseInt(args[0] ?? "");
    if (isNaN(marketId)) {
      await ctx.reply("Usage: /resolve <marketId>\n\nFor manual markets: /resolve <marketId> <yes|no>");
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

    if (market.status === "draft") {
      await ctx.reply(`Market #${marketId} hasn't been set up yet. A fixture needs to be selected first.`);
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

    // Determine winning side — auto via TxLINE if market has a fixture, manual otherwise
    let winningSide: "yes" | "no";

    if (market.fixtureId) {
      // Auto-resolve: fetch score from TxLINE and determine outcome
      let scores: Awaited<ReturnType<typeof getScore>>;
      try {
        scores = await getScore(market.fixtureId);
      } catch (err) {
        console.error("Failed to fetch score:", err);
        await ctx.reply("Failed to fetch match score from TxLINE. Please try again.");
        return;
      }

      const outcome = determineOutcome(scores);
      if (outcome === null) {
        await ctx.reply("Match hasn't finished yet or result is unavailable. Try again after the match ends.");
        return;
      }

      winningSide = outcome;
    } else {
      // Manual resolve: admin must provide yes|no
      const side = args[1]?.toLowerCase();
      if (!side || (side !== "yes" && side !== "no")) {
        await ctx.reply("Usage: /resolve <marketId> <yes|no>");
        return;
      }
      winningSide = side as "yes" | "no";
    }

    await ctx.reply(`Resolving market #${marketId}... Settling payouts.`);

    try {
      const result = await settleMarket(marketId, winningSide);

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
