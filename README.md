# Betr - Telegram Prediction Market Bot

A Telegram bot for creating and betting on yes/no prediction markets using Solana (devnet).

## Setup

### Prerequisites

- Node.js 20+
- pnpm

### Install

```bash
pnpm install
```

### Environment Variables

Create a `.env` file in the project root:

```env
BOT_TOKEN=           # Telegram bot token from @BotFather
DATABASE_URL=        # Neon PostgreSQL connection string
ENCRYPTION_KEY=      # 64-char hex string (32 bytes) for encrypting wallet keys
SOLANA_RPC_URL=      # Solana RPC endpoint (devnet)
```

**Generating an encryption key:**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Push Database Schema

```bash
pnpm db:push
```

### Run

```bash
# Development (with hot reload)
pnpm dev

# Production
pnpm build
pnpm start
```

## Bot Commands

### DM Commands (private chat with bot)

| Command | Description |
|---------|-------------|
| `/start` | Create a wallet and account |
| `/balance` | Check SOL balance |
| `/address` | Show wallet address |
| `/deposit` | Show deposit instructions |
| `/withdraw <amount> <address>` | Withdraw SOL to an address |

### Group Commands (admin only)

| Command | Description |
|---------|-------------|
| `/createmarket <question>` | Create a new market |
| `/closemarket <id>` | Close a market (stop new bets) |
| `/resolve <id> <yes\|no>` | Resolve a market and pay out winners |

### Market Creation Options

```
/createmarket Will BTC hit 100k? | minbet:0.05 | deadline:2026-12-31
```

- `minbet` - Minimum bet in SOL (default: 0.01)
- `deadline` - Betting cutoff date (optional)

## How It Works

1. Users DM the bot `/start` to create a Solana wallet
2. Users deposit SOL to their wallet
3. A group admin creates a market with `/createmarket`
4. Users tap YES or NO buttons to bet (SOL is transferred from their wallet to the market wallet)
5. Admin resolves the market — winners receive pro-rata payouts from the losing side's pool
