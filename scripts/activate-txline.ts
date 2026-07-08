import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createPrivateKey, sign as cryptoSign } from "crypto";
import fs from "fs";

// TxLINE devnet constants
const TXLINE_PROGRAM_ID = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const TXL_TOKEN_MINT = new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const API_BASE = "https://txline-dev.txodds.com";

const SERVICE_LEVEL_ID = 1;
const DURATION_WEEKS = 4;

// Get a guest JWT first: curl -X POST https://txline-dev.txodds.com/auth/guest/start
const JWT = process.env.TXLINE_GUEST_JWT;
if (!JWT) throw new Error("Set TXLINE_GUEST_JWT env var before running this script");

function getATA(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

async function main() {
  const keypairData = JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf-8"));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  console.log("Wallet:", wallet.publicKey.toBase58());

  const connection = new Connection("https://devnet.helius-rpc.com/?api-key=5563e4bb-88ed-4a4c-baed-2084d1470202", "confirmed");

  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_treasury_v2")],
    TXLINE_PROGRAM_ID,
  );
  const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pricing_matrix")],
    TXLINE_PROGRAM_ID,
  );
  const tokenTreasuryVault = getATA(tokenTreasuryPda, TXL_TOKEN_MINT, TOKEN_2022_PROGRAM_ID);
  const userTokenAccount = getATA(wallet.publicKey, TXL_TOKEN_MINT, TOKEN_2022_PROGRAM_ID);

  const discriminator = Buffer.from([254, 28, 191, 138, 156, 179, 183, 53]);
  const serviceLevelBuf = Buffer.alloc(2);
  serviceLevelBuf.writeUInt16LE(SERVICE_LEVEL_ID);
  const weeksBuf = Buffer.alloc(1);
  weeksBuf.writeUInt8(DURATION_WEEKS);
  const data = Buffer.concat([discriminator, serviceLevelBuf, weeksBuf]);

  const instruction = new TransactionInstruction({
    programId: TXLINE_PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: pricingMatrixPda, isSigner: false, isWritable: false },
      { pubkey: TXL_TOKEN_MINT, isSigner: false, isWritable: false },
      { pubkey: userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: tokenTreasuryVault, isSigner: false, isWritable: true },
      { pubkey: tokenTreasuryPda, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });

  // Create user TxL token account (idempotent — safe to run even if it exists)
  const createATAInstruction = new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: false, isWritable: false },
      { pubkey: TXL_TOKEN_MINT, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // idempotent create
  });

  console.log("Sending subscribe transaction...");
  const tx = new Transaction().add(createATAInstruction).add(instruction);
  const txSig = await sendAndConfirmTransaction(connection, tx, [wallet]);
  console.log("Transaction confirmed:", txSig);

  const leagues: string[] = [];
  const messageString = `${txSig}:${leagues.join(",")}:${JWT}`;
  const messageBytes = new TextEncoder().encode(messageString);
  const pkcs8Header = Buffer.from("302e020100300506032b657004220420", "hex");
  const privKey = createPrivateKey({ key: Buffer.concat([pkcs8Header, Buffer.from(wallet.secretKey.slice(0, 32))]), format: "der", type: "pkcs8" });
  const signatureBytes = cryptoSign(null, messageBytes, privKey);
  const walletSignature = Buffer.from(signatureBytes).toString("base64");

  console.log("Activating API token...");
  const res = await fetch(`${API_BASE}/api/token/activate`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${JWT}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ txSig, walletSignature, leagues }),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error("Activation failed:", text);
    process.exit(1);
  }

  let apiToken: string;
  try {
    const json = JSON.parse(text);
    apiToken = json.token ?? json;
  } catch {
    apiToken = text.trim();
  }

  console.log("\nAPI Token:", apiToken);
  console.log("\nAdd these to your .env:");
  console.log(`TXLINE_JWT=${JWT}`);
  console.log(`TXLINE_API_TOKEN=${apiToken}`);
}

main().catch(console.error);
