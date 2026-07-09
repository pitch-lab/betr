import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { markets, bets } from "../db/schema.js";
import { decrypt } from "../utils/crypto.js";
import { transferSOL, getBalance } from "../solana/wallet.js";
import { env } from "../env.js";

export interface ResolutionResult {
  marketId: number;
  winningSide: "yes" | "no";
  winnerCount: number;
  totalPool: number;
}

// This interface is for future API-based resolution
export interface MarketResolver {
  resolve(marketId: number): Promise<{ winningSide: "yes" | "no" } | null>;
}

export async function settleMarket(
  marketId: number,
  winningSide: "yes" | "no",
): Promise<ResolutionResult> {
  const market = await db.query.markets.findFirst({
    where: eq(markets.id, marketId),
  });

  if (!market) throw new Error("Market not found");
  if (!market.marketPublicKey || !market.marketEncryptedPrivateKey) throw new Error("Market wallet not configured");

  // Get all bets
  const allBets = await db.select().from(bets).where(eq(bets.marketId, marketId));

  const winningBets = allBets.filter((b) => b.side === winningSide);
  const losingBets = allBets.filter((b) => b.side !== winningSide);

  const totalWinningPool = winningBets.reduce((sum, b) => sum + parseFloat(b.amount), 0);
  const totalLosingPool = losingBets.reduce((sum, b) => sum + parseFloat(b.amount), 0);
  const totalPool = totalWinningPool + totalLosingPool;

  // Decrypt market keypair
  const marketSecretKey = decrypt(market.marketEncryptedPrivateKey, env.ENCRYPTION_KEY);

  // Check market wallet balance
  const marketBalance = await getBalance(market.marketPublicKey);
  const txFeePerTransfer = 0.000005;
  const totalFees = txFeePerTransfer * winningBets.length;

  if (winningBets.length > 0 && marketBalance > totalFees) {
    const distributablePool = marketBalance - totalFees;

    // Get user public keys for winners
    const { users } = await import("../db/schema.js");

    for (const bet of winningBets) {
      const user = await db.query.users.findFirst({
        where: eq(users.telegramId, bet.userId),
      });

      if (!user) continue;

      // Pro-rata payout: winner's share of the total pool
      const share = parseFloat(bet.amount) / totalWinningPool;
      const payout = share * distributablePool;

      if (payout > txFeePerTransfer) {
        try {
          await transferSOL(marketSecretKey, user.publicKey, payout);
        } catch (err) {
          console.error(`Failed to pay ${user.publicKey}:`, err);
        }
      }
    }
  }

  // Update market status
  await db.update(markets)
    .set({ status: "resolved", winningSide })
    .where(eq(markets.id, marketId));

  return {
    marketId,
    winningSide,
    winnerCount: winningBets.length,
    totalPool,
  };
}
