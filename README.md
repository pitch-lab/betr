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
| `/createmarket <bet_amount> <deadline>` | Fetch live fixtures and create a market |
| `/closemarket <id>` | Close a market (stop new bets) |
| `/resolve <id>` | Auto-resolve a TxLINE market via match score |
| `/resolve <id> <yes\|no>` | Manually resolve a market |

### Market Creation Flow

```
/createmarket 0.01 2026-07-15
```

1. Bot fetches upcoming fixtures from TxLINE
2. A list of matches is shown as buttons in the group
3. Any user taps a match to create the market
4. Market opens with YES/NO betting buttons

### Resolution

- TxLINE markets: run `/resolve <id>` after the deadline. The bot fetches the final score automatically. YES = home team wins, NO = draw or away win.
- Manual markets: run `/resolve <id> yes` or `/resolve <id> no`.
- Markets must be closed with `/closemarket` before they can be resolved.

## How It Works

1. Users DM the bot `/start` to create a Solana wallet
2. Users deposit SOL to their wallet
3. A group admin creates a market with `/createmarket` - bot shows live fixtures from TxLINE
4. A user selects a match - market opens with YES/NO buttons
5. Users tap YES or NO to bet (SOL is transferred on-chain to the market escrow wallet)
6. Admin closes the market with `/closemarket`, then resolves with `/resolve`
7. Winners receive pro-rata payouts from the losing side's pool
