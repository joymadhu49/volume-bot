# Volume Bot — Uniswap V4 on Base

Auto volume bot for tokens on Uniswap V4 (Base chain).
Runs as either a **terminal dashboard** (CLI) or a **Telegram bot**.

---

## Setup

### 1. Clone & install
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
PRIVATE_KEY=your_private_key       # auto-imported on first run
BOT_TOKEN=your_telegram_bot_token  # only needed for Telegram mode
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

## First-Time Setup (in SETTINGS)

1. **Import Wallet** — paste your private key (stored encrypted locally in `users.json`)
2. **Set Token Address** — paste the token contract address (auto-discovers the V4 pool)
3. **Set Min/Max Amount** — e.g. `0.05` / `0.10` (USD per trade)
4. **Set Min/Max Interval** — e.g. `10` / `30` (seconds between trades)

> Your wallet needs ETH on Base for gas + trade amounts.
> Recommended minimum: **0.02 ETH**

### Pool Discovery

When you set a token address, the bot automatically:
1. Fetches token info (symbol, decimals)
2. Probes common V4 pool configurations via `PoolManager.getSlot0`
3. Falls back to scanning `Initialize` events (covers ~115 days of history)

This works for standard pools **and** Clanker-launched tokens with custom hooks/dynamic fees.

If auto-discovery fails, use **Set Pool Key (Manual)** and enter:
```
fee tickSpacing [hooksAddress]
```
Example for a standard 0.3% pool: `3000 60`
Example with a custom hook: `8388608 200 0xbB7784A4d481184283Ed89619A3e3ed143e1Adc0`

---

## Terminal Dashboard Controls

| Key    | Action            |
|--------|-------------------|
| Up/Down | Navigate menu    |
| Enter  | Select            |
| R      | Refresh balances  |
| Q      | Quit              |
| Escape | Back / cancel     |

### Menu Options
- **START BOT** — auto buy/sell loop using your configured settings
- **STOP BOT** — pause the loop
- **BUY TOKEN** — manual buy (random, custom amount, or preset $1/$5/$10)
- **SELL TOKEN** — manual sell (25%, 50%, 75%, 100%, or custom %)
- **SETTINGS** — configure wallet, token, pool key, trade amounts, intervals

---

## Chain & Contracts (Base Mainnet)

| Contract            | Address                                      |
|---------------------|----------------------------------------------|
| Universal Router V4 | `0x6ff5693b99212da76ad316178a184ab56d299b43`  |
| Pool Manager        | `0x498581ff718922c3f8e6a244956af099b2652b2b`  |
| Permit2             | `0x000000000022D473030F116dDEE9F6B43aC78BA3`  |
| WETH                | `0x4200000000000000000000000000000000000006`  |

---

## Notes
- `users.json` and `.env` are **gitignored** — never committed (contains keys)
- WETH is automatically unwrapped to ETH after every sell
- Nonce management built-in — safe to run multiple operations simultaneously
- PnL tracking shown in the CONFIG & PnL panel (buy/sell totals + gas spent)
