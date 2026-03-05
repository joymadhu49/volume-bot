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

// ─── State ───────────────────────────────────────────────────────────────────
let running       = false;
let tradeTimer    = null;
let nextTradeIn   = 0;
let countdownTimer = null;
let pendingMsg    = '';

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
  fullUnicode: false, forceUnicode: false,
  ignoreLocked: ['C-c'],
});

// ─── TOP BAR ─────────────────────────────────────────────────────────────────
const topBar = blessed.box({
  top: 0, left: 0, width: '100%', height: 3,
  tags: true,
  style: { bg: '#0d1117', fg: 'white' },
  border: { type: 'line' },
  style: { bg: '#0d1117', border: { fg: '#30363d' } },
  padding: { left: 1 },
});

// ─── LEFT: Menu ──────────────────────────────────────────────────────────────
const menuBox = blessed.list({
  top: 3, left: 0, width: '28%', height: '55%',
  label: ' {bold}{cyan-fg} ACTIONS {/cyan-fg}{/bold} ',
  tags: true,
  border: { type: 'line' },
  style: {
    bg: '#0d1117', border: { fg: '#30363d' },
    selected: { bg: '#238636', fg: 'white', bold: true },
    item: { fg: '#c9d1d9' },
    label: { fg: 'cyan' },
  },
  keys: true, vi: false, mouse: true,
  padding: { left: 1, top: 1 },
  items: [
    ' START BOT',
    ' STOP BOT',
    ' BUY  (random)',
    ' SELL 100%',
    ' SETTINGS',
    ' QUIT',
  ],
});

// ─── RIGHT TOP: Balances ──────────────────────────────────────────────────────
const balBox = blessed.box({
  top: 3, right: 0, width: '72%', height: '28%',
  label: ' {bold}{yellow-fg} BALANCES {/yellow-fg}{/bold} ',
  tags: true,
  border: { type: 'line' },
  style: { bg: '#0d1117', border: { fg: '#30363d' } },
  padding: { left: 2, top: 1 },
  content: '{gray-fg}Loading...{/gray-fg}',
});

// ─── RIGHT BOTTOM: Config Info ────────────────────────────────────────────────
const infoBox = blessed.box({
  top: '28%+3', right: 0, width: '72%',
  bottom: '45%',
  label: ' {bold}{magenta-fg} CONFIG {/magenta-fg}{/bold} ',
  tags: true,
  border: { type: 'line' },
  style: { bg: '#0d1117', border: { fg: '#30363d' } },
  padding: { left: 2, top: 0 },
  content: '',
});

// ─── TRADE LOG ───────────────────────────────────────────────────────────────
const logBox = blessed.log({
  bottom: 2, left: 0, width: '100%', height: '45%',
  label: ' {bold}{green-fg} TRADE LOG {/green-fg}{/bold} ',
  tags: true,
  border: { type: 'line' },
  style: { bg: '#0d1117', border: { fg: '#30363d' }, scrollbar: { bg: '#238636' } },
  padding: { left: 1 },
  scrollable: true, alwaysScroll: true, mouse: true,
  scrollbar: { ch: ' ', track: { bg: '#161b22' } },
});

// ─── BOTTOM BAR ──────────────────────────────────────────────────────────────
const botBar = blessed.box({
  bottom: 0, left: 0, width: '100%', height: 2,
  tags: true,
  style: { bg: '#161b22', fg: '#8b949e' },
  content: '{center}{gray-fg} Up/Down: navigate    Enter: select    R: refresh balances    Q: quit {/gray-fg}{/center}',
});

screen.append(topBar);
screen.append(menuBox);
screen.append(balBox);
screen.append(infoBox);
screen.append(logBox);
screen.append(botBar);
menuBox.focus();

// ─── TOP BAR UPDATE ──────────────────────────────────────────────────────────
function updateTopBar() {
  const user   = getUser(USER_ID) || {};
  const status = running
    ? '{green-fg}{bold} RUNNING {/bold}{/green-fg}'
    : '{red-fg}{bold} STOPPED {/red-fg}{/bold}';
  const next   = running && nextTradeIn > 0
    ? `{yellow-fg}Next: ${nextTradeIn}s{/yellow-fg}  `
    : '';
  const trades = `{cyan-fg}Trades: ${user.trade_count || 0}{/cyan-fg}`;
  const now    = new Date().toLocaleTimeString('en-US', { hour12: false });
  const pend   = pendingMsg ? `  {yellow-fg}${pendingMsg}{/yellow-fg}` : '';

  topBar.setContent(
    `  {bold}{white-fg}VOLUME BOT{/white-fg}{/bold}   ${status}   ${next}${trades}${pend}   {gray-fg}${now}{/gray-fg}`
  );
  screen.render();
}

// ─── INFO BOX UPDATE ─────────────────────────────────────────────────────────
function updateInfo() {
  const user = getUser(USER_ID) || {};
  const wallet = user.wallet_address
    ? `{cyan-fg}${user.wallet_address.slice(0,10)}...${user.wallet_address.slice(-6)}{/cyan-fg}`
    : '{red-fg}NOT SET - go to SETTINGS{/red-fg}';
  infoBox.setContent(
    ` Wallet   : ${wallet}\n` +
    ` Token    : {cyan-fg}${user.token_symbol || 'MIME'}{/cyan-fg}  {gray-fg}${(user.token_address||'').slice(0,12)}...{/gray-fg}\n` +
    ` Amount   : {yellow-fg}$${user.min_amount_usd||0.10} - $${user.max_amount_usd||0.50}{/yellow-fg}\n` +
    ` Interval : {yellow-fg}${user.min_interval_sec||20}s - ${user.max_interval_sec||60}s{/yellow-fg}`
  );
  screen.render();
}

// ─── BALANCES ────────────────────────────────────────────────────────────────
async function refreshBalances() {
  const user = getUser(USER_ID) || {};
  if (!user.wallet_address) {
    balBox.setContent('{red-fg}  No wallet — go to SETTINGS to import{/red-fg}');
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

// ─── COUNTDOWN ───────────────────────────────────────────────────────────────
function startCountdown(seconds) {
  nextTradeIn = seconds;
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
  const user     = getUser(USER_ID);
  const poolKey  = { currency0: user.token_address, currency1: WETH, fee: user.fee_tier, tickSpacing: user.tick_spacing, hooks: user.hook_address };
  const ethPrice = await getEthPrice().catch(() => 2000);
  const usdAmt   = randomBetween(user.min_amount_usd, user.max_amount_usd);
  const ethAmt   = usdAmt / ethPrice;
  const pk       = decrypt(user.wallet_encrypted);
  const isBuy    = Math.random() > 0.3;

  try {
    if (isBuy) {
      pendingMsg = 'Buying...'; updateTopBar();
      addLog(`{yellow-fg}BUY{/yellow-fg}   $${usdAmt.toFixed(2)}  (${ethAmt.toFixed(6)} ETH)`);
      const r = await trader.buyToken(pk, user.token_address, ethAmt, null, poolKey);
      updateUser(USER_ID, { trade_count: user.trade_count + 1 });
      addLog(`{green-fg}OK{/green-fg}    BUY #${user.trade_count + 1}  {gray-fg}${r.hash.slice(0,22)}...{/gray-fg}`);
    } else {
      const pct = Math.floor(randomBetween(5, 15));
      pendingMsg = 'Selling...'; updateTopBar();
      addLog(`{magenta-fg}SELL{/magenta-fg}  ${pct}% of ${user.token_symbol || 'TOKEN'}`);
      const r = await trader.sellToken(pk, user.token_address, pct, null, 18, poolKey);
      updateUser(USER_ID, { trade_count: user.trade_count + 1 });
      addLog(`{green-fg}OK{/green-fg}    SELL #${user.trade_count + 1}  {gray-fg}${r.hash.slice(0,22)}...{/gray-fg}`);
    }
  } catch (e) {
    addLog(`{red-fg}ERR{/red-fg}   ${e.message.slice(0, 70)}`);
  }

  pendingMsg = ''; updateTopBar();
  updateInfo();
  await refreshBalances();

  if (running) {
    const delay = Math.floor(randomBetween(user.min_interval_sec, user.max_interval_sec));
    addLog(`{gray-fg}WAIT  ${delay}s...{/gray-fg}`);
    startCountdown(delay);
    tradeTimer = setTimeout(runTrade, delay * 1000);
  }
}

function startBot() {
  const user = getUser(USER_ID);
  if (!user?.wallet_encrypted) { addLog('{red-fg}ERR   No wallet — go to SETTINGS{/red-fg}'); return; }
  if (running) { addLog('{gray-fg}Already running{/gray-fg}'); return; }
  running = true;
  addLog('{green-fg}{bold}--- BOT STARTED ---{/bold}{/green-fg}');
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
  addLog('{red-fg}{bold}--- BOT STOPPED ---{/bold}{/red-fg}');
  updateTopBar(); updateInfo();
}

async function doBuy(usdAmt) {
  const user = getUser(USER_ID);
  if (!user?.wallet_encrypted) { addLog('{red-fg}ERR   No wallet — go to SETTINGS{/red-fg}'); return; }
  const poolKey  = { currency0: user.token_address, currency1: WETH, fee: user.fee_tier, tickSpacing: user.tick_spacing, hooks: user.hook_address };
  const ethPrice = await getEthPrice().catch(() => 2000);
  const ethAmt   = usdAmt / ethPrice;
  pendingMsg = 'Buying...'; updateTopBar();
  addLog(`{yellow-fg}BUY{/yellow-fg}   $${usdAmt.toFixed(2)} (manual)`);
  try {
    const r = await trader.buyToken(decrypt(user.wallet_encrypted), user.token_address, ethAmt, null, poolKey);
    updateUser(USER_ID, { trade_count: user.trade_count + 1 });
    addLog(`{green-fg}OK{/green-fg}    BUY  {gray-fg}${r.hash.slice(0,22)}...{/gray-fg}`);
    await refreshBalances();
  } catch (e) { addLog(`{red-fg}ERR{/red-fg}   ${e.message.slice(0,70)}`); }
  pendingMsg = ''; updateTopBar(); updateInfo();
}

async function doSell(pct) {
  const wasRunning = running;
  if (running) stopBot();
  const user = getUser(USER_ID);
  if (!user?.wallet_encrypted) { addLog('{red-fg}ERR   No wallet — go to SETTINGS{/red-fg}'); return; }
  const poolKey = { currency0: user.token_address, currency1: WETH, fee: user.fee_tier, tickSpacing: user.tick_spacing, hooks: user.hook_address };
  pendingMsg = 'Selling...'; updateTopBar();
  addLog(`{magenta-fg}SELL{/magenta-fg}  ${pct}% (manual)`);
  try {
    const r = await trader.sellToken(decrypt(user.wallet_encrypted), user.token_address, pct, null, 18, poolKey);
    updateUser(USER_ID, { trade_count: user.trade_count + 1 });
    addLog(`{green-fg}OK{/green-fg}    SELL {gray-fg}${r.hash.slice(0,22)}...{/gray-fg}`);
    await refreshBalances();
  } catch (e) { addLog(`{red-fg}ERR{/red-fg}   ${e.message.slice(0,70)}`); }
  pendingMsg = ''; updateTopBar(); updateInfo();
  if (wasRunning) startBot();
}

// ─── SETTINGS ────────────────────────────────────────────────────────────────
function openSettings() {
  const overlay = blessed.box({
    top: 'center', left: 'center', width: 52, height: 12,
    tags: true, border: { type: 'line' },
    label: ' {bold}{magenta-fg} SETTINGS {/magenta-fg}{/bold} ',
    style: { bg: '#161b22', border: { fg: '#58a6ff' } },
  });

  const settingsList = blessed.list({
    parent: overlay,
    top: 1, left: 1, right: 1, bottom: 3,
    tags: true,
    style: {
      bg: '#161b22', fg: '#c9d1d9',
      selected: { bg: '#1f6feb', fg: 'white', bold: true },
    },
    keys: true, mouse: true,
    items: [
      '  Import Wallet (Private Key)',
      '  Set Trade Amount (USD range)',
      '  Set Interval (seconds range)',
      '  Back',
    ],
  });

  blessed.text({
    parent: overlay, bottom: 1, left: 2, right: 2, height: 1, tags: true,
    content: '{gray-fg}Enter: select   Esc: back{/gray-fg}',
    style: { bg: '#161b22' },
  });

  screen.append(overlay);
  settingsList.focus();
  screen.render();

  function askInput(label, defaultVal, censor, cb) {
    const inp = blessed.textbox({
      top: 'center', left: 'center', width: 54, height: 5,
      label: '  ' + label + '  ',
      tags: true, border: { type: 'line' },
      style: { bg: '#0d1117', border: { fg: '#58a6ff' }, fg: 'white' },
      inputOnFocus: true,
      censor: !!censor,
    });
    screen.append(inp);
    inp.focus();
    screen.render();
    inp.on('submit', (v) => { inp.destroy(); cb(v.trim()); });
    inp.key(['escape'], () => { inp.destroy(); settingsList.focus(); screen.render(); });
  }

  settingsList.on('select', (item, idx) => {
    if (idx === 3) { overlay.destroy(); menuBox.focus(); screen.render(); return; }

    if (idx === 0) {
      askInput('Private Key (hidden):', '', true, (v) => {
        try {
          const w = new ethers.Wallet(v);
          updateUser(USER_ID, { wallet_encrypted: encrypt(v), wallet_address: w.address });
          const envPath = require('path').join(__dirname, '.env');
          let envRaw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
          envRaw = envRaw.match(/^PRIVATE_KEY=/m)
            ? envRaw.replace(/^PRIVATE_KEY=.*/m, 'PRIVATE_KEY=' + v)
            : envRaw + '\nPRIVATE_KEY=' + v;
          fs.writeFileSync(envPath, envRaw);
          addLog('{green-fg}OK{/green-fg}    Wallet: {cyan-fg}' + w.address + '{/cyan-fg}');
        } catch (e) { addLog('{red-fg}ERR{/red-fg}   ' + e.message); }
        updateInfo(); refreshBalances();
        overlay.destroy(); menuBox.focus(); screen.render();
      });

    } else if (idx === 1) {
      const u = getUser(USER_ID) || {};
      askInput('Min Amount USD (e.g. 0.10):', String(u.min_amount_usd || 0.10), false, (minV) => {
        askInput('Max Amount USD (e.g. 0.50):', String(u.max_amount_usd || 0.50), false, (maxV) => {
          updateUser(USER_ID, { min_amount_usd: parseFloat(minV), max_amount_usd: parseFloat(maxV) });
          addLog('{green-fg}OK{/green-fg}    Amount: {yellow-fg}$' + minV + ' - $' + maxV + '{/yellow-fg}');
          updateInfo();
          overlay.destroy(); menuBox.focus(); screen.render();
        });
      });

    } else if (idx === 2) {
      const u = getUser(USER_ID) || {};
      askInput('Min Interval seconds (e.g. 10):', String(u.min_interval_sec || 20), false, (minV) => {
        askInput('Max Interval seconds (e.g. 30):', String(u.max_interval_sec || 60), false, (maxV) => {
          updateUser(USER_ID, { min_interval_sec: parseInt(minV), max_interval_sec: parseInt(maxV) });
          addLog('{green-fg}OK{/green-fg}    Interval: {yellow-fg}' + minV + 's - ' + maxV + 's{/yellow-fg}');
          updateInfo();
          overlay.destroy(); menuBox.focus(); screen.render();
        });
      });
    }
  });

  settingsList.key(['escape', 'q'], () => { overlay.destroy(); menuBox.focus(); screen.render(); });
}


menuBox.on('select', (item, idx) => {
  const u = getUser(USER_ID);
  const actions = [
    () => startBot(),
    () => stopBot(),
    () => doBuy(randomBetween(u?.min_amount_usd || 0.1, u?.max_amount_usd || 0.5)),
    () => doSell(100),
    () => openSettings(),
    () => { stopBot(); screen.destroy(); process.exit(0); },
  ];
  if (actions[idx]) actions[idx]();
});

// ─── GLOBAL KEYS ──────────────────────────────────────────────────────────────
screen.key(['r', 'R'], () => { addLog('{gray-fg}Refreshing...{/gray-fg}'); refreshBalances(); });
screen.key(['q', 'Q'], () => { stopBot(); screen.destroy(); process.exit(0); });
screen.key('C-c',      () => { stopBot(); screen.destroy(); process.exit(0); });

// ─── CLOCK ───────────────────────────────────────────────────────────────────
setInterval(updateTopBar, 1000);

// ─── INIT ─────────────────────────────────────────────────────────────────────
const user0 = getUser(USER_ID);
addLog(user0?.wallet_address
  ? `{cyan-fg}Wallet loaded: ${user0.wallet_address.slice(0,10)}...${user0.wallet_address.slice(-6)}{/cyan-fg}`
  : '{yellow-fg}No wallet — go to SETTINGS to import your private key{/yellow-fg}');
addLog('{gray-fg}Navigate with Up/Down, press Enter to select.{/gray-fg}');
updateTopBar();
updateInfo();
refreshBalances();
screen.render();


