require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');
const { getUser, createUser, updateUser } = require('./db');
const { encrypt, decrypt, importWallet, getEthPrice, randomBetween, shortAddress } = require('./utils');
const trader = require('./trader');

// Build poolKey object from user DB fields
function poolKeyFromUser(user) {
  if (!user.fee_tier || !user.tick_spacing || !user.hook_address) return null;
  return {
    currency0:   user.token_address.toLowerCase() < '0x4200000000000000000000000000000000000006'.toLowerCase()
                   ? user.token_address
                   : '0x4200000000000000000000000000000000000006',
    currency1:   user.token_address.toLowerCase() < '0x4200000000000000000000000000000000000006'.toLowerCase()
                   ? '0x4200000000000000000000000000000000000006'
                   : user.token_address,
    fee:         user.fee_tier,
    tickSpacing: user.tick_spacing,
    hooks:       user.hook_address,
  };
}

const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(session());

// Active trading loops: userId -> { running, timer }
const activeBots = new Map();

// ─── HELPERS ────────────────────────────────────────────────────────────────

function mainMenuText(user, balances) {
  const running = activeBots.get(user.user_id)?.running;
  const status  = running ? '🟢 Running' : '🔴 Stopped';
  const wallet  = user.wallet_address ? `\`${shortAddress(user.wallet_address)}\`` : '⚠️ Not set';
  const token   = user.token_address  ? `\`${shortAddress(user.token_address)}\``  : '⚠️ Not set';
  const sym     = balances?.tokenSymbol || user.token_symbol || 'TOKEN';

  let text = `*🤖 ChainSoul Volume Bot*\n\n`;
  text += `👛 Wallet: ${wallet}\n`;
  text += `🪙 Token: ${token}\n`;

  if (balances) {
    const ethUsd   = balances.ethUsd   ? ` _(~$${balances.ethUsd})_`   : '';
    const tokenUsd = balances.tokenUsd ? ` _(~$${balances.tokenUsd})_` : '';
    text += `💰 ETH: \`${balances.eth}\`${ethUsd}\n`;
    if (balances.weth) {
      const wethUsd = balances.wethUsd ? ` _(~$${balances.wethUsd})_` : '';
      text += `🔶 WETH: \`${balances.weth}\`${wethUsd}\n`;
    }
    text += `🪙 ${sym}: \`${balances.token}\`${tokenUsd}\n`;
  }

  text += `📊 Status: ${status} | Trades: ${user.trade_count}\n`;
  text += `💵 Amount: $${user.min_amount_usd}–$${user.max_amount_usd}\n`;
  text += `⏱ Interval: ${user.min_interval_sec}s–${user.max_interval_sec}s`;
  return text;
}

function mainMenuKeyboard(user) {
  const running = activeBots.get(user.user_id)?.running;
  return Markup.inlineKeyboard([
    [
      running
        ? Markup.button.callback('⏹ Stop Bot', 'stop_bot')
        : Markup.button.callback('▶️ Start Bot', 'start_bot'),
    ],
    [Markup.button.callback('💸 Sell Tokens', 'sell_menu')],
    [
      Markup.button.callback('⚙️ Settings', 'settings'),
      Markup.button.callback('👛 Wallet', 'wallet_menu'),
    ],
    [Markup.button.callback('🔄 Refresh', 'refresh')],
  ]);
}

// ─── START / MENU ────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  ctx.session = ctx.session || {};
  const user = createUser(ctx.from.id);
  await ctx.reply(mainMenuText(user, null), {
    parse_mode: 'Markdown',
    ...mainMenuKeyboard(user),
  });
});

bot.command('menu', async (ctx) => {
  ctx.session = ctx.session || {};
  const user = createUser(ctx.from.id);
  await ctx.reply(mainMenuText(user, null), {
    parse_mode: 'Markdown',
    ...mainMenuKeyboard(user),
  });
});

// ─── REFRESH ─────────────────────────────────────────────────────────────────

bot.action('refresh', async (ctx) => {
  await ctx.answerCbQuery('Refreshing...');
  const user = getUser(ctx.from.id);
  let balances = null;
  if (user?.wallet_address) {
    try { balances = await trader.getBalances(user.wallet_address, user.token_address, user.token_decimals); } catch {}
  }
  await ctx.editMessageText(mainMenuText(user, balances), {
    parse_mode: 'Markdown',
    ...mainMenuKeyboard(user),
  });
});

// ─── START / STOP BOT ────────────────────────────────────────────────────────

bot.action('start_bot', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const user   = getUser(userId);

  if (!user.wallet_encrypted) return ctx.reply('⚠️ Import a wallet first — tap 👛 Wallet.');
  if (!user.token_address)    return ctx.reply('⚠️ Set a token address first — tap ⚙️ Settings.');
  if (activeBots.get(userId)?.running) return ctx.answerCbQuery('Already running!');

  startTradingLoop(userId);
  await ctx.reply('✅ Volume bot started! First trade in ~3 seconds.');
  await ctx.editMessageText(mainMenuText(getUser(userId), null), {
    parse_mode: 'Markdown',
    ...mainMenuKeyboard(getUser(userId)),
  });
});

bot.action('stop_bot', async (ctx) => {
  await ctx.answerCbQuery('Stopped.');
  stopTradingLoop(ctx.from.id);
  await ctx.reply('⏹ Bot stopped.');
  const user = getUser(ctx.from.id);
  await ctx.editMessageText(mainMenuText(user, null), {
    parse_mode: 'Markdown',
    ...mainMenuKeyboard(user),
  });
});

// ─── SELL MENU ───────────────────────────────────────────────────────────────

bot.action('sell_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const user = getUser(ctx.from.id);
  if (!user.wallet_address || !user.token_address) {
    return ctx.reply('⚠️ Please set up wallet and token first.');
  }

  let tokenBalance = '?';
  let sym = user.token_symbol || 'TOKEN';
  try {
    const b = await trader.getBalances(user.wallet_address, user.token_address, user.token_decimals);
    tokenBalance = b.token;
    sym = b.tokenSymbol;
  } catch {}

  await ctx.editMessageText(
    `*💸 Sell ${sym}*\n\nBalance: \`${tokenBalance} ${sym}\`\n\nSelect % to sell:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('25%',  'sell_25'),
          Markup.button.callback('50%',  'sell_50'),
          Markup.button.callback('75%',  'sell_75'),
          Markup.button.callback('100%', 'sell_100'),
        ],
        [Markup.button.callback('🔙 Back', 'back_main')],
      ]),
    }
  );
});

async function executeSell(ctx, percentage) {
  await ctx.answerCbQuery(`Selling ${percentage}%...`);
  const userId = ctx.from.id;
  // Pause auto-loop to avoid nonce collision
  stopTradingLoop(userId);
  const user = getUser(userId);
  try {
    await ctx.reply(`⏳ Selling ${percentage}% of tokens...`);
    const pk      = decrypt(user.wallet_encrypted);
    const poolKey = poolKeyFromUser(user);
    const receipt = await trader.sellToken(pk, user.token_address, percentage, null, user.token_decimals || 18, poolKey);
    await ctx.reply(`✅ Sold ${percentage}%!\n\nTx: \`${receipt.hash}\``, { parse_mode: 'Markdown' });
  } catch (err) {
    await ctx.reply(`❌ Sell failed: ${err.message}`);
  }
}

bot.action('sell_25',  (ctx) => executeSell(ctx, 25));
bot.action('sell_50',  (ctx) => executeSell(ctx, 50));
bot.action('sell_75',  (ctx) => executeSell(ctx, 75));
bot.action('sell_100', (ctx) => executeSell(ctx, 100));

// ─── SETTINGS ────────────────────────────────────────────────────────────────

bot.action('settings', async (ctx) => {
  await ctx.answerCbQuery();
  const user = getUser(ctx.from.id);
  await ctx.editMessageText(
    `*⚙️ Settings*\n\n` +
    `🪙 Token: \`${user.token_address ? shortAddress(user.token_address) : 'Not set'}\`\n` +
    `💵 Amount: $${user.min_amount_usd}–$${user.max_amount_usd} per trade\n` +
    `⏱ Interval: ${user.min_interval_sec}s–${user.max_interval_sec}s between trades`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🪙 Set Token Address', 'set_token')],
        [Markup.button.callback('💵 Set Amount Range',  'set_amount')],
        [Markup.button.callback('⏱ Set Interval Range', 'set_interval')],
        [Markup.button.callback('🔙 Back', 'back_main')],
      ]),
    }
  );
});

bot.action('set_token', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.waitingFor = 'token_address';
  await ctx.reply('🪙 *Send the token contract address:*\n\nExample: `0x9523f80310B693dECf5E81A785BfB726398e1Ba3`', { parse_mode: 'Markdown' });
});

bot.action('set_amount', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.waitingFor = 'amount_range';
  await ctx.reply('💵 *Send the amount range in USD:*\n\nFormat: `min max`\nExample: `0.10 0.50`', { parse_mode: 'Markdown' });
});

bot.action('set_interval', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.waitingFor = 'interval_range';
  await ctx.reply('⏱ *Send the interval range in seconds:*\n\nFormat: `min max`\nExample: `20 60`', { parse_mode: 'Markdown' });
});

// ─── WALLET ──────────────────────────────────────────────────────────────────

bot.action('wallet_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const user = getUser(ctx.from.id);
  let balanceLine = '';
  if (user.wallet_address) {
    try {
      const b = await trader.getBalances(user.wallet_address, user.token_address, user.token_decimals);
      balanceLine = `\n💰 ETH: \`${b.eth}\`\n🪙 Token: \`${b.token} ${b.tokenSymbol}\``;
    } catch {}
  }
  await ctx.editMessageText(
    `*👛 Wallet*\n\n📍 Address: \`${user.wallet_address || 'Not imported'}\`` + balanceLine,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📥 Import Wallet', 'import_wallet')],
        [Markup.button.callback('🔙 Back', 'back_main')],
      ]),
    }
  );
});

bot.action('import_wallet', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.waitingFor = 'private_key';
  await ctx.reply(
    '🔑 *Send your wallet private key:*\n\n' +
    '⚠️ Use a *dedicated bot wallet*, never your main wallet.\n' +
    '_Your message will be deleted automatically._',
    { parse_mode: 'Markdown' }
  );
});

bot.action('back_main', async (ctx) => {
  await ctx.answerCbQuery();
  const user = getUser(ctx.from.id);
  await ctx.editMessageText(mainMenuText(user, null), {
    parse_mode: 'Markdown',
    ...mainMenuKeyboard(user),
  });
});

// ─── TEXT INPUT HANDLER ──────────────────────────────────────────────────────

bot.on('text', async (ctx) => {
  ctx.session = ctx.session || {};
  const waitingFor = ctx.session.waitingFor;
  if (!waitingFor) return;

  const userId = ctx.from.id;
  const input  = ctx.message.text.trim();
  ctx.session.waitingFor = null;

  // Delete message for security (especially private keys)
  try { await ctx.deleteMessage(); } catch {}

  // ── Private key
  if (waitingFor === 'private_key') {
    try {
      const { address, privateKey } = importWallet(input);
      updateUser(userId, {
        wallet_encrypted: encrypt(privateKey),
        wallet_address: address,
      });
      await ctx.reply(
        `✅ *Wallet imported!*\n\n📍 \`${address}\`\n\n_Always use a dedicated wallet for bots._`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply(`❌ Invalid private key: ${err.message}`);
    }
  }

  // ── Token address
  else if (waitingFor === 'token_address') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(input)) {
      return ctx.reply('❌ Invalid address. Use /menu → Settings → Set Token to try again.');
    }
    await ctx.reply('🔍 Fetching token info + discovering V4 pool... (may take ~30s)');
    try {
      const info = await trader.getTokenInfo(input);
      updateUser(userId, {
        token_address:  input,
        token_symbol:   info.symbol,
        token_decimals: info.decimals,
      });

      // Discover pool key in background and store it
      trader.discoverPoolKey(input).then(poolKey => {
        if (poolKey) {
          updateUser(userId, {
            fee_tier:     poolKey.fee,
            tick_spacing: poolKey.tickSpacing,
            hook_address: poolKey.hooks,
          });
          bot.telegram.sendMessage(userId,
            `✅ *Pool found!*\n\n🪙 ${info.symbol}\n🏊 Fee: ${poolKey.fee} | Spacing: ${poolKey.tickSpacing}\n🪝 Hook: \`${shortAddress(poolKey.hooks)}\`\n\nBot is ready to trade!`,
            { parse_mode: 'Markdown' }
          ).catch(() => {});
        } else {
          bot.telegram.sendMessage(userId, '⚠️ Could not find V4 pool for this token. Make sure the token is traded on Uniswap V4 on Base.').catch(() => {});
        }
      }).catch(err => {
        bot.telegram.sendMessage(userId, `⚠️ Pool discovery error: ${err.message}`).catch(() => {});
      });

      await ctx.reply(
        `⏳ Token set: *${info.symbol}*\nDiscovering pool key in background...`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  }

  // ── Amount range
  else if (waitingFor === 'amount_range') {
    const [minStr, maxStr] = input.split(/\s+/);
    const min = parseFloat(minStr), max = parseFloat(maxStr);
    if (isNaN(min) || isNaN(max) || min <= 0 || max <= min) {
      return ctx.reply('❌ Invalid. Format: `0.10 0.50`\n(min must be less than max)', { parse_mode: 'Markdown' });
    }
    updateUser(userId, { min_amount_usd: min, max_amount_usd: max });
    await ctx.reply(`✅ Amount set: *$${min} – $${max}* per trade`, { parse_mode: 'Markdown' });
  }

  // ── Interval range
  else if (waitingFor === 'interval_range') {
    const [minStr, maxStr] = input.split(/\s+/);
    const min = parseInt(minStr), max = parseInt(maxStr);
    if (isNaN(min) || isNaN(max) || min < 5 || max <= min) {
      return ctx.reply('❌ Invalid. Format: `20 60`\n(minimum 5 seconds, max must be greater than min)', { parse_mode: 'Markdown' });
    }
    updateUser(userId, { min_interval_sec: min, max_interval_sec: max });
    await ctx.reply(`✅ Interval set: *${min}s – ${max}s* between trades`, { parse_mode: 'Markdown' });
  }
});

// ─── TRADING LOOP ────────────────────────────────────────────────────────────

function startTradingLoop(userId) {
  if (activeBots.get(userId)?.running) return;
  activeBots.set(userId, { running: true });

  async function doTrade() {
    if (!activeBots.get(userId)?.running) return;
    const user = getUser(userId);
    if (!user?.wallet_encrypted || !user?.token_address) return;

    try {
      const poolKey = poolKeyFromUser(user);
      if (!poolKey) {
        console.error(`[${userId}] Pool key not set — re-set token address to discover it`);
        bot.telegram.sendMessage(userId, '⚠️ Pool key missing. Go to ⚙️ Settings → Set Token Address and re-enter the token to rediscover the pool.').catch(() => {});
        stopTradingLoop(userId);
        return;
      }

      const ethPrice  = await getEthPrice();
      const usdAmount = randomBetween(user.min_amount_usd, user.max_amount_usd);
      const ethAmount = usdAmount / ethPrice;
      const pk        = decrypt(user.wallet_encrypted);
      const decimals  = user.token_decimals || 18;

      // 70% buy, 30% sell for realistic two-sided volume
      const isBuy = Math.random() > 0.3;

      if (isBuy) {
        const receipt = await trader.buyToken(pk, user.token_address, ethAmount, null, poolKey);
        const count = user.trade_count + 1;
        console.log(`[${userId}] ✅ BUY $${usdAmount.toFixed(2)} | tx: ${receipt.hash}`);
        updateUser(userId, { trade_count: count });
        bot.telegram.sendMessage(userId,
          `✅ *Trade #${count} complete!*\n\n` +
          `📈 BUY — $${usdAmount.toFixed(2)} worth of ${user.token_symbol || 'TOKEN'}\n` +
          `🔗 [View on BaseScan](https://basescan.org/tx/${receipt.hash})`,
          { parse_mode: 'Markdown', disable_web_page_preview: true }
        ).catch(() => {});
      } else {
        const sellPct = Math.floor(randomBetween(5, 15));
        const receipt = await trader.sellToken(pk, user.token_address, sellPct, null, decimals, poolKey);
        const count = user.trade_count + 1;
        console.log(`[${userId}] ✅ SELL ${sellPct}% | tx: ${receipt.hash}`);
        updateUser(userId, { trade_count: count });
        bot.telegram.sendMessage(userId,
          `✅ *Trade #${count} complete!*\n\n` +
          `📉 SELL — ${sellPct}% of ${user.token_symbol || 'TOKEN'}\n` +
          `🔗 [View on BaseScan](https://basescan.org/tx/${receipt.hash})`,
          { parse_mode: 'Markdown', disable_web_page_preview: true }
        ).catch(() => {});
      }

    } catch (err) {
      console.error(`[${userId}] ❌ Trade error: ${err.message}`);
      if (err.message.toLowerCase().includes('insufficient funds')) {
        bot.telegram.sendMessage(userId,
          '⚠️ *Bot stopped: Insufficient ETH balance.*\n\nPlease top up your wallet and restart.',
          { parse_mode: 'Markdown' }
        ).catch(() => {});
        stopTradingLoop(userId);
        return;
      }
    }

    if (activeBots.get(userId)?.running) {
      const delay = randomBetween(
        getUser(userId).min_interval_sec,
        getUser(userId).max_interval_sec
      ) * 1000;
      const timer = setTimeout(doTrade, delay);
      activeBots.set(userId, { running: true, timer });
    }
  }

  // First trade after 3s
  const timer = setTimeout(doTrade, 3000);
  activeBots.set(userId, { running: true, timer });
}

function stopTradingLoop(userId) {
  const state = activeBots.get(userId);
  if (state?.timer) clearTimeout(state.timer);
  activeBots.set(userId, { running: false });
}

// ─── LAUNCH ──────────────────────────────────────────────────────────────────

bot.launch({ dropPendingUpdates: true })
  .then(() => console.log('🤖 ChainSoul Volume Bot is running!'))
  .catch(err => { console.error('Launch error:', err.message); process.exit(1); });

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
