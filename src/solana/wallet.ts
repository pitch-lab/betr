import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { env } from "../env.js";

let _connection: Connection | null = null;

export function getConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(env.SOLANA_RPC_URL, "confirmed");
  }
  return _connection;
}

export function generateKeypair(): { publicKey: string; secretKeyBase58: string } {
  const keypair = Keypair.generate();
  return {
    publicKey: keypair.publicKey.toBase58(),
    secretKeyBase58: bs58.encode(keypair.secretKey),
  };
}

export async function getBalance(publicKey: string): Promise<number> {
  const connection = getConnection();
  const balance = await connection.getBalance(new PublicKey(publicKey));
  return balance / LAMPORTS_PER_SOL;
}

export async function transferSOL(
  fromSecretKeyBase58: string,
  toPublicKey: string,
  amountSOL: number,
): Promise<string> {
  const connection = getConnection();
  const fromKeypair = Keypair.fromSecretKey(bs58.decode(fromSecretKeyBase58));
  const toPubkey = new PublicKey(toPublicKey);

  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey,
      lamports: Math.round(amountSOL * LAMPORTS_PER_SOL),
    }),
  );

  const signature = await sendAndConfirmTransaction(connection, transaction, [fromKeypair]);
  return signature;
}
