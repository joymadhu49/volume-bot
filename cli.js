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

const USER_ID = 7332734457;
const WETH    = '0x4200000000000000000000000000000000000006';

// ─── Pool Key Builder (mirrors index.js poolKeyFromUser) ─────────────────────
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

// ─── Color Palette ──────────────────────────────────────────────────────────
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

// ─── State ───────────────────────────────────────────────────────────────────
let running             = false;
let tradeTimer          = null;
let nextTradeIn         = 0;
let totalCountdownSecs  = 0;
let countdownTimer      = null;
let pendingMsg          = '';

// ─── Auto-create + auto-import ───────────────────────────────────────────────
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

// ─── Screen ──────────────────────────────────────────────────────────────────
const screen = blessed.screen({
  smartCSR: true, title: 'Volume Bot',
  fullUnicode: true, forceUnicode: true,
  ignoreLocked: ['C-c'],
});

// ─── TOP BAR ─────────────────────────────────────────────────────────────────
const topBar = blessed.box({
  top: 0, left: 0, width: '100%', height: 5,
  tags: true,
  border: { type: 'line' },
  style: { bg: C.bg, border: { fg: C.border } },
  padding: { left: 1 },
});

// ─── LEFT: Menu ──────────────────────────────────────────────────────────────
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
  items: [
    ' \u25B6  START BOT',
    ' \u25A0  STOP BOT',
    ' \u2B06  BUY TOKEN',
    ' \u2B07  SELL TOKEN',
    ' \u2699  SETTINGS',
    ' \u2716  QUIT',
  ],
});

// ─── RIGHT TOP: Balances ──────────────────────────────────────────────────────
const balBox = blessed.box({
  top: 5, right: 0, width: '75%', height: '25%',
  label: ' {bold}{yellow-fg} BALANCES {/yellow-fg}{/bold} ',
  tags: true,
  border: { type: 'line' },
  style: { bg: C.bg, border: { fg: C.border } },
  padding: { left: 2, top: 1 },
  content: '{gray-fg}Loading...{/gray-fg}',
});

// ─── RIGHT BOTTOM: Config Info ────────────────────────────────────────────────
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

// ─── TRADE LOG ───────────────────────────────────────────────────────────────
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

// ─── BOTTOM BAR ──────────────────────────────────────────────────────────────
const botBar = blessed.box({
  bottom: 0, left: 0, width: '100%', height: 3,
  tags: true,
  border: { type: 'line' },
  style: { bg: C.bgAlt, fg: C.dim, border: { fg: C.border } },
  content: '{center}{gray-fg} \u2191/\u2193 Navigate    Enter Select    R Refresh    Q Quit {/gray-fg}{/center}',
});

screen.append(topBar);
screen.append(menuBox);
screen.append(balBox);
screen.append(infoBox);
screen.append(logBox);
screen.append(botBar);
menuBox.focus();

// ─── PROGRESS BAR ───────────────────────────────────────────────────────────
function makeProgressBar(current, total, width) {
  width = width || 15;
  if (total <= 0) return '';
  const filled = Math.round((1 - current / total) * width);
  const empty = width - filled;
  return '{green-fg}' + '\u2588'.repeat(filled) + '{/green-fg}' +
         '{gray-fg}' + '\u2591'.repeat(empty) + '{/gray-fg}';
}

// ─── TOP BAR UPDATE ──────────────────────────────────────────────────────────
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

  const logo = `{bold}{#58a6ff-fg}\u25C8 VOLUME BOT{/#58a6ff-fg}{/bold}  {gray-fg}\u2502{/gray-fg}  {white-fg}Uniswap V4 on Base{/white-fg}`;
  const statusLine = `  ${status}   ${next}   ${trades}${pend}   {gray-fg}${now}{/gray-fg}`;

  topBar.setContent(`${logo}\n\n${statusLine}`);
  screen.render();
}

// ─── PnL CALCULATION ─────────────────────────────────────────────────────────
function calculatePnL() {
  const user = getUser(USER_ID) || {};
  const history = user.trade_history || [];
  let totalBuyUsd = 0, totalSellUsd = 0, totalGasEth = 0;
  for (const t of history) {
    if (t.type === 'buy') totalBuyUsd += t.amountUsd || 0;
    else totalSellUsd += t.amountUsd || 0;
    totalGasEth += parseFloat(t.gasUsed || '0');
  }
  return { totalBuyUsd, totalSellUsd, totalGasEth, net: totalSellUsd - totalBuyUsd };
}

// ─── INFO BOX UPDATE ─────────────────────────────────────────────────────────
function updateInfo() {
  const user = getUser(USER_ID) || {};
  const wallet = user.wallet_address
    ? `{cyan-fg}${user.wallet_address.slice(0,10)}...${user.wallet_address.slice(-6)}{/cyan-fg}`
    : '{red-fg}NOT SET \u2014 go to SETTINGS{/red-fg}';
  const pnl = calculatePnL();
  const pnlColor = pnl.net >= 0 ? 'green-fg' : 'red-fg';
  infoBox.setContent(
    ` Wallet   : ${wallet}\n` +
    ` Token    : {cyan-fg}${user.token_symbol || 'TOKEN'}{/cyan-fg}  {gray-fg}${(user.token_address||'').slice(0,12)}...{/gray-fg}\n` +
    ` Amount   : {yellow-fg}$${user.min_amount_usd||0.10} \u2013 $${user.max_amount_usd||0.50}{/yellow-fg}\n` +
    ` Interval : {yellow-fg}${user.min_interval_sec||20}s \u2013 ${user.max_interval_sec||60}s{/yellow-fg}\n` +
    ` PnL      : {${pnlColor}}$${pnl.net.toFixed(2)}{/${pnlColor}}  {gray-fg}(Buy: $${pnl.totalBuyUsd.toFixed(2)} | Sell: $${pnl.totalSellUsd.toFixed(2)} | Gas: ${pnl.totalGasEth.toFixed(4)} ETH){/gray-fg}`
  );
  screen.render();
}

// ─── BALANCES ────────────────────────────────────────────────────────────────
async function refreshBalances() {
  const user = getUser(USER_ID) || {};
  if (!user.wallet_address) {
    balBox.setContent('{red-fg}  No wallet \u2014 go to SETTINGS to import{/red-fg}');
    screen.render();
    return;
  }
  balBox.setContent('{gray-fg}  Fetching...{/gray-fg}');
  screen.render();
  try {
    const bal = await trader.getBalances(user.wallet_address, user.token_address);
    const sym = bal.tokenSymbol || user.token_symbol || 'TOKEN';
    const ethUsd   = bal.ethUsd   ? `{gray-fg}  ~$${bal.ethUsd}{/gray-fg}` : '';
    const wethUsd  = bal.wethUsd  ? `{gray-fg}  ~$${bal.wethUsd}{/gray-fg}` : '';
    const tokUsd   = bal.tokenUsd ? `{gray-fg}  ~$${bal.tokenUsd}{/gray-fg}` : '';
    let content =
      ` {white-fg}ETH   {/white-fg}  {green-fg}{bold}${bal.eth}{/bold}{/green-fg}${ethUsd}\n`;
    if (bal.weth)
      content += ` {white-fg}WETH  {/white-fg}  {yellow-fg}${bal.weth}{/yellow-fg}${wethUsd}\n`;
    content +=
      ` {white-fg}${sym.padEnd(6)}{/white-fg}  {cyan-fg}{bold}${bal.token}{/bold}{/cyan-fg}${tokUsd}`;
    balBox.setContent(content);
  } catch (e) {
    balBox.setContent(`{red-fg}  Error: ${e.message.slice(0,60)}{/red-fg}`);
  }
  screen.render();
}

// ─── LOG ─────────────────────────────────────────────────────────────────────
function addLog(msg) {
  const t = new Date().toLocaleTimeString('en-US', { hour12: false });
  logBox.log(`{gray-fg}${t}{/gray-fg}  ${msg}`);
  screen.render();
}

// ─── GAS DISPLAY HELPER ─────────────────────────────────────────────────────
function formatGas(receipt) {
  try {
    const gasUsed = receipt.gasUsed || 0n;
    const gasPrice = receipt.gasPrice || receipt.effectiveGasPrice || 0n;
    return parseFloat(ethers.formatEther(gasUsed * gasPrice)).toFixed(6);
  } catch { return '?'; }
}

// ─── TRADE HISTORY HELPER ───────────────────────────────────────────────────
function recordTrade(type, amountUsd, amountEth, receipt) {
  const user = getUser(USER_ID) || {};
  const history = (user.trade_history || []).slice(-99); // keep max 100
  history.push({
    type,
    amountUsd: amountUsd || 0,
    amountEth: amountEth || 0,
    txHash: receipt.hash,
    gasUsed: formatGas(receipt),
    timestamp: Date.now(),
  });
  updateUser(USER_ID, { trade_count: (user.trade_count || 0) + 1, trade_history: history });
}

// ─── COUNTDOWN ───────────────────────────────────────────────────────────────
function startCountdown(seconds) {
  nextTradeIn = seconds;
  totalCountdownSecs = seconds;
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    nextTradeIn = Math.max(0, nextTradeIn - 1);
    updateTopBar();
    if (nextTradeIn === 0) clearInterval(countdownTimer);
  }, 1000);
}

// ─── TRADING ─────────────────────────────────────────────────────────────────
async function runTrade() {
  if (!running) return;
  const user    = getUser(USER_ID);
  const poolKey = poolKeyFromUser(user);
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
      const r = await trader.buyToken(pk, user.token_address, ethAmt, null, poolKey);
      const gas = formatGas(r);
      recordTrade('buy', usdAmt, ethAmt, r);
      addLog(`{green-fg}\u2713 BUY OK{/green-fg}  #${user.trade_count + 1}  {gray-fg}Gas: ${gas} ETH  TX: ${r.hash.slice(0,18)}...{/gray-fg}`);
    } else {
      const pct = Math.floor(randomBetween(5, 15));
      pendingMsg = 'Selling...'; updateTopBar();
      addLog(`{magenta-fg}\u25BC SELL{/magenta-fg}  ${pct}% of ${user.token_symbol || 'TOKEN'}`);
      const r = await trader.sellToken(pk, user.token_address, pct, null, 18, poolKey);
      const gas = formatGas(r);
      recordTrade('sell', 0, 0, r);
      addLog(`{green-fg}\u2713 SELL OK{/green-fg} #${user.trade_count + 1}  {gray-fg}Gas: ${gas} ETH  TX: ${r.hash.slice(0,18)}...{/gray-fg}`);
    }
  } catch (e) {
    const msg = (e.shortMessage || e.reason || e.message || '').slice(0, 60);
    addLog(`{red-fg}\u2717 ERR{/red-fg}   ${msg}`);
  }

  pendingMsg = ''; updateTopBar();
  updateInfo();
  await refreshBalances();

  if (running) {
    const delay = Math.floor(randomBetween(user.min_interval_sec, user.max_interval_sec));
    addLog(`{gray-fg}\u23F1 WAIT  ${delay}s...{/gray-fg}`);
    startCountdown(delay);
    tradeTimer = setTimeout(runTrade, delay * 1000);
  }
}

function startBot() {
  const user = getUser(USER_ID);
  if (!user?.wallet_encrypted) { addLog('{red-fg}\u2717 No wallet \u2014 go to SETTINGS{/red-fg}'); return; }
  if (!poolKeyFromUser(user)) { addLog('{red-fg}\u2717 Pool key not set \u2014 go to SETTINGS \u2192 Set Token Address{/red-fg}'); return; }
  if (running) { addLog('{gray-fg}Already running{/gray-fg}'); return; }
  running = true;
  addLog('{green-fg}{bold}\u2500\u2500\u2500 BOT STARTED \u2500\u2500\u2500{/bold}{/green-fg}');
  updateTopBar(); updateInfo();
  runTrade();
}

function stopBot() {
  if (!running) { addLog('{gray-fg}Already stopped{/gray-fg}'); return; }
  running = false;
  pendingMsg = '';
  if (tradeTimer) { clearTimeout(tradeTimer); tradeTimer = null; }
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  nextTradeIn = 0;
  addLog('{red-fg}{bold}\u2500\u2500\u2500 BOT STOPPED \u2500\u2500\u2500{/bold}{/red-fg}');
  updateTopBar(); updateInfo();
}

async function doBuy(usdAmt) {
  const user = getUser(USER_ID);
  if (!user?.wallet_encrypted) { addLog('{red-fg}\u2717 No wallet \u2014 go to SETTINGS{/red-fg}'); return; }
  const poolKey = poolKeyFromUser(user);
  if (!poolKey) { addLog('{red-fg}\u2717 Pool key not set \u2014 go to SETTINGS \u2192 Set Token Address{/red-fg}'); return; }
  const ethPrice = await getEthPrice().catch(() => 2000);
  const ethAmt   = usdAmt / ethPrice;
  pendingMsg = 'Buying...'; updateTopBar();
  addLog(`{yellow-fg}\u25B2 BUY{/yellow-fg}   $${usdAmt.toFixed(2)} (manual)`);
  try {
    const r = await trader.buyToken(decrypt(user.wallet_encrypted), user.token_address, ethAmt, null, poolKey);
    const gas = formatGas(r);
    recordTrade('buy', usdAmt, ethAmt, r);
    addLog(`{green-fg}\u2713 BUY OK{/green-fg}  {gray-fg}Gas: ${gas} ETH  TX: ${r.hash.slice(0,18)}...{/gray-fg}`);
    await refreshBalances();
  } catch (e) { addLog(`{red-fg}\u2717 ERR{/red-fg}   ${(e.shortMessage || e.reason || e.message || '').slice(0, 60)}`); }
  pendingMsg = ''; updateTopBar(); updateInfo();
}

async function doSell(pct) {
  const wasRunning = running;
  if (running) stopBot();
  const user = getUser(USER_ID);
  if (!user?.wallet_encrypted) { addLog('{red-fg}\u2717 No wallet \u2014 go to SETTINGS{/red-fg}'); return; }
  const poolKey = poolKeyFromUser(user);
  if (!poolKey) { addLog('{red-fg}\u2717 Pool key not set \u2014 go to SETTINGS \u2192 Set Token Address{/red-fg}'); if (wasRunning) startBot(); return; }
  pendingMsg = 'Selling...'; updateTopBar();
  addLog(`{magenta-fg}\u25BC SELL{/magenta-fg}  ${pct}% (manual)`);
  try {
    const r = await trader.sellToken(decrypt(user.wallet_encrypted), user.token_address, pct, null, 18, poolKey);
    const gas = formatGas(r);
    recordTrade('sell', 0, 0, r);
    addLog(`{green-fg}\u2713 SELL OK{/green-fg} {gray-fg}Gas: ${gas} ETH  TX: ${r.hash.slice(0,18)}...{/gray-fg}`);
    await refreshBalances();
  } catch (e) { addLog(`{red-fg}\u2717 ERR{/red-fg}   ${(e.shortMessage || e.reason || e.message || '').slice(0, 60)}`); }
  pendingMsg = ''; updateTopBar(); updateInfo();
  if (wasRunning) startBot();
}

// ─── BUY MENU ───────────────────────────────────────────────────────────────
function openBuyMenu() {
  const user = getUser(USER_ID) || {};
  const minA = user.min_amount_usd || 0.10;
  const maxA = user.max_amount_usd || 0.50;

  const overlay = blessed.box({
    top: 'center', left: 'center', width: 42, height: 14,
    tags: true, border: { type: 'line' },
    label: ' {bold}{yellow-fg} \u25B2 BUY TOKEN {/yellow-fg}{/bold} ',
    style: { bg: C.bgAlt, border: { fg: C.focus } },
  });

  const buyList = blessed.list({
    parent: overlay,
    top: 1, left: 1, right: 1, bottom: 3,
    tags: true,
    style: {
      bg: C.bgAlt, fg: C.text,
      selected: { bg: C.accent, fg: 'white', bold: true },
    },
    keys: true, mouse: true,
    items: [
      `  \u{1F3B2}  Random ($${minA.toFixed(2)} \u2013 $${maxA.toFixed(2)})`,
      '  \u270E  Custom Amount (USD)',
      '  \u25CF  $1.00',
      '  \u25CF  $5.00',
      '  \u25CF  $10.00',
      '  \u2190  Back',
    ],
  });

  const hint = blessed.text({
    parent: overlay,
    bottom: 1, left: 2, right: 2,
    tags: true, height: 1,
    content: '{gray-fg}Enter: select   Esc: back{/gray-fg}',
    style: { bg: C.bgAlt },
  });

  screen.append(overlay);
  buyList.focus();
  screen.render();

  buyList.on('select', (item, idx) => {
    if (idx === 5) { overlay.destroy(); menuBox.focus(); screen.render(); return; }
    if (idx === 0) {
      overlay.destroy(); menuBox.focus(); screen.render();
      doBuy(randomBetween(minA, maxA));
      return;
    }
    if (idx >= 2 && idx <= 4) {
      const amounts = [1, 5, 10];
      overlay.destroy(); menuBox.focus(); screen.render();
      doBuy(amounts[idx - 2]);
      return;
    }
    // idx === 1: custom amount
    const inputBox = blessed.textbox({
      top: 'center', left: 'center', width: 44, height: 5,
      label: '  Amount in USD (e.g. 2.50):  ',
      tags: true, border: { type: 'line' },
      style: { bg: C.bg, border: { fg: C.focus }, fg: 'white' },
      inputOnFocus: true,
    });
    screen.append(inputBox);
    inputBox.focus();
    screen.render();
    inputBox.on('submit', (val) => {
      inputBox.destroy();
      const amt = parseFloat(val.trim());
      if (isNaN(amt) || amt <= 0) { addLog('{red-fg}\u2717 Invalid amount{/red-fg}'); overlay.destroy(); menuBox.focus(); screen.render(); return; }
      overlay.destroy(); menuBox.focus(); screen.render();
      doBuy(amt);
    });
    inputBox.key(['escape'], () => { inputBox.destroy(); buyList.focus(); screen.render(); });
  });

  buyList.key(['escape', 'q'], () => { overlay.destroy(); menuBox.focus(); screen.render(); });
}

// ─── SELL MENU ──────────────────────────────────────────────────────────────
function openSellMenu() {
  const overlay = blessed.box({
    top: 'center', left: 'center', width: 42, height: 14,
    tags: true, border: { type: 'line' },
    label: ' {bold}{magenta-fg} \u25BC SELL TOKEN {/magenta-fg}{/bold} ',
    style: { bg: C.bgAlt, border: { fg: C.focus } },
  });

  const sellList = blessed.list({
    parent: overlay,
    top: 1, left: 1, right: 1, bottom: 3,
    tags: true,
    style: {
      bg: C.bgAlt, fg: C.text,
      selected: { bg: C.accent, fg: 'white', bold: true },
    },
    keys: true, mouse: true,
    items: [
      '  \u25CF  Sell 25%',
      '  \u25CF  Sell 50%',
      '  \u25CF  Sell 75%',
      '  \u25CF  Sell 100%',
      '  \u270E  Custom %',
      '  \u2190  Back',
    ],
  });

  const hint = blessed.text({
    parent: overlay,
    bottom: 1, left: 2, right: 2,
    tags: true, height: 1,
    content: '{gray-fg}Enter: select   Esc: back{/gray-fg}',
    style: { bg: C.bgAlt },
  });

  screen.append(overlay);
  sellList.focus();
  screen.render();

  sellList.on('select', (item, idx) => {
    if (idx === 5) { overlay.destroy(); menuBox.focus(); screen.render(); return; }
    if (idx >= 0 && idx <= 3) {
      const pcts = [25, 50, 75, 100];
      overlay.destroy(); menuBox.focus(); screen.render();
      doSell(pcts[idx]);
      return;
    }
    // idx === 4: custom %
    const inputBox = blessed.textbox({
      top: 'center', left: 'center', width: 44, height: 5,
      label: '  Sell percentage (1-100):  ',
      tags: true, border: { type: 'line' },
      style: { bg: C.bg, border: { fg: C.focus }, fg: 'white' },
      inputOnFocus: true,
    });
    screen.append(inputBox);
    inputBox.focus();
    screen.render();
    inputBox.on('submit', (val) => {
      inputBox.destroy();
      const pct = parseInt(val.trim());
      if (isNaN(pct) || pct < 1 || pct > 100) { addLog('{red-fg}\u2717 Invalid percentage (1-100){/red-fg}'); overlay.destroy(); menuBox.focus(); screen.render(); return; }
      overlay.destroy(); menuBox.focus(); screen.render();
      doSell(pct);
    });
    inputBox.key(['escape'], () => { inputBox.destroy(); sellList.focus(); screen.render(); });
  });

  sellList.key(['escape', 'q'], () => { overlay.destroy(); menuBox.focus(); screen.render(); });
}

// ─── SETTINGS ────────────────────────────────────────────────────────────────
function openSettings() {
  const overlay = blessed.box({
    top: 'center', left: 'center', width: 54, height: 16,
    tags: true, border: { type: 'line' },
    label: ' {bold}{magenta-fg} \u2699 SETTINGS {/magenta-fg}{/bold} ',
    style: { bg: C.bgAlt, border: { fg: C.focus } },
  });

  const settingsList = blessed.list({
    parent: overlay,
    top: 1, left: 1, right: 1, bottom: 3,
    tags: true,
    style: {
      bg: C.bgAlt, fg: C.text,
      selected: { bg: '#1f6feb', fg: 'white', bold: true },
    },
    keys: true, mouse: true,
    items: [
      '  \u{1F511}  Import Wallet (Private Key)',
      '  \u{1F4B0}  Set Token Address',
      '  \u{1F527}  Set Pool Key (Manual)',
      '  \u25CF  Set Min Trade Amount (USD)',
      '  \u25CF  Set Max Trade Amount (USD)',
      '  \u25CF  Set Min Interval (seconds)',
      '  \u25CF  Set Max Interval (seconds)',
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

  settingsList.on('select', (item, idx) => {
    // Back
    if (idx === 7) { overlay.destroy(); menuBox.focus(); screen.render(); return; }

    // Token Address
    if (idx === 1) {
      const inputBox = blessed.textbox({
        top: 'center', left: 'center', width: 56, height: 5,
        label: '  Token contract address (0x...):  ',
        tags: true, border: { type: 'line' },
        style: { bg: C.bg, border: { fg: C.focus }, fg: 'white' },
        inputOnFocus: true,
      });
      screen.append(inputBox);
      inputBox.focus();
      screen.render();

      inputBox.on('submit', async (val) => {
        inputBox.destroy();
        screen.render();
        const addr = val.trim();
        if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
          addLog('{red-fg}\u2717 Invalid address format{/red-fg}');
          settingsList.focus(); screen.render();
          return;
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
            addLog(`{green-fg}\u2713 Pool found!{/green-fg}  Fee: ${poolKey.fee}  Spacing: ${poolKey.tickSpacing}`);
          } else {
            addLog('{yellow-fg}\u26A0 No V4 pool found \u2014 use SETTINGS \u2192 Set Pool Key (Manual){/yellow-fg}');
          }
        } catch (e) {
          addLog(`{red-fg}\u2717 Error: ${(e.shortMessage || e.message || '').slice(0,60)}{/red-fg}`);
        }
        updateInfo(); refreshBalances();
        overlay.destroy(); menuBox.focus(); screen.render();
      });

      inputBox.key(['escape'], () => { inputBox.destroy(); settingsList.focus(); screen.render(); });
      return;
    }

    // Pool Key (Manual)
    if (idx === 2) {
      const inputBox = blessed.textbox({
        top: 'center', left: 'center', width: 58, height: 5,
        label: '  fee tickSpacing [hooks] (e.g. 3000 60):  ',
        tags: true, border: { type: 'line' },
        style: { bg: C.bg, border: { fg: C.focus }, fg: 'white' },
        inputOnFocus: true,
      });
      screen.append(inputBox);
      inputBox.focus();
      screen.render();

      inputBox.on('submit', (val) => {
        inputBox.destroy();
        const parts = val.trim().split(/\s+/);
        const fee = parseInt(parts[0]);
        const tickSpacing = parseInt(parts[1]);
        const hooks = parts[2] || '0x0000000000000000000000000000000000000000';
        if (isNaN(fee) || isNaN(tickSpacing)) {
          addLog('{red-fg}\u2717 Invalid format. Use: fee tickSpacing [hooks]{/red-fg}');
          settingsList.focus(); screen.render();
          return;
        }
        if (hooks !== '0x0000000000000000000000000000000000000000' && !/^0x[0-9a-fA-F]{40}$/.test(hooks)) {
          addLog('{red-fg}\u2717 Invalid hooks address{/red-fg}');
          settingsList.focus(); screen.render();
          return;
        }
        updateUser(USER_ID, { fee_tier: fee, tick_spacing: tickSpacing, hook_address: hooks });
        addLog(`{green-fg}\u2713{/green-fg} Pool key set: Fee=${fee} Spacing=${tickSpacing} Hooks=${hooks.slice(0,10)}...`);
        updateInfo();
        overlay.destroy(); menuBox.focus(); screen.render();
      });

      inputBox.key(['escape'], () => { inputBox.destroy(); settingsList.focus(); screen.render(); });
      return;
    }

    // Wallet import and numeric settings
    const labels = [
      'Private Key (hidden):',
      '', // token handled above
      '', // pool key handled above
      'Min Amount USD (e.g. 0.10):',
      'Max Amount USD (e.g. 0.50):',
      'Min Interval sec (e.g. 10):',
      'Max Interval sec (e.g. 30):',
    ];

    const inputBox = blessed.textbox({
      top: 'center', left: 'center', width: 54, height: 5,
      label: `  ${labels[idx]}  `,
      tags: true, border: { type: 'line' },
      style: { bg: C.bg, border: { fg: C.focus }, fg: 'white' },
      inputOnFocus: true,
      censor: idx === 0,
    });

    screen.append(inputBox);
    inputBox.focus();
    screen.render();

    inputBox.on('submit', (val) => {
      inputBox.destroy();
      const v = val.trim();
      try {
        if (idx === 0) {
          const w = new ethers.Wallet(v);
          updateUser(USER_ID, { wallet_encrypted: encrypt(v), wallet_address: w.address });
          const envPath = path.join(__dirname, '.env');
          let envRaw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
          envRaw = envRaw.match(/^PRIVATE_KEY=/m)
            ? envRaw.replace(/^PRIVATE_KEY=.*/m, `PRIVATE_KEY=${v}`)
            : envRaw + `\nPRIVATE_KEY=${v}`;
          fs.writeFileSync(envPath, envRaw);
          addLog(`{green-fg}\u2713{/green-fg} Wallet: {cyan-fg}${w.address}{/cyan-fg}`);
        } else if (idx === 3) { updateUser(USER_ID, { min_amount_usd: parseFloat(v) }); addLog(`{green-fg}\u2713{/green-fg} Min amount: $${v}`); }
        else if (idx === 4) { updateUser(USER_ID, { max_amount_usd: parseFloat(v) }); addLog(`{green-fg}\u2713{/green-fg} Max amount: $${v}`); }
        else if (idx === 5) { updateUser(USER_ID, { min_interval_sec: parseInt(v) }); addLog(`{green-fg}\u2713{/green-fg} Min interval: ${v}s`); }
        else if (idx === 6) { updateUser(USER_ID, { max_interval_sec: parseInt(v) }); addLog(`{green-fg}\u2713{/green-fg} Max interval: ${v}s`); }
      } catch (e) { addLog(`{red-fg}\u2717 ${(e.shortMessage || e.message || '').slice(0,60)}{/red-fg}`); }
      updateInfo(); refreshBalances();
      overlay.destroy(); menuBox.focus(); screen.render();
    });

    inputBox.key(['escape'], () => { inputBox.destroy(); settingsList.focus(); screen.render(); });
  });

  settingsList.key(['escape', 'q'], () => { overlay.destroy(); menuBox.focus(); screen.render(); });
}


menuBox.on('select', (item, idx) => {
  const actions = [
    () => startBot(),
    () => stopBot(),
    () => openBuyMenu(),
    () => openSellMenu(),
    () => openSettings(),
    () => { stopBot(); screen.destroy(); process.exit(0); },
  ];
  if (actions[idx]) actions[idx]();
});

// ─── GLOBAL KEYS ──────────────────────────────────────────────────────────────
screen.key(['r', 'R'], () => { addLog('{gray-fg}\u{1F504} Refreshing...{/gray-fg}'); refreshBalances(); });
screen.key(['q', 'Q'], () => { stopBot(); screen.destroy(); process.exit(0); });
screen.key('C-c',      () => { stopBot(); screen.destroy(); process.exit(0); });

// ─── CLOCK + AUTO-REFRESH ───────────────────────────────────────────────────
setInterval(updateTopBar, 1000);
setInterval(() => { if (!pendingMsg) refreshBalances(); }, 30000);

// ─── INIT ─────────────────────────────────────────────────────────────────────
const user0 = getUser(USER_ID);
addLog(user0?.wallet_address
  ? `{cyan-fg}\u{1F511} Wallet loaded: ${user0.wallet_address.slice(0,10)}...${user0.wallet_address.slice(-6)}{/cyan-fg}`
  : '{yellow-fg}\u26A0 No wallet \u2014 go to SETTINGS to import your private key{/yellow-fg}');
addLog('{gray-fg}Navigate with \u2191/\u2193, press Enter to select.{/gray-fg}');
updateTopBar();
updateInfo();
refreshBalances();
screen.render();


