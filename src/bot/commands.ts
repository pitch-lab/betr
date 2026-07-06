import type { Bot } from "grammy";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { encrypt, decrypt } from "../utils/crypto.js";
import { generateKeypair, getBalance, transferSOL } from "../solana/wallet.js";
import { env } from "../env.js";
import { PublicKey } from "@solana/web3.js";

export function registerCommands(bot: Bot) {
  bot.command("start", async (ctx) => {
    if (ctx.chat.type !== "private") return;

    const telegramId = BigInt(ctx.from!.id);

    const existing = await db.query.users.findFirst({
      where: eq(users.telegramId, telegramId),
    });

    if (existing) {
      await ctx.reply("You already have an account.\n\nUse /balance to check your balance.\nUse /address to see your wallet address.");
      return;
    }

    const { publicKey, secretKeyBase58 } = generateKeypair();
    const encryptedKey = encrypt(secretKeyBase58, env.ENCRYPTION_KEY);

    await db.insert(users).values({
      telegramId,
      username: ctx.from!.username ?? null,
      encryptedPrivateKey: encryptedKey,
      publicKey,
    });

    await ctx.reply(
      `<b>Account Created!</b>\n\n` +
      `<b>Your Wallet Address:</b>\n<code>${publicKey}</code>\n\n` +
      `<b>Your Private Key (SAVE THIS NOW):</b>\n<code>${secretKeyBase58}</code>\n\n` +
      `<b>This private key will NEVER be shown again.</b>\n\n` +
      `Please deposit at least <b>0.1 SOL</b> to your wallet address above to start betting.\n\n` +
      `Commands:\n/balance - Check balance\n/address - Show wallet address\n/deposit - Deposit instructions\n/withdraw - Withdraw SOL`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("balance", async (ctx) => {
    if (ctx.chat.type !== "private") return;

    const user = await db.query.users.findFirst({
      where: eq(users.telegramId, BigInt(ctx.from!.id)),
    });

    if (!user) {
      await ctx.reply("You don't have an account yet. Use /start to create one.");
      return;
    }

    const balance = await getBalance(user.publicKey);
    await ctx.reply(`<b>Balance:</b> ${balance.toFixed(4)} SOL`, { parse_mode: "HTML" });
  });

  bot.command("address", async (ctx) => {
    if (ctx.chat.type !== "private") return;

    const user = await db.query.users.findFirst({
      where: eq(users.telegramId, BigInt(ctx.from!.id)),
    });

    if (!user) {
      await ctx.reply("You don't have an account yet. Use /start to create one.");
      return;
    }

    await ctx.reply(
      `<b>Your Wallet Address:</b>\n<code>${user.publicKey}</code>`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("deposit", async (ctx) => {
    if (ctx.chat.type !== "private") return;

    const user = await db.query.users.findFirst({
      where: eq(users.telegramId, BigInt(ctx.from!.id)),
    });

    if (!user) {
      await ctx.reply("You don't have an account yet. Use /start to create one.");
      return;
    }

    await ctx.reply(
      `<b>Deposit SOL</b>\n\nSend SOL to your wallet address:\n<code>${user.publicKey}</code>\n\n(Solana Devnet)`,
      { parse_mode: "HTML" },
    );
  });

  bot.command("withdraw", async (ctx) => {
    if (ctx.chat.type !== "private") return;

    const user = await db.query.users.findFirst({
      where: eq(users.telegramId, BigInt(ctx.from!.id)),
    });

    if (!user) {
      await ctx.reply("You don't have an account yet. Use /start to create one.");
      return;
    }

    const args = ctx.match?.trim().split(/\s+/);
    if (!args || args.length !== 2) {
      await ctx.reply("Usage: /withdraw <amount> <address>\n\nExample: /withdraw 0.05 ABC123...");
      return;
    }

    const amount = parseFloat(args[0]!);
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply("Invalid amount. Must be a positive number.");
      return;
    }

    let destAddress: string;
    try {
      destAddress = new PublicKey(args[1]!).toBase58();
    } catch {
      await ctx.reply("Invalid Solana address.");
      return;
    }

    const balance = await getBalance(user.publicKey);
    const fee = 0.000005;
    if (balance < amount + fee) {
      await ctx.reply(`Insufficient balance. You have ${balance.toFixed(4)} SOL (need ${(amount + fee).toFixed(6)} SOL including fee).`);
      return;
    }

    try {
      const secretKey = decrypt(user.encryptedPrivateKey, env.ENCRYPTION_KEY);
      const txSig = await transferSOL(secretKey, destAddress, amount);
      await ctx.reply(
        `<b>Withdrawal successful!</b>\n\nAmount: ${amount} SOL\nTo: <code>${destAddress}</code>\n\n<a href="https://explorer.solana.com/tx/${txSig}?cluster=devnet">View Transaction</a>`,
        { parse_mode: "HTML" },
      );
    } catch (err) {
      console.error("Withdrawal failed:", err);
      await ctx.reply("Withdrawal failed. Please try again later.");
    }
  });
}
