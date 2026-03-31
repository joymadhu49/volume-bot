#!/usr/bin/env node
'use strict';
require('dotenv').config();

const blessed = require('blessed');
const { ethers } = require('ethers');
const { getUser, updateUser, createUser } = require('./db');
const { decrypt, encrypt, getEthPrice, randomBetween } = require('./utils');
const trader  = require('./trader');
const fs      = require('fs');
const path    = require('path');

const USER_ID  = 7332734457;
const WETH     = '0x4200000000000000000000000000000000000006';
const BASESCAN = 'https://basescan.org/tx/';

// ─── Pool Key Builder ───────────────────────────────────────────────────
function poolKeyFromUser(user) {
  if (user.fee_tier == null || user.tick_spacing == null || user.hook_address == null || !user.token_address) return null;
  const tokenLower = user.token_address.toLowerCase();
  const wethLower  = WETH.toLowerCase();
  return {
    currency0:   tokenLower < wethLower ? user.token_address : WETH,
    currency1:   tokenLower < wethLower ? WETH : user.token_address,
    fee:         user.fee_tier,
    tickSpacing: user.tick_spacing,
    hooks:       user.hook_address,
  };
}

// ─── Color Palette ──────────────────────────────────────────────────────
const C = {
  bg:       '#0d1117',
  bgAlt:    '#161b22',
  border:   '#30363d',
  focus:    '#58a6ff',
  accent:   '#238636',
  text:     '#c9d1d9',
  dim:      '#8b949e',
  success:  '#3fb950',
  error:    '#f85149',
  warn:     '#d29922',
  info:     '#58a6ff',
  purple:   '#bc8cff',
};

// ─── State ──────────────────────────────────────────────────────────────
let running             = false;
let tradeTimer          = null;
let nextTradeIn         = 0;
let totalCountdownSecs  = 0;
let countdownTimer      = null;
let pendingMsg          = '';
let menuActions         = [];

// ─── Auto-create + auto-import ──────────────────────────────────────────
if (!getUser(USER_ID)) createUser(USER_ID);
(function autoImport() {
  const u = getUser(USER_ID);
  if (!u.wallet_encrypted && process.env.PRIVATE_KEY) {
    try {
      const w = new ethers.Wallet(process.env.PRIVATE_KEY);
      updateUser(USER_ID, { wallet_encrypted: encrypt(process.env.PRIVATE_KEY), wallet_address: w.address });
    } catch {}
  }
})();

// ─── Screen ─────────────────────────────────────────────────────────────
const screen = blessed.screen({
  smartCSR: true, title: 'Volume Bot',
  fullUnicode: true, forceUnicode: true,
  ignoreLocked: ['C-c'],
});

// ─── TOP BAR ────────────────────────────────────────────────────────────
const topBar = blessed.box({
  top: 0, left: 0, width: '100%', height: 5,
  tags: true,
  border: { type: 'line' },
  style: { bg: C.bg, border: { fg: C.border } },
  padding: { left: 1 },
});

// ─── LEFT: Menu ─────────────────────────────────────────────────────────
const menuBox = blessed.list({
  top: 5, left: 0, width: '25%', height: '55%-5',
  label: ' {bold}{cyan-fg} ACTIONS {/cyan-fg}{/bold} ',
  tags: true,
  border: { type: 'line' },
  style: {
    bg: C.bg, border: { fg: C.focus },
    selected: { bg: C.accent, fg: 'white', bold: true },
    item: { fg: C.text },
    label: { fg: 'cyan' },
  },
  keys: true, vi: false, mouse: true,
  padding: { left: 1, top: 1 },
  items: [],
});

// ─── RIGHT TOP: Balances ────────────────────────────────────────────────
const balBox = blessed.box({
  top: 5, right: 0, width: '75%', height: '25%',
  label: ' {bold}{yellow-fg} BALANCES {/yellow-fg}{/bold} ',
  tags: true,
  border: { type: 'line' },
  style: { bg: C.bg, border: { fg: C.border } },
  padding: { left: 2, top: 1 },
  content: '{gray-fg}Loading...{/gray-fg}',
});

// ─── RIGHT BOTTOM: Config Info ──────────────────────────────────────────
const infoBox = blessed.box({
  top: '25%+5', right: 0, width: '75%',
  bottom: '40%+3',
  label: ' {bold}{magenta-fg} CONFIG & PnL {/magenta-fg}{/bold} ',
  tags: true,
  border: { type: 'line' },
  style: { bg: C.bg, border: { fg: C.border } },
  padding: { left: 2, top: 0 },
  content: '',
});

// ─── TRADE LOG ──────────────────────────────────────────────────────────
const logBox = blessed.log({
  bottom: 3, left: 0, width: '100%', height: '40%',
  label: ' {bold}{green-fg} TRADE LOG {/green-fg}{/bold} ',
  tags: true,
  border: { type: 'line' },
  style: { bg: C.bg, border: { fg: C.border }, scrollbar: { bg: C.accent } },
  padding: { left: 1 },
  scrollable: true, alwaysScroll: true, mouse: true,
  scrollbar: { ch: ' ', track: { bg: C.bgAlt } },
});

// ─── BOTTOM BAR ─────────────────────────────────────────────────────────
const botBar = blessed.box({
  bottom: 0, left: 0, width: '100%', height: 3,
  tags: true,
  border: { type: 'line' },
  style: { bg: C.bgAlt, fg: C.dim, border: { fg: C.border } },
});

screen.append(topBar);
screen.append(menuBox);
screen.append(balBox);
screen.append(infoBox);
screen.append(logBox);
screen.append(botBar);
menuBox.focus();

// ─── Dynamic Menu Builder ───────────────────────────────────────────────
function rebuildMenu() {
  const user = getUser(USER_ID) || {};
  const hasWallet = !!user.wallet_encrypted;
  const hasToken  = !!user.token_address;
  const hasPool   = !!poolKeyFromUser(user);
  const sym       = user.token_symbol || 'TOKEN';
  const ready     = hasWallet && hasPool;

  const prevIdx = menuBox.selected || 0;
  const items   = [];
  menuActions   = [];

  if (!hasWallet || !hasToken) {
    items.push(' \u26A1  QUICK SETUP');
    menuActions.push(() => openWizard());
  }

  if (ready) {
    if (running) {
      items.push(' \u25A0  STOP BOT');
      menuActions.push(() => stopBot());
    } else {
      items.push(' \u25B6  START BOT');
      menuActions.push(() => startBot());
    }
  }

  if (hasWallet) {
    items.push(` \u2B06  BUY ${hasToken ? sym : 'TOKEN'}`);
    menuActions.push(() => openBuyMenu());
    items.push(` \u2B07  SELL ${hasToken ? sym : 'TOKEN'}`);
    menuActions.push(() => openSellMenu());
  }

  if ((user.trade_history || []).length > 0) {
    items.push(' \u2502  TRADE HISTORY');
    menuActions.push(() => openTradeHistory());
  }

  items.push(' \u2699  SETTINGS');
  menuActions.push(() => openSettings());
  items.push(' \u2716  QUIT');
  menuActions.push(() => { stopBot(); screen.destroy(); process.exit(0); });

  menuBox.setItems(items);
  menuBox.select(Math.min(prevIdx, items.length - 1));
  updateBottomBar();
  screen.render();
}

function updateBottomBar() {
  const user = getUser(USER_ID) || {};
  const hasWallet = !!user.wallet_encrypted;
  const ready     = hasWallet && !!poolKeyFromUser(user);
  let hints = '{gray-fg} \u2191/\u2193 Navigate   Enter Select   R Refresh   Q Quit';
  if (ready)     hints += '   Space Start/Stop';
  if (hasWallet) hints += '   B Buy   S Sell';
  hints += ' {/gray-fg}';
  botBar.setContent(`{center}${hints}{/center}`);
}

// ─── PROGRESS BAR ───────────────────────────────────────────────────────
function makeProgressBar(current, total, width) {
  width = width || 15;
  if (total <= 0) return '';
  const filled = Math.round((1 - current / total) * width);
  const empty  = width - filled;
  return '{green-fg}' + '\u2588'.repeat(filled) + '{/green-fg}' +
         '{gray-fg}' + '\u2591'.repeat(empty)  + '{/gray-fg}';
}

// ─── TOP BAR UPDATE ─────────────────────────────────────────────────────
function updateTopBar() {
  const user   = getUser(USER_ID) || {};
  const status = running
    ? '{green-fg}{bold}\u25CF RUNNING{/bold}{/green-fg}'
    : '{red-fg}{bold}\u25CF STOPPED{/bold}{/red-fg}';
  const next = running && nextTradeIn > 0
    ? `  ${makeProgressBar(nextTradeIn, totalCountdownSecs, 12)} {yellow-fg}${nextTradeIn}s{/yellow-fg}`
    : '';
  const trades = `{cyan-fg}Trades: ${user.trade_count || 0}{/cyan-fg}`;
  const now    = new Date().toLocaleTimeString('en-US', { hour12: false });
  const pend   = pendingMsg ? `  {yellow-fg}\u23F3 ${pendingMsg}{/yellow-fg}` : '';

  const logo       = `{bold}{#58a6ff-fg}\u25C8 VOLUME BOT{/#58a6ff-fg}{/bold}  {gray-fg}\u2502{/gray-fg}  {white-fg}Uniswap V4 \u2022 Base Network{/white-fg}`;
  const statusLine = `  ${status}   ${next}   ${trades}${pend}   {gray-fg}${now}{/gray-fg}`;

  topBar.setContent(`${logo}\n\n${statusLine}`);
  screen.render();
}

// ─── PnL CALCULATION ────────────────────────────────────────────────────
function calculatePnL() {
  const user    = getUser(USER_ID) || {};
  const history = user.trade_history || [];
  let totalBuyUsd = 0, totalSellUsd = 0, totalGasEth = 0;
  for (const t of history) {
    if (t.type === 'buy') totalBuyUsd += t.amountUsd || 0;
    else totalSellUsd += t.amountUsd || 0;
    totalGasEth += parseFloat(t.gasUsed || '0');
  }
  return { totalBuyUsd, totalSellUsd, totalGasEth, net: totalSellUsd - totalBuyUsd };
}

// ─── INFO BOX UPDATE (pool details + decimals) ─────────────────────────
function updateInfo() {
  const user = getUser(USER_ID) || {};
  const wallet = user.wallet_address
    ? `{cyan-fg}${user.wallet_address.slice(0,10)}...${user.wallet_address.slice(-6)}{/cyan-fg}`
    : '{red-fg}NOT SET \u2014 use QUICK SETUP or SETTINGS{/red-fg}';
  const poolKey  = poolKeyFromUser(user);
  const decimals = user.token_decimals != null ? user.token_decimals : 18;
  const pool = poolKey
    ? `{green-fg}Fee: ${poolKey.fee} | Tick: ${poolKey.tickSpacing}${poolKey.hooks !== ethers.ZeroAddress ? ` | Hook: ${poolKey.hooks.slice(0,10)}...` : ''}{/green-fg}`
    : '{yellow-fg}No pool \u2014 set a token address to auto-discover{/yellow-fg}';
  const pnl      = calculatePnL();
  const pnlColor = pnl.net >= 0 ? 'green-fg' : 'red-fg';

  infoBox.setContent(
    ` Wallet   : ${wallet}\n` +
    ` Token    : {cyan-fg}${user.token_symbol || 'NOT SET'}{/cyan-fg}  {gray-fg}${user.token_address ? `${user.token_address.slice(0,12)}... (${decimals} dec)` : ''}{/gray-fg}\n` +
    ` Pool     : ${pool}\n` +
    ` Amount   : {yellow-fg}$${(user.min_amount_usd || 0.10).toFixed(2)} \u2013 $${(user.max_amount_usd || 0.50).toFixed(2)}{/yellow-fg}   Interval: {yellow-fg}${user.min_interval_sec || 20}s \u2013 ${user.max_interval_sec || 60}s{/yellow-fg}\n` +
    ` PnL      : {${pnlColor}}$${pnl.net.toFixed(2)}{/${pnlColor}}  {gray-fg}(Buy: $${pnl.totalBuyUsd.toFixed(2)} | Sell: $${pnl.totalSellUsd.toFixed(2)} | Gas: ${pnl.totalGasEth.toFixed(4)} ETH){/gray-fg}`
  );
  screen.render();
}

// ─── BALANCES (pass correct token decimals) ─────────────────────────────
async function refreshBalances() {
  const user = getUser(USER_ID) || {};
  if (!user.wallet_address) {
    balBox.setContent('{red-fg}  No wallet \u2014 use QUICK SETUP or SETTINGS to import{/red-fg}');
    screen.render();
    return;
  }
  balBox.setContent('{gray-fg}  Fetching...{/gray-fg}');
  screen.render();
  try {
    const decimals = user.token_decimals || 18;
    const bal = await trader.getBalances(user.wallet_address, user.token_address, decimals);
    const sym = bal.tokenSymbol || user.token_symbol || 'TOKEN';
    const ethUsd  = bal.ethUsd   ? `{gray-fg}  ~$${bal.ethUsd}{/gray-fg}` : '';
    const wethUsd = bal.wethUsd  ? `{gray-fg}  ~$${bal.wethUsd}{/gray-fg}` : '';
    const tokUsd  = bal.tokenUsd ? `{gray-fg}  ~$${bal.tokenUsd}{/gray-fg}` : '';
    let content = ` {white-fg}ETH   {/white-fg}  {green-fg}{bold}${bal.eth}{/bold}{/green-fg}${ethUsd}\n`;
    if (bal.weth)
      content += ` {white-fg}WETH  {/white-fg}  {yellow-fg}${bal.weth}{/yellow-fg}${wethUsd}\n`;
    if (user.token_address)
      content += ` {white-fg}${sym.padEnd(6)}{/white-fg}  {cyan-fg}{bold}${bal.token}{/bold}{/cyan-fg}${tokUsd}`;
    else
      content += ' {gray-fg}Set a token address to see balance{/gray-fg}';
    balBox.setContent(content);
  } catch (e) {
    balBox.setContent(`{red-fg}  Error: ${e.message.slice(0,60)}{/red-fg}`);
  }
  screen.render();
}

// ─── LOG ────────────────────────────────────────────────────────────────
function addLog(msg) {
  const t = new Date().toLocaleTimeString('en-US', { hour12: false });
  logBox.log(`{gray-fg}${t}{/gray-fg}  ${msg}`);
  screen.render();
}

// ─── GAS DISPLAY HELPER ────────────────────────────────────────────────
function formatGas(receipt) {
  try {
    const gasUsed  = receipt.gasUsed || 0n;
    const gasPrice = receipt.gasPrice || receipt.effectiveGasPrice || 0n;
    return parseFloat(ethers.formatEther(gasUsed * gasPrice)).toFixed(6);
  } catch { return '?'; }
}

// ─── TRADE HISTORY HELPER ──────────────────────────────────────────────
function recordTrade(type, amountUsd, amountEth, receipt) {
  const user    = getUser(USER_ID) || {};
  const history = (user.trade_history || []).slice(-99);
  history.push({
    type,
    amountUsd: amountUsd || 0,
    amountEth: amountEth || 0,
    txHash:    receipt.hash,
    gasUsed:   formatGas(receipt),
    timestamp: Date.now(),
  });
  updateUser(USER_ID, { trade_count: (user.trade_count || 0) + 1, trade_history: history });
}

// ─── COUNTDOWN ──────────────────────────────────────────────────────────
function startCountdown(seconds) {
  nextTradeIn        = seconds;
  totalCountdownSecs = seconds;
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    nextTradeIn = Math.max(0, nextTradeIn - 1);
    updateTopBar();
    if (nextTradeIn === 0) clearInterval(countdownTimer);
  }, 1000);
}

// ─── TRADING (uses correct token decimals) ──────────────────────────────
async function runTrade() {
  if (!running) return;
  const user     = getUser(USER_ID);
  const poolKey  = poolKeyFromUser(user);
  const decimals = user.token_decimals || 18;
  if (!poolKey) { addLog('{red-fg}\u2717 Pool key not configured \u2014 go to SETTINGS \u2192 Set Token Address{/red-fg}'); stopBot(); return; }
  const ethPrice = await getEthPrice().catch(() => 2000);
  const usdAmt   = randomBetween(user.min_amount_usd, user.max_amount_usd);
  const ethAmt   = usdAmt / ethPrice;
  const pk       = decrypt(user.wallet_encrypted);
  const isBuy    = Math.random() > 0.3;

  try {
    if (isBuy) {
      pendingMsg = 'Buying...'; updateTopBar();
      addLog(`{yellow-fg}\u25B2 BUY{/yellow-fg}   $${usdAmt.toFixed(2)}  (${ethAmt.toFixed(6)} ETH)`);
      const r   = await trader.buyToken(pk, user.token_address, ethAmt, null, poolKey);
      const gas = formatGas(r);
      recordTrade('buy', usdAmt, ethAmt, r);
      addLog(`{green-fg}\u2713 BUY OK{/green-fg}  #${(user.trade_count || 0) + 1}  {gray-fg}Gas: ${gas} ETH{/gray-fg}`);
      addLog(`{gray-fg}  \u2514\u2500 ${BASESCAN}${r.hash}{/gray-fg}`);
    } else {
      const pct = Math.floor(randomBetween(5, 15));
      pendingMsg = 'Selling...'; updateTopBar();
      addLog(`{magenta-fg}\u25BC SELL{/magenta-fg}  ${pct}% of ${user.token_symbol || 'TOKEN'}`);
      const r   = await trader.sellToken(pk, user.token_address, pct, null, decimals, poolKey);
      const gas = formatGas(r);
      recordTrade('sell', 0, 0, r);
      addLog(`{green-fg}\u2713 SELL OK{/green-fg} #${(user.trade_count || 0) + 1}  {gray-fg}Gas: ${gas} ETH{/gray-fg}`);
      addLog(`{gray-fg}  \u2514\u2500 ${BASESCAN}${r.hash}{/gray-fg}`);
    }
  } catch (e) {
    const msg = (e.shortMessage || e.reason || e.message || '').slice(0, 80);
    addLog(`{red-fg}\u2717 TRADE FAILED{/red-fg}  ${msg}`);
  }

  pendingMsg = ''; updateTopBar();
  updateInfo(); rebuildMenu();
  await refreshBalances();

  if (running) {
    const delay = Math.floor(randomBetween(user.min_interval_sec, user.max_interval_sec));
    addLog(`{gray-fg}\u23F1 Next trade in ${delay}s...{/gray-fg}`);
    startCountdown(delay);
    tradeTimer = setTimeout(runTrade, delay * 1000);
  }
}

function startBot() {
  const user = getUser(USER_ID);
  if (!user?.wallet_encrypted) { addLog('{red-fg}\u2717 No wallet \u2014 import one first{/red-fg}'); return; }
  if (!poolKeyFromUser(user))  { addLog('{red-fg}\u2717 No pool configured \u2014 set a token address first{/red-fg}'); return; }
  if (running) { addLog('{gray-fg}Already running{/gray-fg}'); return; }
  running = true;
  addLog('{green-fg}{bold}\u2500\u2500\u2500 BOT STARTED \u2500\u2500\u2500{/bold}{/green-fg}');
  updateTopBar(); updateInfo(); rebuildMenu();
  runTrade();
}

function stopBot() {
  if (!running) return;
  running = false;
  pendingMsg = '';
  if (tradeTimer)    { clearTimeout(tradeTimer);    tradeTimer    = null; }
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  nextTradeIn = 0;
  addLog('{red-fg}{bold}\u2500\u2500\u2500 BOT STOPPED \u2500\u2500\u2500{/bold}{/red-fg}');
  updateTopBar(); updateInfo(); rebuildMenu();
}

async function doBuy(usdAmt) {
  const user = getUser(USER_ID);
  if (!user?.wallet_encrypted) { addLog('{red-fg}\u2717 No wallet \u2014 import one first{/red-fg}'); return; }
  const poolKey = poolKeyFromUser(user);
  if (!poolKey) { addLog('{red-fg}\u2717 No pool configured \u2014 set a token address first{/red-fg}'); return; }
  const ethPrice = await getEthPrice().catch(() => 2000);
  const ethAmt   = usdAmt / ethPrice;
  pendingMsg = 'Buying...'; updateTopBar();
  addLog(`{yellow-fg}\u25B2 BUY{/yellow-fg}   $${usdAmt.toFixed(2)} (manual)`);
  try {
    const r   = await trader.buyToken(decrypt(user.wallet_encrypted), user.token_address, ethAmt, null, poolKey);
    const gas = formatGas(r);
    recordTrade('buy', usdAmt, ethAmt, r);
    addLog(`{green-fg}\u2713 BUY OK{/green-fg}  {gray-fg}Gas: ${gas} ETH{/gray-fg}`);
    addLog(`{gray-fg}  \u2514\u2500 ${BASESCAN}${r.hash}{/gray-fg}`);
    await refreshBalances();
  } catch (e) { addLog(`{red-fg}\u2717 BUY FAILED{/red-fg}  ${(e.shortMessage || e.reason || e.message || '').slice(0, 80)}`); }
  pendingMsg = ''; updateTopBar(); updateInfo(); rebuildMenu();
}

async function doSell(pct) {
  const wasRunning = running;
  if (running) stopBot();
  const user = getUser(USER_ID);
  if (!user?.wallet_encrypted) { addLog('{red-fg}\u2717 No wallet \u2014 import one first{/red-fg}'); return; }
  const poolKey = poolKeyFromUser(user);
  if (!poolKey) { addLog('{red-fg}\u2717 No pool configured \u2014 set a token address first{/red-fg}'); if (wasRunning) startBot(); return; }
  const decimals = user.token_decimals || 18;
  pendingMsg = 'Selling...'; updateTopBar();
  addLog(`{magenta-fg}\u25BC SELL{/magenta-fg}  ${pct}% (manual)`);
  try {
    const r   = await trader.sellToken(decrypt(user.wallet_encrypted), user.token_address, pct, null, decimals, poolKey);
    const gas = formatGas(r);
    recordTrade('sell', 0, 0, r);
    addLog(`{green-fg}\u2713 SELL OK{/green-fg}  {gray-fg}Gas: ${gas} ETH{/gray-fg}`);
    addLog(`{gray-fg}  \u2514\u2500 ${BASESCAN}${r.hash}{/gray-fg}`);
    await refreshBalances();
  } catch (e) { addLog(`{red-fg}\u2717 SELL FAILED{/red-fg}  ${(e.shortMessage || e.reason || e.message || '').slice(0, 80)}`); }
  pendingMsg = ''; updateTopBar(); updateInfo(); rebuildMenu();
  if (wasRunning) startBot();
}

async function doUnwrapWETH() {
  const user = getUser(USER_ID);
  if (!user?.wallet_encrypted) { addLog('{red-fg}\u2717 No wallet \u2014 import one first{/red-fg}'); return; }
  pendingMsg = 'Unwrapping WETH...'; updateTopBar();
  addLog('{yellow-fg}\u{1F504} UNWRAP{/yellow-fg}  WETH \u2192 ETH');
  try {
    const pk     = decrypt(user.wallet_encrypted);
    const wallet = new ethers.Wallet(pk, new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://mainnet.base.org'));
    await trader.unwrapWETH(wallet);
    addLog('{green-fg}\u2713 UNWRAP OK{/green-fg}  WETH converted to ETH');
    await refreshBalances();
  } catch (e) { addLog(`{red-fg}\u2717 UNWRAP FAILED{/red-fg}  ${(e.shortMessage || e.reason || e.message || '').slice(0, 80)}`); }
  pendingMsg = ''; updateTopBar();
}

// ─── Prompt Helper (returns value or null on Esc) ───────────────────────
function promptInput(label, opts = {}) {
  return new Promise((resolve) => {
    const inputBox = blessed.textbox({
      top: 'center', left: 'center',
      width: opts.width || 56, height: opts.height || 5,
      label: `  ${label}  `,
      tags: true, border: { type: 'line' },
      style: { bg: C.bg, border: { fg: C.focus }, fg: 'white' },
      inputOnFocus: true,
      censor: opts.censor || false,
    });
    screen.append(inputBox);
    inputBox.focus();
    screen.render();
    inputBox.on('submit', (val) => { inputBox.destroy(); screen.render(); resolve(val ? val.trim() : ''); });
    inputBox.key(['escape'], () => { inputBox.destroy(); screen.render(); resolve(null); });
  });
}

// ═══════════════════════════════════════════════════════════════════════
//  QUICK SETUP WIZARD
// ═══════════════════════════════════════════════════════════════════════
async function openWizard() {
  const user = getUser(USER_ID) || {};

  addLog('{cyan-fg}{bold}\u2500\u2500\u2500 QUICK SETUP \u2500\u2500\u2500{/bold}{/cyan-fg}');
  addLog('{gray-fg}Follow the prompts to configure your bot step by step.{/gray-fg}');

  // Step 1: Wallet
  if (!user.wallet_encrypted) {
    addLog('{cyan-fg}Step 1/4:{/cyan-fg} Import your wallet private key');
    const pk = await promptInput('Private Key (hidden, press Enter):', { censor: true });
    if (pk === null || pk === '') { addLog('{gray-fg}Setup cancelled.{/gray-fg}'); menuBox.focus(); return; }
    try {
      const w = new ethers.Wallet(pk);
      updateUser(USER_ID, { wallet_encrypted: encrypt(pk), wallet_address: w.address });
      const envPath = path.join(__dirname, '.env');
      let envRaw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
      envRaw = envRaw.match(/^PRIVATE_KEY=/m)
        ? envRaw.replace(/^PRIVATE_KEY=.*/m, `PRIVATE_KEY=${pk}`)
        : envRaw + `\nPRIVATE_KEY=${pk}`;
      fs.writeFileSync(envPath, envRaw);
      addLog(`{green-fg}\u2713{/green-fg} Wallet imported: {cyan-fg}${w.address}{/cyan-fg}`);
    } catch (e) {
      addLog(`{red-fg}\u2717 Invalid private key \u2014 check the format and try again in SETTINGS{/red-fg}`);
      menuBox.focus(); rebuildMenu(); return;
    }
  } else {
    addLog(`{green-fg}\u2713{/green-fg} Wallet already loaded: {cyan-fg}${user.wallet_address}{/cyan-fg}`);
  }

  // Step 2: Token Address
  addLog('{cyan-fg}Step 2/4:{/cyan-fg} Enter the token contract address');
  const addr = await promptInput('Token address (0x...):', { width: 60 });
  if (addr === null || addr === '') {
    addLog('{gray-fg}Skipped \u2014 you can set the token later in SETTINGS.{/gray-fg}');
    menuBox.focus(); rebuildMenu(); refreshBalances(); return;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    addLog('{red-fg}\u2717 Invalid address \u2014 must be 0x followed by 40 hex characters{/red-fg}');
    menuBox.focus(); rebuildMenu(); refreshBalances(); return;
  }

  addLog('{gray-fg}\u23F3 Fetching token info...{/gray-fg}');
  try {
    const info = await trader.getTokenInfo(addr);
    addLog(`{green-fg}\u2713{/green-fg} Token: {cyan-fg}${info.symbol}{/cyan-fg} (${info.decimals} decimals)`);
    updateUser(USER_ID, { token_address: addr, token_symbol: info.symbol, token_decimals: info.decimals });

    addLog('{gray-fg}\u23F3 Discovering V4 pool... (this may take a moment){/gray-fg}');
    const poolKey = await trader.discoverPoolKey(addr);
    if (poolKey) {
      updateUser(USER_ID, { fee_tier: poolKey.fee, tick_spacing: poolKey.tickSpacing, hook_address: poolKey.hooks });
      const hookInfo = poolKey.hooks !== ethers.ZeroAddress ? `  Hook: ${poolKey.hooks.slice(0,12)}...` : '';
      addLog(`{green-fg}\u2713 Pool found!{/green-fg}  Fee: ${poolKey.fee}  Spacing: ${poolKey.tickSpacing}${hookInfo}`);
    } else {
      addLog('{yellow-fg}\u26A0 No V4 pool found \u2014 use SETTINGS \u2192 Set Pool Key (Manual){/yellow-fg}');
    }
  } catch (e) {
    addLog(`{red-fg}\u2717 Error: ${(e.shortMessage || e.message || '').slice(0,60)}{/red-fg}`);
    menuBox.focus(); rebuildMenu(); refreshBalances(); return;
  }

  // Step 3: Trade Amounts
  addLog('{cyan-fg}Step 3/4:{/cyan-fg} Set trade amount range (USD per trade)');
  const amtStr = await promptInput('Min and Max USD, e.g. 0.10 0.50:');
  if (amtStr !== null && amtStr.length > 0) {
    const parts = amtStr.split(/[\s,]+/);
    const minA  = parseFloat(parts[0]);
    const maxA  = parseFloat(parts[1] || parts[0]);
    if (!isNaN(minA) && !isNaN(maxA) && minA > 0 && maxA >= minA) {
      updateUser(USER_ID, { min_amount_usd: minA, max_amount_usd: maxA });
      addLog(`{green-fg}\u2713{/green-fg} Amount range: {yellow-fg}$${minA.toFixed(2)} \u2013 $${maxA.toFixed(2)}{/yellow-fg}`);
    } else {
      addLog('{yellow-fg}\u26A0 Invalid range \u2014 keeping defaults ($0.10 \u2013 $0.50){/yellow-fg}');
    }
  } else {
    addLog('{gray-fg}Keeping default: $0.10 \u2013 $0.50{/gray-fg}');
  }

  // Step 4: Trade Intervals
  addLog('{cyan-fg}Step 4/4:{/cyan-fg} Set trade interval range (seconds between trades)');
  const intStr = await promptInput('Min and Max seconds, e.g. 20 60:');
  if (intStr !== null && intStr.length > 0) {
    const parts = intStr.split(/[\s,]+/);
    const minI  = parseInt(parts[0]);
    const maxI  = parseInt(parts[1] || parts[0]);
    if (!isNaN(minI) && !isNaN(maxI) && minI >= 5 && maxI >= minI) {
      updateUser(USER_ID, { min_interval_sec: minI, max_interval_sec: maxI });
      addLog(`{green-fg}\u2713{/green-fg} Interval range: {yellow-fg}${minI}s \u2013 ${maxI}s{/yellow-fg}`);
    } else {
      addLog('{yellow-fg}\u26A0 Invalid range (min 5s) \u2014 keeping defaults (20s \u2013 60s){/yellow-fg}');
    }
  } else {
    addLog('{gray-fg}Keeping default: 20s \u2013 60s{/gray-fg}');
  }

  addLog('{green-fg}{bold}\u2500\u2500\u2500 SETUP COMPLETE \u2500\u2500\u2500{/bold}{/green-fg}');
  const u2 = getUser(USER_ID);
  if (poolKeyFromUser(u2)) {
    addLog('{gray-fg}Select START BOT from the menu to begin trading.{/gray-fg}');
  } else {
    addLog('{gray-fg}Set a pool key in SETTINGS before starting the bot.{/gray-fg}');
  }

  updateInfo(); rebuildMenu(); menuBox.focus();
  refreshBalances();
}

// ═══════════════════════════════════════════════════════════════════════
//  BUY MENU
// ═══════════════════════════════════════════════════════════════════════
function openBuyMenu() {
  const user = getUser(USER_ID) || {};
  const sym  = user.token_symbol || 'TOKEN';
  const minA = user.min_amount_usd || 0.10;
  const maxA = user.max_amount_usd || 0.50;

  const overlay = blessed.box({
    top: 'center', left: 'center', width: 46, height: 17,
    tags: true, border: { type: 'line' },
    label: ` {bold}{yellow-fg} \u25B2 BUY ${sym} {/yellow-fg}{/bold} `,
    style: { bg: C.bgAlt, border: { fg: C.focus } },
  });

  const buyList = blessed.list({
    parent: overlay,
    top: 1, left: 1, right: 1, bottom: 3,
    tags: true,
    style: { bg: C.bgAlt, fg: C.text, selected: { bg: C.accent, fg: 'white', bold: true } },
    keys: true, mouse: true,
    items: [
      `  \u{1F3B2}  Random ($${minA.toFixed(2)} \u2013 $${maxA.toFixed(2)})`,
      '  \u270E  Custom Amount (USD)',
      '  \u25CF  $1.00',
      '  \u25CF  $5.00',
      '  \u25CF  $10.00',
      '  \u25CF  $25.00',
      '  \u25CF  $50.00',
      '  \u2190  Back',
    ],
  });

  blessed.text({
    parent: overlay, bottom: 1, left: 2, right: 2, height: 1, tags: true,
    content: '{gray-fg}Enter: select   Esc: back{/gray-fg}',
    style: { bg: C.bgAlt },
  });

  screen.append(overlay);
  buyList.focus();
  screen.render();

  buyList.on('select', async (item, idx) => {
    if (idx === 7) { overlay.destroy(); menuBox.focus(); screen.render(); return; }
    if (idx === 0) {
      overlay.destroy(); menuBox.focus(); screen.render();
      doBuy(randomBetween(minA, maxA));
      return;
    }
    if (idx >= 2 && idx <= 6) {
      const amounts = [1, 5, 10, 25, 50];
      overlay.destroy(); menuBox.focus(); screen.render();
      doBuy(amounts[idx - 2]);
      return;
    }
    // Custom amount
    overlay.destroy();
    const val = await promptInput('Amount in USD (e.g. 2.50):');
    menuBox.focus();
    if (val === null || val === '') { screen.render(); return; }
    const amt = parseFloat(val);
    if (isNaN(amt) || amt <= 0) { addLog('{red-fg}\u2717 Invalid amount \u2014 enter a positive number{/red-fg}'); screen.render(); return; }
    doBuy(amt);
  });

  buyList.key(['escape'], () => { overlay.destroy(); menuBox.focus(); screen.render(); });
}

// ═══════════════════════════════════════════════════════════════════════
//  SELL MENU (confirmation for 100%)
// ═══════════════════════════════════════════════════════════════════════
function openSellMenu() {
  const user = getUser(USER_ID) || {};
  const sym  = user.token_symbol || 'TOKEN';

  const overlay = blessed.box({
    top: 'center', left: 'center', width: 46, height: 16,
    tags: true, border: { type: 'line' },
    label: ` {bold}{magenta-fg} \u25BC SELL ${sym} {/magenta-fg}{/bold} `,
    style: { bg: C.bgAlt, border: { fg: C.focus } },
  });

  const sellList = blessed.list({
    parent: overlay,
    top: 1, left: 1, right: 1, bottom: 3,
    tags: true,
    style: { bg: C.bgAlt, fg: C.text, selected: { bg: C.accent, fg: 'white', bold: true } },
    keys: true, mouse: true,
    items: [
      '  \u25CF  Sell 25%',
      '  \u25CF  Sell 50%',
      '  \u25CF  Sell 75%',
      '  \u25CF  Sell 100% (all)',
      '  \u270E  Custom %',
      '  \u{1F504}  Unwrap WETH \u2192 ETH',
      '  \u2190  Back',
    ],
  });

  blessed.text({
    parent: overlay, bottom: 1, left: 2, right: 2, height: 1, tags: true,
    content: '{gray-fg}Enter: select   Esc: back{/gray-fg}',
    style: { bg: C.bgAlt },
  });

  screen.append(overlay);
  sellList.focus();
  screen.render();

  sellList.on('select', async (item, idx) => {
    if (idx === 6) { overlay.destroy(); menuBox.focus(); screen.render(); return; }

    // 25%, 50%, 75%
    if (idx >= 0 && idx <= 2) {
      const pcts = [25, 50, 75];
      overlay.destroy(); menuBox.focus(); screen.render();
      doSell(pcts[idx]);
      return;
    }

    // 100% sell — requires confirmation
    if (idx === 3) {
      overlay.destroy();
      const confirm = await promptInput(`Type YES to sell 100% of ${sym}:`);
      menuBox.focus();
      if (confirm !== null && confirm.toUpperCase() === 'YES') {
        doSell(100);
      } else {
        addLog('{gray-fg}100% sell cancelled.{/gray-fg}');
      }
      screen.render();
      return;
    }

    // Custom %
    if (idx === 4) {
      overlay.destroy();
      const val = await promptInput('Sell percentage (1\u2013100):');
      menuBox.focus();
      if (val === null || val === '') { screen.render(); return; }
      const pct = parseInt(val);
      if (isNaN(pct) || pct < 1 || pct > 100) { addLog('{red-fg}\u2717 Invalid percentage (must be 1\u2013100){/red-fg}'); screen.render(); return; }
      if (pct === 100) {
        const confirm = await promptInput(`Type YES to sell 100% of ${sym}:`);
        if (confirm === null || confirm.toUpperCase() !== 'YES') {
          addLog('{gray-fg}100% sell cancelled.{/gray-fg}'); screen.render(); return;
        }
      }
      doSell(pct);
      return;
    }

    // Unwrap WETH
    if (idx === 5) {
      overlay.destroy(); menuBox.focus(); screen.render();
      doUnwrapWETH();
      return;
    }
  });

  sellList.key(['escape'], () => { overlay.destroy(); menuBox.focus(); screen.render(); });
}

// ═══════════════════════════════════════════════════════════════════════
//  TRADE HISTORY VIEWER
// ═══════════════════════════════════════════════════════════════════════
function openTradeHistory() {
  const user    = getUser(USER_ID) || {};
  const history = (user.trade_history || []).slice(-20).reverse();

  const overlay = blessed.box({
    top: 'center', left: 'center', width: 72, height: 24,
    tags: true, border: { type: 'line' },
    label: ' {bold}{cyan-fg} TRADE HISTORY (last 20) {/cyan-fg}{/bold} ',
    style: { bg: C.bgAlt, border: { fg: C.focus } },
    padding: { left: 1, top: 1 },
    scrollable: true, alwaysScroll: true, mouse: true, keys: true,
  });

  if (history.length === 0) {
    overlay.setContent('{gray-fg}No trades yet.{/gray-fg}\n\n{gray-fg}Press Esc to close{/gray-fg}');
  } else {
    let content = '{bold}{gray-fg}  #   Type   Amount        Gas ETH        Time{/gray-fg}{/bold}\n';
    content += ' {gray-fg}' + '\u2500'.repeat(66) + '{/gray-fg}\n';
    for (let i = 0; i < history.length; i++) {
      const t    = history[i];
      const num  = String(history.length - i).padStart(3);
      const type = t.type === 'buy' ? '{yellow-fg}BUY {/yellow-fg}' : '{magenta-fg}SELL{/magenta-fg}';
      const amt  = t.amountUsd > 0 ? `$${t.amountUsd.toFixed(2).padStart(7)}` : '       \u2014';
      const gas  = `${(t.gasUsed || '?').toString().padStart(10)}`;
      const time = new Date(t.timestamp).toLocaleString('en-US', {
        month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      });
      content += `  ${num}   ${type}   ${amt}   {gray-fg}${gas}{/gray-fg}     {gray-fg}${time}{/gray-fg}\n`;
    }
    content += '\n {gray-fg}Press Esc to close{/gray-fg}';
    overlay.setContent(content);
  }

  screen.append(overlay);
  overlay.focus();
  screen.render();

  overlay.key(['escape', 'enter'], () => { overlay.destroy(); menuBox.focus(); screen.render(); });
}

// ═══════════════════════════════════════════════════════════════════════
//  SETTINGS (combined flows, current values, view wallet, reset PnL)
// ═══════════════════════════════════════════════════════════════════════
function openSettings() {
  const user       = getUser(USER_ID) || {};
  const walletHint = user.wallet_address ? `${user.wallet_address.slice(0,8)}...${user.wallet_address.slice(-4)}` : 'not set';
  const tokenHint  = user.token_symbol && user.token_address ? user.token_symbol : 'not set';
  const poolHint   = user.fee_tier != null ? `Fee:${user.fee_tier} Tick:${user.tick_spacing}` : 'not set';
  const amtHint    = `$${(user.min_amount_usd || 0.10).toFixed(2)}\u2013$${(user.max_amount_usd || 0.50).toFixed(2)}`;
  const intHint    = `${user.min_interval_sec || 20}s\u2013${user.max_interval_sec || 60}s`;

  const overlay = blessed.box({
    top: 'center', left: 'center', width: 60, height: 18,
    tags: true, border: { type: 'line' },
    label: ' {bold}{magenta-fg} \u2699 SETTINGS {/magenta-fg}{/bold} ',
    style: { bg: C.bgAlt, border: { fg: C.focus } },
  });

  const settingsList = blessed.list({
    parent: overlay,
    top: 1, left: 1, right: 1, bottom: 3,
    tags: true,
    style: { bg: C.bgAlt, fg: C.text, selected: { bg: '#1f6feb', fg: 'white', bold: true } },
    keys: true, mouse: true,
    items: [
      `  \u{1F511}  Wallet             {gray-fg}${walletHint}{/gray-fg}`,
      `  \u{1F4B0}  Token Address       {gray-fg}${tokenHint}{/gray-fg}`,
      `  \u{1F527}  Pool Key (Manual)   {gray-fg}${poolHint}{/gray-fg}`,
      `  \u{1F4B5}  Trade Amounts       {gray-fg}${amtHint}{/gray-fg}`,
      `  \u23F1   Trade Intervals     {gray-fg}${intHint}{/gray-fg}`,
      '  \u{1F441}   View Wallet Address',
      '  \u{1F504}  Reset PnL & History',
      '  \u2190  Back',
    ],
  });

  blessed.text({
    parent: overlay, bottom: 1, left: 2, right: 2, height: 1, tags: true,
    content: '{gray-fg}Enter: select   Esc: back{/gray-fg}',
    style: { bg: C.bgAlt },
  });

  screen.append(overlay);
  settingsList.focus();
  screen.render();

  settingsList.on('select', async (item, idx) => {
    if (idx === 7) { overlay.destroy(); menuBox.focus(); screen.render(); return; }

    // ── Wallet Import ──
    if (idx === 0) {
      overlay.destroy();
      const pk = await promptInput('Private Key (hidden):', { censor: true });
      menuBox.focus();
      if (pk === null || pk === '') { screen.render(); return; }
      try {
        const w = new ethers.Wallet(pk);
        updateUser(USER_ID, { wallet_encrypted: encrypt(pk), wallet_address: w.address });
        const envPath = path.join(__dirname, '.env');
        let envRaw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
        envRaw = envRaw.match(/^PRIVATE_KEY=/m)
          ? envRaw.replace(/^PRIVATE_KEY=.*/m, `PRIVATE_KEY=${pk}`)
          : envRaw + `\nPRIVATE_KEY=${pk}`;
        fs.writeFileSync(envPath, envRaw);
        addLog(`{green-fg}\u2713{/green-fg} Wallet: {cyan-fg}${w.address}{/cyan-fg}`);
      } catch (e) { addLog(`{red-fg}\u2717 ${(e.shortMessage || e.message || '').slice(0,60)}{/red-fg}`); }
      updateInfo(); refreshBalances(); rebuildMenu(); screen.render();
      return;
    }

    // ── Token Address ──
    if (idx === 1) {
      overlay.destroy();
      const addr = await promptInput('Token contract address (0x...):', { width: 60 });
      menuBox.focus();
      if (addr === null || addr === '') { screen.render(); return; }
      if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
        addLog('{red-fg}\u2717 Invalid address \u2014 must be 0x followed by 40 hex characters{/red-fg}');
        screen.render(); return;
      }
      addLog('{gray-fg}\u23F3 Fetching token info...{/gray-fg}');
      try {
        const info = await trader.getTokenInfo(addr);
        addLog(`{green-fg}\u2713{/green-fg} Token: {cyan-fg}${info.symbol}{/cyan-fg} (${info.decimals} decimals)`);
        updateUser(USER_ID, { token_address: addr, token_symbol: info.symbol, token_decimals: info.decimals });

        addLog('{gray-fg}\u23F3 Discovering V4 pool... (may take a moment){/gray-fg}');
        const poolKey = await trader.discoverPoolKey(addr);
        if (poolKey) {
          updateUser(USER_ID, { fee_tier: poolKey.fee, tick_spacing: poolKey.tickSpacing, hook_address: poolKey.hooks });
          const hookInfo = poolKey.hooks !== ethers.ZeroAddress ? `  Hook: ${poolKey.hooks.slice(0,12)}...` : '';
          addLog(`{green-fg}\u2713 Pool found!{/green-fg}  Fee: ${poolKey.fee}  Spacing: ${poolKey.tickSpacing}${hookInfo}`);
        } else {
          addLog('{yellow-fg}\u26A0 No V4 pool found \u2014 use Set Pool Key (Manual){/yellow-fg}');
        }
      } catch (e) {
        addLog(`{red-fg}\u2717 Error: ${(e.shortMessage || e.message || '').slice(0,60)}{/red-fg}`);
      }
      updateInfo(); refreshBalances(); rebuildMenu(); screen.render();
      return;
    }

    // ── Pool Key (Manual) ──
    if (idx === 2) {
      overlay.destroy();
      const val = await promptInput('fee tickSpacing [hooks]  e.g. 3000 60:', { width: 62 });
      menuBox.focus();
      if (val === null || val === '') { screen.render(); return; }
      const parts       = val.split(/\s+/);
      const fee         = parseInt(parts[0]);
      const tickSpacing = parseInt(parts[1]);
      const hooks       = parts[2] || '0x0000000000000000000000000000000000000000';
      if (isNaN(fee) || isNaN(tickSpacing)) {
        addLog('{red-fg}\u2717 Invalid format \u2014 use: fee tickSpacing [hooks]{/red-fg}');
        screen.render(); return;
      }
      if (hooks !== '0x0000000000000000000000000000000000000000' && !/^0x[0-9a-fA-F]{40}$/.test(hooks)) {
        addLog('{red-fg}\u2717 Invalid hooks address{/red-fg}');
        screen.render(); return;
      }
      updateUser(USER_ID, { fee_tier: fee, tick_spacing: tickSpacing, hook_address: hooks });
      const hookInfo = hooks !== '0x0000000000000000000000000000000000000000' ? ` Hooks=${hooks.slice(0,12)}...` : '';
      addLog(`{green-fg}\u2713{/green-fg} Pool key set: Fee=${fee} Spacing=${tickSpacing}${hookInfo}`);
      updateInfo(); rebuildMenu(); screen.render();
      return;
    }

    // ── Trade Amounts (combined min + max) ──
    if (idx === 3) {
      overlay.destroy();
      const val = await promptInput('Min and Max USD (e.g. 0.10 0.50):');
      menuBox.focus();
      if (val === null || val === '') { screen.render(); return; }
      const parts = val.split(/[\s,]+/);
      const minA  = parseFloat(parts[0]);
      const maxA  = parseFloat(parts[1] || parts[0]);
      if (isNaN(minA) || isNaN(maxA) || minA <= 0 || maxA < minA) {
        addLog('{red-fg}\u2717 Invalid range \u2014 enter two positive numbers (min max){/red-fg}');
        screen.render(); return;
      }
      updateUser(USER_ID, { min_amount_usd: minA, max_amount_usd: maxA });
      addLog(`{green-fg}\u2713{/green-fg} Amount range: $${minA.toFixed(2)} \u2013 $${maxA.toFixed(2)}`);
      updateInfo(); screen.render();
      return;
    }

    // ── Trade Intervals (combined min + max) ──
    if (idx === 4) {
      overlay.destroy();
      const val = await promptInput('Min and Max seconds (e.g. 20 60):');
      menuBox.focus();
      if (val === null || val === '') { screen.render(); return; }
      const parts = val.split(/[\s,]+/);
      const minI  = parseInt(parts[0]);
      const maxI  = parseInt(parts[1] || parts[0]);
      if (isNaN(minI) || isNaN(maxI) || minI < 5 || maxI < minI) {
        addLog('{red-fg}\u2717 Invalid range \u2014 minimum 5 seconds, max must be \u2265 min{/red-fg}');
        screen.render(); return;
      }
      updateUser(USER_ID, { min_interval_sec: minI, max_interval_sec: maxI });
      addLog(`{green-fg}\u2713{/green-fg} Interval range: ${minI}s \u2013 ${maxI}s`);
      updateInfo(); screen.render();
      return;
    }

    // ── View Wallet Address ──
    if (idx === 5) {
      overlay.destroy();
      const u = getUser(USER_ID) || {};
      if (u.wallet_address) {
        addLog(`{cyan-fg}Wallet: ${u.wallet_address}{/cyan-fg}`);
        addLog('{gray-fg}Fund this address with ETH on Base to start trading{/gray-fg}');
      } else {
        addLog('{red-fg}No wallet imported yet{/red-fg}');
      }
      menuBox.focus(); screen.render();
      return;
    }

    // ── Reset PnL & History ──
    if (idx === 6) {
      overlay.destroy();
      const val = await promptInput('Type RESET to confirm:');
      menuBox.focus();
      if (val !== null && val.toUpperCase() === 'RESET') {
        updateUser(USER_ID, { trade_count: 0, trade_history: [] });
        addLog('{green-fg}\u2713 PnL and trade history cleared{/green-fg}');
        updateInfo(); rebuildMenu();
      } else {
        addLog('{gray-fg}Reset cancelled.{/gray-fg}');
      }
      screen.render();
      return;
    }
  });

  settingsList.key(['escape'], () => { overlay.destroy(); menuBox.focus(); screen.render(); });
}

// ─── MENU HANDLER ───────────────────────────────────────────────────────
menuBox.on('select', (item, idx) => {
  if (menuActions[idx]) menuActions[idx]();
});

// ─── GLOBAL KEYS ────────────────────────────────────────────────────────
screen.key(['r', 'R'], () => { addLog('{gray-fg}\u{1F504} Refreshing...{/gray-fg}'); refreshBalances(); });
screen.key(['q', 'Q'], () => { stopBot(); screen.destroy(); process.exit(0); });
screen.key('C-c',      () => { stopBot(); screen.destroy(); process.exit(0); });

screen.key(['space'], () => {
  const user = getUser(USER_ID);
  if (!user?.wallet_encrypted || !poolKeyFromUser(user)) return;
  if (running) stopBot(); else startBot();
});

screen.key(['b', 'B'], () => {
  const user = getUser(USER_ID);
  if (user?.wallet_encrypted) openBuyMenu();
});
screen.key(['s', 'S'], () => {
  const user = getUser(USER_ID);
  if (user?.wallet_encrypted) openSellMenu();
});

// ─── CLOCK + AUTO-REFRESH ───────────────────────────────────────────────
setInterval(updateTopBar, 1000);
setInterval(() => { if (!pendingMsg) refreshBalances(); }, 30000);

// ─── INIT ───────────────────────────────────────────────────────────────
const user0 = getUser(USER_ID);
rebuildMenu();

if (user0?.wallet_address) {
  addLog(`{cyan-fg}\u{1F511} Wallet loaded: ${user0.wallet_address.slice(0,10)}...${user0.wallet_address.slice(-6)}{/cyan-fg}`);
} else {
  addLog('{yellow-fg}\u26A0 No wallet \u2014 select QUICK SETUP to get started{/yellow-fg}');
}

if (!user0?.wallet_address || !user0?.token_address) {
  addLog('{cyan-fg}Tip: Use QUICK SETUP to configure wallet, token, and trading params in one go.{/cyan-fg}');
} else if (poolKeyFromUser(user0)) {
  addLog('{gray-fg}Ready to trade. Press Space or select START BOT to begin.{/gray-fg}');
} else {
  addLog('{yellow-fg}Pool not configured \u2014 go to SETTINGS \u2192 Set Token Address{/yellow-fg}');
}

addLog('{gray-fg}Navigate with \u2191/\u2193, Enter to select. Press B/S for quick buy/sell.{/gray-fg}');
updateTopBar();
updateInfo();
refreshBalances();
screen.render();
