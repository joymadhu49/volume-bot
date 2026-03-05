const crypto = require('crypto');
const { ethers } = require('ethers');

function getKey() {
  return crypto.createHash('sha256')
    .update(process.env.ENCRYPTION_KEY || 'chainsoul-default-key')
    .digest();
}

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', getKey(), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedText) {
  const [ivHex, encrypted] = encryptedText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', getKey(), iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function importWallet(privateKey) {
  const key = privateKey.trim().startsWith('0x')
    ? privateKey.trim()
    : '0x' + privateKey.trim();
  const wallet = new ethers.Wallet(key);
  return { address: wallet.address, privateKey: wallet.privateKey };
}

async function getEthPrice() {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
      { signal: AbortSignal.timeout(5000) }
    );
    const data = await res.json();
    return data.ethereum.usd;
  } catch {
    return 3000; // fallback
  }
}

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

function shortAddress(address) {
  return address ? `${address.slice(0, 6)}...${address.slice(-4)}` : 'Not set';
}

module.exports = { encrypt, decrypt, importWallet, getEthPrice, randomBetween, shortAddress };
