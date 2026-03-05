#!/usr/bin/env node
'use strict';
require('dotenv').config();

const blessed = require('blessed');
const { ethers } = require('ethers');
const { getUser, updateUser } = require('./db');
const { decrypt, encrypt, getEthPrice, randomBetween } = require('./utils');
const trader  = require('./trader');

const USER_ID = 7332734457;
const WETH    = '0x4200000000000000000000000000000000000006';

// ─── State ───────────────────────────────────────────────────────────────────
let running    = false;
let tradeTimer = null;

// ─── Screen ──────────────────────────────────────────────────────────────────
const screen = blessed.screen({
  smartCSR:     true,
  title:        'Volume Bot',
  fullUnicode:  false,
  forceUnicode: false,
  ignoreLocked: ['C-c'],
});

// ─── Header ───────────────────────────────────────────────────────────────────
const header = blessed.box({
  top: 0, left: 0,
  width: '100%', height: 5,
  tags: true,
  style: { bg: 'blue', fg: 'white' },
  content: [
    '{center}{bold}',
    '  __   ______  _    _   _   __  _  _  ____    ____   ____  ____  ',
    ' \\ \\ / / __ \\| |  | | | | |  \\| || || ___| | __ ) / __ \\|_  _| ',
    '  \\ V / |  | | |  | | | | | . ` || || |__   |  _ \\| |  | | | |  ',
    '   \\_/  |___|_|__|_| |_| |_|\\_| |_||_|____| |____/ \\____/ |_|  ',
    '{/bold}  Base Chain  |  Uniswap V4  |  ChainSoul{/center}',
  ].join('\n'),
});

// ─── Info Panel (top-right) ───────────────────────────────────────────────────
const infoBox = blessed.box({
  top: 5, right: 0,
  width: '65%', height: 12,
  label: '  INFO  ',
  tags: true,
  border: { type: 'ascii' },
  style: { border: { fg: 'cyan' }, bg: 'black', fg: 'white' },
  padding: { left: 1, top: 0 },
  content: ' Loading...',
});

// ─── Menu (left) ─────────────────────────────────────────────────────────────
const menu = blessed.list({
  top: 5, left: 0,
  width: '35%', height: 12,
  label: '  MENU  ',
  tags: true,
  border: { type: 'ascii' },
  style: {
    border:   { fg: 'yellow' },
    bg:       'black',
    fg:       'white',
    selected: { bg: 'yellow', fg: 'black', bold: true },
    item:     { fg: 'white' },
  },
  keys:    true,
  vi:      false,
  mouse:   true,
  items: [
    '  START BOT',
    '  STOP BOT',
    '  BUY  (random amount)',
    '  SELL 100%',
    '  SETTINGS',
    '  QUIT',
  ],
});

// ─── Trade Log ────────────────────────────────────────────────────────────────
const logBox = blessed.log({
  top: 17, left: 0,
  width: '100%',
  bottom: 2,
  label: '  TRADE LOG  ',
  tags: true,
  border: { type: 'ascii' },
  style: { border: { fg: 'green' }, bg: 'black', fg: 'white' },
  padding:      { left: 1 },
  scrollable:   true,
  alwaysScroll: true,
  mouse:        true,
});

// ─── Footer ───────────────────────────────────────────────────────────────────
const footer = blessed.box({
  bottom: 0, left: 0,
  width: '100%', height: 2,
  tags: true,
  style: { bg: 'black', fg: 'gray' },
  content: '{center} UP / DOWN : navigate menu    ENTER : select    Q : quit {/center}',
});

screen.append(header);
screen.append(infoBox);
screen.append(menu);
screen.append(logBox);
screen.append(footer);
menu.focus();

// ─── Log Helper ──────────────────────────────────────────────────────────────
function addLog(msg) {
  const t = new Date().toLocaleTimeString('en-US', { hour12: false });
  logBox.log(`[${t}] ${msg}`);
  screen.render();
}

// ─── Info Refresh ─────────────────────────────────────────────────────────────
async function refreshInfo() {
  const user   = getUser(USER_ID);
  const status = running ? '{green-fg}[ RUNNING ]{/green-fg}' : '{red-fg}[ STOPPED ]{/red-fg}';
  const wallet = user.wallet_address
    ? `${user.wallet_address.slice(0,10)}...${user.wallet_address.slice(-6)}`
    : 'NOT SET';

  let balLine = ' Loading balances...';
  try {
    const bal = await trader.getBalances(user.wallet_address, user.token_address);
    const sym = bal.tokenSymbol || user.token_symbol || 'TOKEN';
    const ethLine   = ` ETH    : ${bal.eth}` + (bal.ethUsd ? `  ($${bal.ethUsd})` : '');
    const wethLine  = bal.weth ? ` WETH   : ${bal.weth}` + (bal.wethUsd ? `  ($${bal.wethUsd})` : '') + '\n' : '';
    const tokenLine = ` ${sym.padEnd(6)}: ${bal.token}` + (bal.tokenUsd ? `  ($${bal.tokenUsd})` : '');
    balLine = ethLine + '\n' + wethLine + tokenLine;
  } catch {}

  infoBox.setContent(
    ` Status  : ${status}\n` +
    ` Trades  : {bold}${user.trade_count}{/bold}\n` +
    ` Wallet  : {cyan-fg}${wallet}{/cyan-fg}\n` +
    ` Token   : {cyan-fg}${user.token_symbol || 'Not set'}{/cyan-fg}\n` +
    ` Amount  : $${user.min_amount_usd} - $${user.max_amount_usd}  |  Interval: ${user.min_interval_sec}s - ${user.max_interval_sec}s\n` +
    ' ----------------------------------------\n' +
    balLine
  );
  screen.render();
}

// ─── Settings Wizard ──────────────────────────────────────────────────────────
function openSettings() {
  const user = getUser(USER_ID);

  const settingsMenu = blessed.list({
    top:    'center',
    left:   'center',
    width:  50,
    height: 14,
    label:  '  SETTINGS  ',
    tags:   true,
    border: { type: 'ascii' },
    style: {
      border:   { fg: 'magenta' },
      bg:       'black',
      fg:       'white',
      selected: { bg: 'magenta', fg: 'white', bold: true },
    },
    keys:  true,
    mouse: true,
    items: [
      '  Import Wallet (Private Key)',
      '  Set Min Trade Amount (USD)',
      '  Set Max Trade Amount (USD)',
      '  Set Min Interval (seconds)',
      '  Set Max Interval (seconds)',
      '  Back',
    ],
  });

  screen.append(settingsMenu);
  settingsMenu.focus();
  screen.render();

  settingsMenu.on('select', (item, idx) => {
    settingsMenu.destroy();

    if (idx === 5) { menu.focus(); screen.render(); return; }

    // Show input prompt
    const prompts = [
      'Enter private key:',
      'Min trade USD (e.g. 0.10):',
      'Max trade USD (e.g. 0.50):',
      'Min interval seconds (e.g. 10):',
      'Max interval seconds (e.g. 30):',
    ];

    const input = blessed.textbox({
      top:    'center',
      left:   'center',
      width:  50,
      height: 5,
      label:  `  ${prompts[idx]}  `,
      tags:   true,
      border: { type: 'ascii' },
      style:  { border: { fg: 'magenta' }, bg: 'black', fg: 'white' },
      inputOnFocus: true,
      censor: idx === 0,
    });

    screen.append(input);
    input.focus();
    screen.render();

    input.on('submit', (val) => {
      input.destroy();
      const v = val.trim();
      try {
        if (idx === 0) {
          const w = new ethers.Wallet(v);
          updateUser(USER_ID, { wallet_encrypted: encrypt(v), wallet_address: w.address });
          addLog(`Wallet imported: ${w.address}`);
        } else if (idx === 1) {
          updateUser(USER_ID, { min_amount_usd: parseFloat(v) });
          addLog(`Min amount set: $${v}`);
        } else if (idx === 2) {
          updateUser(USER_ID, { max_amount_usd: parseFloat(v) });
          addLog(`Max amount set: $${v}`);
        } else if (idx === 3) {
          updateUser(USER_ID, { min_interval_sec: parseInt(v) });
          addLog(`Min interval set: ${v}s`);
        } else if (idx === 4) {
          updateUser(USER_ID, { max_interval_sec: parseInt(v) });
          addLog(`Max interval set: ${v}s`);
        }
      } catch (e) {
        addLog(`Error: ${e.message}`);
      }
      refreshInfo();
      menu.focus();
      screen.render();
    });

    input.key(['escape'], () => {
      input.destroy();
      menu.focus();
      screen.render();
    });
  });

  settingsMenu.key(['escape', 'q'], () => {
    settingsMenu.destroy();
    menu.focus();
    screen.render();
  });
}

// ─── Trading ─────────────────────────────────────────────────────────────────
async function runTrade() {
  if (!running) return;

  const user     = getUser(USER_ID);
  const poolKey  = { currency0: user.token_address, currency1: WETH, fee: user.fee_tier, tickSpacing: user.tick_spacing, hooks: user.hook_address };
  const ethPrice = await getEthPrice().catch(() => 2000);
  const usdAmt   = randomBetween(user.min_amount_usd, user.max_amount_usd);
  const ethAmt   = usdAmt / ethPrice;
  // ethAmt is a float; trader.buyToken converts to BigInt internally
  const pk       = decrypt(user.wallet_encrypted);
  const isBuy    = Math.random() > 0.3;

  try {
    if (isBuy) {
      addLog(`BUY  $${usdAmt.toFixed(2)} (${ethAmt.toFixed(6)} ETH) ...`);
      const r = await trader.buyToken(pk, user.token_address, ethAmt, null, poolKey);
      updateUser(USER_ID, { trade_count: user.trade_count + 1 });
      addLog(`OK   BUY #${user.trade_count + 1} - ${r.hash.slice(0, 20)}...`);
    } else {
      const pct = Math.floor(randomBetween(5, 15));
      addLog(`SELL ${pct}% of ${user.token_symbol || 'TOKEN'} ...`);
      const r = await trader.sellToken(pk, user.token_address, pct, null, 18, poolKey);
      updateUser(USER_ID, { trade_count: user.trade_count + 1 });
      addLog(`OK   SELL #${user.trade_count + 1} - ${r.hash.slice(0, 20)}...`);
    }
  } catch (e) {
    addLog(`ERR  ${e.message.slice(0, 70)}`);
  }

  await refreshInfo();

  if (running) {
    const delay = randomBetween(user.min_interval_sec, user.max_interval_sec) * 1000;
    addLog(`WAIT ${(delay / 1000).toFixed(0)}s until next trade...`);
    tradeTimer = setTimeout(runTrade, delay);
  }
}

function startBot() {
  const user = getUser(USER_ID);
  if (!user.wallet_encrypted) { addLog('ERROR: No wallet set. Go to SETTINGS first.'); return; }
  if (running) { addLog('Already running.'); return; }
  running = true;
  addLog('--- BOT STARTED ---');
  refreshInfo();
  runTrade();
}

function stopBot() {
  if (!running) { addLog('Already stopped.'); return; }
  running = false;
  if (tradeTimer) { clearTimeout(tradeTimer); tradeTimer = null; }
  addLog('--- BOT STOPPED ---');
  refreshInfo();
}

async function doSell(pct) {
  const wasRunning = running;
  if (running) stopBot();
  const user    = getUser(USER_ID);
  if (!user.wallet_encrypted) { addLog('ERROR: No wallet set.'); return; }
  const poolKey = { currency0: user.token_address, currency1: WETH, fee: user.fee_tier, tickSpacing: user.tick_spacing, hooks: user.hook_address };
  addLog(`SELL ${pct}% (manual) ...`);
  try {
    const r = await trader.sellToken(decrypt(user.wallet_encrypted), user.token_address, pct, null, 18, poolKey);
    updateUser(USER_ID, { trade_count: user.trade_count + 1 });
    addLog(`OK   SELL ${pct}% - ${r.hash.slice(0, 20)}...`);
    await refreshInfo();
  } catch (e) {
    addLog(`ERR  ${e.message.slice(0, 70)}`);
  }
  if (wasRunning) startBot();
}

// ─── Manual Buy ──────────────────────────────────────────────────────────────
async function doBuy(usdAmt) {
  const user    = getUser(USER_ID);
  if (!user.wallet_encrypted) { addLog('ERROR: No wallet set. Go to SETTINGS first.'); return; }
  const poolKey  = { currency0: user.token_address, currency1: WETH, fee: user.fee_tier, tickSpacing: user.tick_spacing, hooks: user.hook_address };
  const ethPrice = await getEthPrice().catch(() => 2000);
  const ethAmt   = usdAmt / ethPrice;   // float — trader.buyToken converts internally
  addLog(`BUY  $${usdAmt.toFixed(2)} (${ethAmt.toFixed(6)} ETH) manual ...`);
  try {
    const r = await trader.buyToken(decrypt(user.wallet_encrypted), user.token_address, ethAmt, null, poolKey);
    updateUser(USER_ID, { trade_count: user.trade_count + 1 });
    addLog(`OK   BUY $${usdAmt.toFixed(2)} - ${r.hash.slice(0, 20)}...`);
    await refreshInfo();
  } catch (e) {
    addLog(`ERR  ${e.message.slice(0, 70)}`);
  }
}

// ─── Menu Actions ─────────────────────────────────────────────────────────────
menu.on('select', (item, idx) => {
  const actions = [
    () => startBot(),
    () => stopBot(),
    () => { const u = getUser(USER_ID); doBuy(randomBetween(u.min_amount_usd, u.max_amount_usd)); },
    () => doSell(100),
    () => openSettings(),
    () => { screen.destroy(); process.exit(0); },
  ];
  if (actions[idx]) actions[idx]();
});

// ─── Global Keys ──────────────────────────────────────────────────────────────
screen.key(['q', 'Q'], () => {
  stopBot();
  screen.destroy();
  process.exit(0);
});
screen.key('C-c', () => {
  stopBot();
  screen.destroy();
  process.exit(0);
});

// ─── Init ─────────────────────────────────────────────────────────────────────
screen.render();
addLog('Ready. Use UP/DOWN arrows to navigate, ENTER to select.');
refreshInfo();



