import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = Object.freeze({
  BOT_TOKEN: required("BOT_TOKEN"),
  DATABASE_URL: required("DATABASE_URL"),
  ENCRYPTION_KEY: required("ENCRYPTION_KEY"),
  SOLANA_RPC_URL: required("SOLANA_RPC_URL"),
});

if (env.ENCRYPTION_KEY.length !== 64) {
  throw new Error("ENCRYPTION_KEY must be a 64-character hex string (32 bytes)");
}
