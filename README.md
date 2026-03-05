# Volume Bot — Uniswap V4 on Base

Auto volume bot for tokens on Uniswap V4 (Base chain).  
Runs as either a **terminal dashboard** (CLI) or a **Telegram bot**.

---

## Setup

### 1. Clone
```bash
git clone https://github.com/joymadhu49/volume-bot.git
cd volume-bot
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```
Edit `.env`:
```
RPC_URL=https://mainnet.base.org
BOT_TOKEN=your_telegram_bot_token   # only needed for Telegram mode
```

### 3. Run

**Terminal Dashboard (recommended)**
```bash
node cli.js
```

**Telegram Bot**
```bash
node index.js
```

---

## Terminal Dashboard Controls

| Key    | Action                        |
|--------|-------------------------------|
| ↑ / ↓  | Navigate menu                 |
| Enter  | Select                        |
| Q      | Quit                          |
| Escape | Back / cancel                 |

### Menu Options
- **START BOT** — auto buy/sell loop using your configured settings
- **STOP BOT** — pause the loop
- **BUY (random amount)** — one manual buy within your configured USD range
- **SELL 100%** — sell your full token balance
- **SETTINGS** — configure wallet, trade amounts, intervals

---

## First-time Setup (in SETTINGS)

1. **Import Wallet** — paste your private key (stored encrypted locally)
2. **Set Min/Max Amount** — e.g. `0.10` / `0.50` (USD per trade)
3. **Set Min/Max Interval** — e.g. `10` / `30` (seconds between trades)

> Your wallet needs ETH on Base for gas + trade amounts.  
> Recommended minimum: **0.02 ETH**

---

## Token Config

Default token: **MIME** (`0x3FD2Fc170d2E75BB0EC5B1409fB64EF811A0fBa3`)

To change token, edit `users.json` (created on first run) or update `db.js` defaults.

---

## Chain & Contracts (Base Mainnet)

| Contract         | Address |
|-----------------|---------|
| Universal Router V4 | `0x6ff5693b99212da76ad316178a184ab56d299b43` |
| Pool Manager    | `0x498581ff718922c3f8e6a244956af099b2652b2b` |
| Permit2         | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| WETH            | `0x4200000000000000000000000000000000000006` |

---

## Notes
- `users.json` and `.env` are **gitignored** — never committed (contains keys)
- WETH is automatically unwrapped to ETH after every sell
- Nonce management built-in — safe to run multiple operations simultaneously
