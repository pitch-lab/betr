# Betr - Telegram Bet Market Bot

Betr is a Telegram bot that lets users bet on live football matches using SOL on Solana devnet. Anyone can create bet markets in group chats backed by real match data from TxLINE. Users set up wallets via DM, place yes/no bets through inline buttons, and winners are paid out automatically based on final scores. Supports multiple market types including match winner, over/under goals, both teams score, clean sheets, halftime leader, corners, and cards.

**Bot**: [t.me/betr_football_bot](https://t.me/betr_football_bot)
**Demo**: [Watch on Loom](https://www.loom.com/share/366819a5c8314cd8ad384580d0fb7c77)
**GitHub**: [pitch-lab/betr](https://github.com/pitch-lab/betr)

## How It Works

1. Users DM the bot `/start` to create a Solana wallet (devnet). The private key is shown once for backup, then encrypted and stored.
2. Users deposit SOL to their wallet address.
3. Anyone runs `/createmarket <amount>` in a group chat. The bot fetches upcoming fixtures from the TxLINE API and shows them as buttons.
4. A user selects a match, then picks a market type (match winner, over/under goals, both teams score, etc.).
5. The market opens with YES/NO inline buttons. Any group member with an account can tap to bet. SOL is transferred on-chain from the user's wallet to a dedicated market escrow wallet. A transaction receipt is sent to the user's DMs.
6. Betting closes automatically when the match kicks off (based on the fixture's start time from TxLINE).
7. After the match ends, run `/resolve <id>`. The bot fetches the final score from TxLINE, determines the winning side, and distributes the pool to winners pro-rata.

## Market Types

All markets are yes/no. The bot resolves them automatically using match stats from TxLINE.

| Type | Question | YES wins when |
|------|----------|---------------|
| Match Winner | Will Team A beat Team B? | Home team wins |
| Over/Under Goals | More than N total goals? | Total goals > N |
| Both Teams Score | Will both teams score? | Both teams score at least 1 |
| Clean Sheet | Will Team A keep a clean sheet? | Selected team concedes 0 |
| Halftime Leader | Will Team A lead at halftime? | Home team leads at half |
| Over/Under Corners | More than N total corners? | Total corners > N |
| Over/Under Cards | More than N yellow cards? | Total yellows > N |

## Tech Stack

- **Grammy.js** -- Telegram bot framework
- **Drizzle ORM + Neon PostgreSQL** -- database (WebSocket pool for transaction support)
- **@solana/web3.js** -- wallet creation, SOL transfers (devnet)
- **TxLINE API** -- live fixture data and match scores for auto-resolution
- **Node.js crypto (AES-256-GCM)** -- private key encryption at rest

## Setup

### Prerequisites

- Node.js 20+
- pnpm

### Install

```bash
pnpm install
```

### Environment Variables

Create a `.env` file:

```env
BOT_TOKEN=           # Telegram bot token from @BotFather
DATABASE_URL=        # Neon PostgreSQL connection string
ENCRYPTION_KEY=      # 64-char hex string for encrypting wallet keys
SOLANA_RPC_URL=      # Solana RPC endpoint (devnet)
TXLINE_JWT=          # TxLINE JWT token
TXLINE_API_TOKEN=    # TxLINE API token
```

Generate an encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Push Database Schema

```bash
pnpm db:push
```

### Run

```bash
# Development (hot reload)
pnpm dev

# Production
pnpm build
pnpm start
```

## Bot Commands

### DM Commands

| Command | Description |
|---------|-------------|
| `/start` | Create wallet and account |
| `/balance` | Check SOL balance |
| `/address` | Show wallet address |
| `/deposit` | Get deposit instructions |
| `/withdraw <amount> <address>` | Withdraw SOL |

### Group Commands

| Command | Description |
|---------|-------------|
| `/createmarket <amount>` | Create a new bet market |
| `/resolve <id>` | Resolve a market and pay out winners |

## Project Structure

```
src/
  index.ts              Entry point
  env.ts                Environment config
  utils/crypto.ts       AES-256-GCM encrypt/decrypt
  db/schema.ts          Drizzle schema (users, markets, bets)
  db/index.ts           Neon DB connection
  solana/wallet.ts      Keypair generation, balance, transfers
  bot/commands.ts       DM command handlers
  bot/market.ts         Group market creation and resolution
  bot/callbacks.ts      Inline button handlers (fixture/type selection, betting)
  txline/client.ts      TxLINE API client (fixtures, scores, resolution)
  resolver/index.ts     Market settlement logic (pro-rata payouts)
```

## Built By

- **Arjun** -- [GitHub](https://github.com/aarjn) / [Twitter](https://x.com/4rjunc)
- **Manoj** -- [GitHub](https://github.com/Manudasari265) / [Twitter](https://x.com/boomheadvt)
