const fs   = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'users.json');

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return {}; }
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

const defaultUser = () => ({
  wallets:           [],     // [{ encrypted, address }]
  wallet_encrypted:  null,   // legacy single-wallet (migrated to wallets[])
  wallet_address:    null,
  token_address:     null,
  token_symbol:      'TOKEN',
  token_decimals:    18,
  fee_tier:          null,
  tick_spacing:      null,
  hook_address:      null,
  min_amount_usd:    0.10,
  max_amount_usd:    0.50,
  min_interval_sec:  20,
  max_interval_sec:  60,
  trade_count:       0,
  trade_history:     [],
  created_at:        Math.floor(Date.now() / 1000),
});

function getUser(userId) {
  const db = loadDB();
  return db[userId] ? { user_id: userId, ...db[userId] } : null;
}

function createUser(userId) {
  const db = loadDB();
  if (!db[userId]) {
    db[userId] = defaultUser();
    saveDB(db);
  }
  return { user_id: userId, ...db[userId] };
}

function updateUser(userId, data) {
  const db = loadDB();
  if (!db[userId]) db[userId] = defaultUser();
  db[userId] = { ...db[userId], ...data };
  saveDB(db);
}

function getWallets(userId) {
  const user = getUser(userId);
  if (!user) return [];
  if (user.wallets && user.wallets.length > 0) return user.wallets;
  if (user.wallet_encrypted) return [{ encrypted: user.wallet_encrypted, address: user.wallet_address }];
  return [];
}

module.exports = { getUser, createUser, updateUser, getWallets };
