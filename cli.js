#!/usr/bin/env node
'use strict';
require('dotenv').config();

const blessed = require('blessed');
const { ethers } = require('ethers');
const { getUser, updateUser, createUser, getWallets } = require('./db');
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

// ─── Auto-create + auto-import + migrate ────────────────────────────────────
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
// Migrate legacy single wallet into wallets[]
(function migrateWallets() {
  const u = getUser(USER_ID);
  if (u.wallet_encrypted && (!u.wallets || u.wallets.length === 0)) {
    updateUser(USER_ID, { wallets: [{ encrypted: u.wallet_encrypted, address: u.wallet_address }] });
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
  const wallets = getWallets(USER_ID);
  const walletInfo = wallets.length > 0
    ? `{cyan-fg}${wallets.length} wallet${wallets.length > 1 ? 's' : ''} loaded{/cyan-fg}`
    : '{red-fg}NO WALLETS \u2014 go to SETTINGS{/red-fg}';
  const pnl = calculatePnL();
  const pnlColor = pnl.net >= 0 ? 'green-fg' : 'red-fg';
  infoBox.setContent(
    ` Wallets  : ${walletInfo}\n` +
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
  const wallets = getWallets(USER_ID);
  if (wallets.length === 0) {
    balBox.setContent('{red-fg}  No wallets \u2014 go to SETTINGS to import{/red-fg}');
    screen.render();
    return;
  }
  balBox.setContent(`{gray-fg}  Fetching balances for ${wallets.length} wallet${wallets.length > 1 ? 's' : ''}...{/gray-fg}`);
  screen.render();
  try {
    const results = await Promise.all(
      wallets.map(w => trader.getBalances(w.address, user.token_address).catch(() => null))
    );
    let totalEth = 0, totalWeth = 0, totalToken = 0;
    let sym = user.token_symbol || 'TOKEN';
    let ethPrice = null, tokenPrice = null;
    for (const bal of results) {
      if (!bal) continue;
      totalEth   += parseFloat(bal.eth)   || 0;
      totalWeth  += parseFloat(bal.weth)  || 0;
      totalToken += parseFloat(bal.token?.replace(/,/g, '')) || 0;
      if (bal.tokenSymbol) sym = bal.tokenSymbol;
      if (bal.ethUsd) ethPrice = parseFloat(bal.ethUsd) / (parseFloat(bal.eth) || 1);
      if (bal.tokenUsd && parseFloat(bal.token?.replace(/,/g, '')) > 0)
        tokenPrice = parseFloat(bal.tokenUsd) / parseFloat(bal.token.replace(/,/g, ''));
    }
    const ethUsd   = ethPrice   ? `{gray-fg}  ~$${(totalEth * ethPrice).toFixed(2)}{/gray-fg}` : '';
    const wethUsd  = ethPrice && totalWeth > 0 ? `{gray-fg}  ~$${(totalWeth * ethPrice).toFixed(2)}{/gray-fg}` : '';
    const tokUsd   = tokenPrice ? `{gray-fg}  ~$${(totalToken * tokenPrice).toFixed(4)}{/gray-fg}` : '';
    let content =
      ` {white-fg}ETH   {/white-fg}  {green-fg}{bold}${totalEth.toFixed(4)}{/bold}{/green-fg}${ethUsd}  {gray-fg}(${wallets.length} wallets){/gray-fg}\n`;
    if (totalWeth > 0)
      content += ` {white-fg}WETH  {/white-fg}  {yellow-fg}${totalWeth.toFixed(6)}{/yellow-fg}${wethUsd}\n`;
    content +=
      ` {white-fg}${sym.padEnd(6)}{/white-fg}  {cyan-fg}{bold}${totalToken > 0 ? totalToken.toLocaleString() : '0'}{/bold}{/cyan-fg}${tokUsd}`;
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
  const wallets = getWallets(USER_ID);
  const poolKey = poolKeyFromUser(user);
  if (!poolKey) { addLog('{red-fg}\u2717 Pool key not configured \u2014 go to SETTINGS \u2192 Set Token Address{/red-fg}'); stopBot(); return; }
  if (wallets.length === 0) { addLog('{red-fg}\u2717 No wallets \u2014 go to SETTINGS{/red-fg}'); stopBot(); return; }
  const wallet   = wallets[Math.floor(Math.random() * wallets.length)];
  const shortAddr = wallet.address.slice(0,6) + '...' + wallet.address.slice(-4);
  const ethPrice = await getEthPrice().catch(() => 2000);
  const usdAmt   = randomBetween(user.min_amount_usd, user.max_amount_usd);
  const ethAmt   = usdAmt / ethPrice;
  const pk       = decrypt(wallet.encrypted);
  const isBuy    = Math.random() > 0.3;

  try {
    if (isBuy) {
      pendingMsg = 'Buying...'; updateTopBar();
      addLog(`{yellow-fg}\u25B2 BUY{/yellow-fg}   $${usdAmt.toFixed(2)}  (${ethAmt.toFixed(6)} ETH)  {gray-fg}[${shortAddr}]{/gray-fg}`);
      const r = await trader.buyToken(pk, user.token_address, ethAmt, null, poolKey);
      const gas = formatGas(r);
      recordTrade('buy', usdAmt, ethAmt, r);
      addLog(`{green-fg}\u2713 BUY OK{/green-fg}  #${user.trade_count + 1}  {gray-fg}Gas: ${gas} ETH  TX: ${r.hash.slice(0,18)}...{/gray-fg}`);
    } else {
      const pct = Math.floor(randomBetween(5, 15));
      pendingMsg = 'Selling...'; updateTopBar();
      addLog(`{magenta-fg}\u25BC SELL{/magenta-fg}  ${pct}% of ${user.token_symbol || 'TOKEN'}  {gray-fg}[${shortAddr}]{/gray-fg}`);
      const r = await trader.sellToken(pk, user.token_address, pct, null, 18, poolKey);
      const gas = formatGas(r);
      recordTrade('sell', 0, 0, r);
      addLog(`{green-fg}\u2713 SELL OK{/green-fg} #${user.trade_count + 1}  {gray-fg}Gas: ${gas} ETH  TX: ${r.hash.slice(0,18)}...{/gray-fg}`);
    }
  } catch (e) {
    const msg = (e.shortMessage || e.reason || e.message || '').slice(0, 60);
    addLog(`{red-fg}\u2717 ERR{/red-fg}   ${msg}  {gray-fg}[${shortAddr}]{/gray-fg}`);
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
  const wallets = getWallets(USER_ID);
  if (wallets.length === 0) { addLog('{red-fg}\u2717 No wallets \u2014 go to SETTINGS{/red-fg}'); return; }
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
  const wallets = getWallets(USER_ID);
  if (wallets.length === 0) { addLog('{red-fg}\u2717 No wallets \u2014 go to SETTINGS{/red-fg}'); return; }
  const poolKey = poolKeyFromUser(user);
  if (!poolKey) { addLog('{red-fg}\u2717 Pool key not set \u2014 go to SETTINGS \u2192 Set Token Address{/red-fg}'); return; }
  const wallet   = wallets[Math.floor(Math.random() * wallets.length)];
  const shortAddr = wallet.address.slice(0,6) + '...' + wallet.address.slice(-4);
  const ethPrice = await getEthPrice().catch(() => 2000);
  const ethAmt   = usdAmt / ethPrice;
  pendingMsg = 'Buying...'; updateTopBar();
  addLog(`{yellow-fg}\u25B2 BUY{/yellow-fg}   $${usdAmt.toFixed(2)} (manual)  {gray-fg}[${shortAddr}]{/gray-fg}`);
  try {
    const r = await trader.buyToken(decrypt(wallet.encrypted), user.token_address, ethAmt, null, poolKey);
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
  const wallets = getWallets(USER_ID);
  if (wallets.length === 0) { addLog('{red-fg}\u2717 No wallets \u2014 go to SETTINGS{/red-fg}'); return; }
  const poolKey = poolKeyFromUser(user);
  if (!poolKey) { addLog('{red-fg}\u2717 Pool key not set \u2014 go to SETTINGS \u2192 Set Token Address{/red-fg}'); if (wasRunning) startBot(); return; }
  pendingMsg = 'Selling...'; updateTopBar();
  // Sell from ALL wallets that hold tokens
  let sold = 0;
  for (const wallet of wallets) {
    const shortAddr = wallet.address.slice(0,6) + '...' + wallet.address.slice(-4);
    try {
      addLog(`{magenta-fg}\u25BC SELL{/magenta-fg}  ${pct}% (manual)  {gray-fg}[${shortAddr}]{/gray-fg}`);
      const r = await trader.sellToken(decrypt(wallet.encrypted), user.token_address, pct, null, 18, poolKey);
      const gas = formatGas(r);
      recordTrade('sell', 0, 0, r);
      addLog(`{green-fg}\u2713 SELL OK{/green-fg} {gray-fg}Gas: ${gas} ETH  TX: ${r.hash.slice(0,18)}...{/gray-fg}`);
      sold++;
    } catch (e) {
      const msg = (e.shortMessage || e.reason || e.message || '').slice(0, 60);
      if (!msg.includes('No tokens')) addLog(`{red-fg}\u2717 ERR{/red-fg}   ${msg}  {gray-fg}[${shortAddr}]{/gray-fg}`);
    }
  }
  addLog(`{green-fg}Sold from ${sold}/${wallets.length} wallets{/green-fg}`);
  await refreshBalances();
  pendingMsg = ''; updateTopBar(); updateInfo();
  if (wasRunning) startBot();
}

async function doUnwrapWETH() {
  const wallets = getWallets(USER_ID);
  if (wallets.length === 0) { addLog('{red-fg}\u2717 No wallets \u2014 go to SETTINGS{/red-fg}'); return; }
  pendingMsg = 'Unwrapping WETH...'; updateTopBar();
  addLog('{yellow-fg}\u{1F504} UNWRAP{/yellow-fg}  WETH \u2192 ETH (all wallets)');
  let unwrapped = 0;
  for (const w of wallets) {
    try {
      const pk = decrypt(w.encrypted);
      const wallet = new ethers.Wallet(pk, new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://mainnet.base.org'));
      await trader.unwrapWETH(wallet);
      unwrapped++;
    } catch (e) {
      const msg = (e.shortMessage || e.reason || e.message || '').slice(0, 60);
      if (msg) addLog(`{red-fg}\u2717 ERR{/red-fg}   ${msg}  {gray-fg}[${w.address.slice(0,6)}...]{/gray-fg}`);
    }
  }
  addLog(`{green-fg}\u2713 UNWRAP done{/green-fg}  ${unwrapped} wallets processed`);
  await refreshBalances();
  pendingMsg = ''; updateTopBar();
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
      '  \u{1F504}  Unwrap WETH \u2192 ETH',
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
    if (idx === 6) { overlay.destroy(); menuBox.focus(); screen.render(); return; }
    if (idx >= 0 && idx <= 3) {
      const pcts = [25, 50, 75, 100];
      overlay.destroy(); menuBox.focus(); screen.render();
      doSell(pcts[idx]);
      return;
    }
    // idx === 5: unwrap WETH
    if (idx === 5) {
      overlay.destroy(); menuBox.focus(); screen.render();
      doUnwrapWETH();
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
// ─── WALLET MANAGEMENT SUBMENU ───────────────────────────────────────────────
function openWalletManager() {
  const wallets = getWallets(USER_ID);
  const overlay = blessed.box({
    top: 'center', left: 'center', width: 54, height: 16,
    tags: true, border: { type: 'line' },
    label: ` {bold}{cyan-fg} Wallets (${wallets.length}) {/cyan-fg}{/bold} `,
    style: { bg: C.bgAlt, border: { fg: C.focus } },
  });

  const walletList = blessed.list({
    parent: overlay,
    top: 1, left: 1, right: 1, bottom: 3,
    tags: true,
    style: {
      bg: C.bgAlt, fg: C.text,
      selected: { bg: '#1f6feb', fg: 'white', bold: true },
    },
    keys: true, mouse: true,
    items: [
      '  \u{1F511}  Import Single Wallet',
      '  \u{1F4C4}  Bulk Import from wallets.txt',
      `  \u{1F441}  View Wallets (${wallets.length} loaded)`,
      '  \u{1F5D1}  Clear All Wallets',
      '  \u2190  Back',
    ],
  });

  blessed.text({
    parent: overlay, bottom: 1, left: 2, right: 2, height: 1, tags: true,
    content: '{gray-fg}Enter: select   Esc: back{/gray-fg}',
    style: { bg: C.bgAlt },
  });

  screen.append(overlay);
  walletList.focus();
  screen.render();

  walletList.on('select', (item, idx) => {
    // Back
    if (idx === 4) { overlay.destroy(); menuBox.focus(); screen.render(); return; }

    // Import Single Wallet
    if (idx === 0) {
      const inputBox = blessed.textbox({
        top: 'center', left: 'center', width: 54, height: 5,
        label: '  Private Key (hidden):  ',
        tags: true, border: { type: 'line' },
        style: { bg: C.bg, border: { fg: C.focus }, fg: 'white' },
        inputOnFocus: true, censor: true,
      });
      screen.append(inputBox);
      inputBox.focus();
      screen.render();
      inputBox.on('submit', (val) => {
        inputBox.destroy();
        const v = val.trim();
        try {
          const w = new ethers.Wallet(v);
          const current = getWallets(USER_ID);
          if (current.some(x => x.address.toLowerCase() === w.address.toLowerCase())) {
            addLog('{yellow-fg}\u26A0 Wallet already imported{/yellow-fg}');
          } else {
            current.push({ encrypted: encrypt(v), address: w.address });
            updateUser(USER_ID, { wallets: current, wallet_encrypted: current[0].encrypted, wallet_address: current[0].address });
            addLog(`{green-fg}\u2713{/green-fg} Wallet added: {cyan-fg}${w.address.slice(0,10)}...{/cyan-fg}  (${current.length} total)`);
          }
        } catch (e) { addLog(`{red-fg}\u2717 Invalid key: ${(e.message || '').slice(0,40)}{/red-fg}`); }
        updateInfo(); refreshBalances();
        overlay.destroy(); menuBox.focus(); screen.render();
      });
      inputBox.key(['escape'], () => { inputBox.destroy(); walletList.focus(); screen.render(); });
      return;
    }

    // Bulk Import from wallets.txt
    if (idx === 1) {
      const filePath = path.join(__dirname, 'wallets.txt');
      if (!fs.existsSync(filePath)) {
        addLog('{red-fg}\u2717 wallets.txt not found{/red-fg}  Create it with one private key per line');
        return;
      }
      const lines = fs.readFileSync(filePath, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      const current = getWallets(USER_ID);
      let added = 0, skipped = 0, failed = 0;
      for (const line of lines) {
        try {
          const w = new ethers.Wallet(line);
          if (current.some(x => x.address.toLowerCase() === w.address.toLowerCase())) {
            skipped++;
          } else {
            current.push({ encrypted: encrypt(line), address: w.address });
            added++;
          }
        } catch { failed++; }
      }
      updateUser(USER_ID, { wallets: current, wallet_encrypted: current[0]?.encrypted || null, wallet_address: current[0]?.address || null });
      addLog(`{green-fg}\u2713 Bulk import:{/green-fg} ${added} added, ${skipped} skipped (dup), ${failed} failed  {gray-fg}(${current.length} total){/gray-fg}`);
      updateInfo(); refreshBalances();
      overlay.destroy(); menuBox.focus(); screen.render();
      return;
    }

    // View Wallets
    if (idx === 2) {
      const current = getWallets(USER_ID);
      if (current.length === 0) {
        addLog('{yellow-fg}No wallets imported yet{/yellow-fg}');
        return;
      }
      const viewOverlay = blessed.box({
        top: 'center', left: 'center', width: 56, height: Math.min(current.length + 6, 30),
        tags: true, border: { type: 'line' },
        label: ` {bold}{cyan-fg} ${current.length} Wallets {/cyan-fg}{/bold} `,
        style: { bg: C.bgAlt, border: { fg: C.focus } },
      });
      const viewLog = blessed.log({
        parent: viewOverlay,
        top: 1, left: 1, right: 1, bottom: 3,
        tags: true, scrollable: true, mouse: true,
        style: { bg: C.bgAlt, fg: C.text },
      });
      for (let i = 0; i < current.length; i++) {
        viewLog.log(`{gray-fg}#${(i+1).toString().padStart(2)}{/gray-fg}  {cyan-fg}${current[i].address}{/cyan-fg}`);
      }
      blessed.text({
        parent: viewOverlay, bottom: 1, left: 2, right: 2, height: 1, tags: true,
        content: '{gray-fg}Esc: close{/gray-fg}',
        style: { bg: C.bgAlt },
      });
      screen.append(viewOverlay);
      viewOverlay.focus();
      screen.render();
      viewOverlay.key(['escape', 'q', 'enter'], () => { viewOverlay.destroy(); walletList.focus(); screen.render(); });
      return;
    }

    // Clear All Wallets
    if (idx === 3) {
      updateUser(USER_ID, { wallets: [], wallet_encrypted: null, wallet_address: null });
      addLog('{yellow-fg}\u2717 All wallets cleared{/yellow-fg}');
      updateInfo(); refreshBalances();
      overlay.destroy(); menuBox.focus(); screen.render();
      return;
    }
  });

  walletList.key(['escape', 'q'], () => { overlay.destroy(); menuBox.focus(); screen.render(); });
}

function openSettings() {
  const wallets = getWallets(USER_ID);
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
      `  \u{1F4B0}  Manage Wallets (${wallets.length} loaded)`,
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

    // Manage Wallets
    if (idx === 0) {
      overlay.destroy(); menuBox.focus(); screen.render();
      openWalletManager();
      return;
    }

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

    // Numeric settings (idx 3-6)
    const labels = [
      '', '', '', // wallet, token, pool handled above
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
    });

    screen.append(inputBox);
    inputBox.focus();
    screen.render();

    inputBox.on('submit', (val) => {
      inputBox.destroy();
      const v = val.trim();
      try {
        if (idx === 3) { updateUser(USER_ID, { min_amount_usd: parseFloat(v) }); addLog(`{green-fg}\u2713{/green-fg} Min amount: $${v}`); }
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
const wallets0 = getWallets(USER_ID);
addLog(wallets0.length > 0
  ? `{cyan-fg}\u{1F511} ${wallets0.length} wallet${wallets0.length > 1 ? 's' : ''} loaded{/cyan-fg}`
  : '{yellow-fg}\u26A0 No wallets \u2014 go to SETTINGS to import{/yellow-fg}');
addLog('{gray-fg}Navigate with \u2191/\u2193, press Enter to select.{/gray-fg}');
updateTopBar();
updateInfo();
refreshBalances();
screen.render();


