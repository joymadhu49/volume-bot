const { ethers } = require('ethers');
const { getEthPrice } = require('./utils');

const RPC_URL  = process.env.RPC_URL || 'https://mainnet.base.org';
const provider = new ethers.JsonRpcProvider(RPC_URL);

// ─── Addresses (Base mainnet) ─────────────────────────────────────────────────
const WETH             = '0x4200000000000000000000000000000000000006';
const PERMIT2          = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const UNIVERSAL_ROUTER = '0x6ff5693b99212da76ad316178a184ab56d299b43';
const POOL_MANAGER     = '0x498581ff718922c3f8e6a244956af099b2652b2b';

// ─── V4 Action bytes ──────────────────────────────────────────────────────────
const ACT_SWAP_EXACT_IN_SINGLE = 0x06;
const ACT_SETTLE               = 0x0b; // settle exact amount (not SETTLE_ALL)
const ACT_TAKE_ALL             = 0x0f;

// Universal Router special address constant
const ADDRESS_THIS = '0x0000000000000000000000000000000000000002';

// ─── Nonce Manager (prevents concurrent tx collisions) ───────────────────────
const nonceQueues = new Map();

async function sendTx(wallet, txData) {
  const key = wallet.address.toLowerCase();
  const prev = nonceQueues.get(key) || Promise.resolve();
  const next = prev.then(async () => {
    const nonce = await provider.getTransactionCount(wallet.address, 'pending');
    const tx = await wallet.sendTransaction({ ...txData, nonce });
    return tx.wait();
  });
  nonceQueues.set(key, next.catch(() => {}));
  return next;
}

// ─── ABIs ─────────────────────────────────────────────────────────────────────
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
  'function symbol() external view returns (string)',
  'function allowance(address owner, address spender) external view returns (uint256)',
];

const PERMIT2_ABI = [
  'function approve(address token, address spender, uint160 amount, uint48 expiration) external',
  'function allowance(address owner, address token, address spender) external view returns (uint160 amount, uint48 expiration, uint48 nonce)',
];

const ROUTER_ABI = [
  'function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable',
];

// ─── Pool Key Discovery (called once when token is set) ──────────────────────

async function probeCommonPools(tokenAddress) {
  const [c0, c1] = tokenAddress.toLowerCase() < WETH.toLowerCase()
    ? [tokenAddress, WETH]
    : [WETH, tokenAddress];

  const pm = new ethers.Contract(POOL_MANAGER, [
    'function getSlot0(bytes32) external view returns (uint160, int24, uint24, uint24)',
  ], provider);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const hooks = ethers.ZeroAddress;

  const CONFIGS = [
    { fee: 500, tickSpacing: 10 },
    { fee: 3000, tickSpacing: 60 },
    { fee: 10000, tickSpacing: 200 },
    { fee: 100, tickSpacing: 1 },
  ];

  for (const { fee, tickSpacing } of CONFIGS) {
    const poolId = ethers.keccak256(
      coder.encode(
        ['address', 'address', 'uint24', 'int24', 'address'],
        [c0, c1, fee, tickSpacing, hooks]
      )
    );
    try {
      const [sqrtPriceX96] = await pm.getSlot0(poolId);
      if (sqrtPriceX96 > 0n) {
        return { currency0: c0, currency1: c1, fee, tickSpacing, hooks };
      }
    } catch {
      break; // getSlot0 not available on this deployment, skip probing
    }
  }
  return null;
}

async function discoverPoolKey(tokenAddress) {
  // Fast path: probe common pool configurations via PoolManager.getSlot0
  try {
    const probed = await probeCommonPools(tokenAddress);
    if (probed) return probed;
  } catch {}

  // Slow path: scan Initialize events with precise topic filters
  const sig = ethers.id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
  const block = await provider.getBlockNumber();

  const [c0, c1] = tokenAddress.toLowerCase() < WETH.toLowerCase()
    ? [tokenAddress, WETH]
    : [WETH, tokenAddress];

  // Filter by indexed currency0 + currency1 for efficiency
  const topic2 = ethers.zeroPadValue(c0, 32);
  const topic3 = ethers.zeroPadValue(c1, 32);

  const iface = new ethers.Interface([
    'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
  ]);

  // Search 5M blocks (~115 days on Base) in 10k-block chunks
  for (let from = block; from >= block - 5000000; from -= 10000) {
    const fromBlock = Math.max(from - 9999, 0);
    try {
      const logs = await provider.getLogs({
        address:   POOL_MANAGER,
        topics:    [sig, null, topic2, topic3],
        fromBlock,
        toBlock:   from,
      });
      for (const log of logs) {
        try {
          const e = iface.parseLog(log);
          return {
            currency0:   e.args.currency0,
            currency1:   e.args.currency1,
            fee:         Number(e.args.fee),
            tickSpacing: Number(e.args.tickSpacing),
            hooks:       e.args.hooks,
          };
        } catch {}
      }
    } catch {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  return null;
}

// ─── Encode V4 Actions ────────────────────────────────────────────────────────

function encodeV4Swap({ poolKey, zeroForOne, amountIn }) {
  const abi = ethers.AbiCoder.defaultAbiCoder();

  const actions = ethers.concat([
    new Uint8Array([ACT_SWAP_EXACT_IN_SINGLE]),
    new Uint8Array([ACT_SETTLE]),
    new Uint8Array([ACT_TAKE_ALL]),
  ]);

  const swapParam = abi.encode(
    ['((address,address,uint24,int24,address),bool,uint128,uint128,bytes)'],
    [[
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
      zeroForOne,
      amountIn,
      0n,   // amountOutMinimum
      '0x', // hookData
    ]]
  );

  const settleCurrency = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const takeCurrency   = zeroForOne ? poolKey.currency1 : poolKey.currency0;

  // SETTLE(currency, amount, payerIsUser=false) — router pays from its own WETH (after WRAP_ETH)
  const settleParam = abi.encode(['address', 'uint256', 'bool'], [settleCurrency, amountIn, false]);
  // TAKE_ALL(currency, minAmount)
  const takeParam   = abi.encode(['address', 'uint256'], [takeCurrency, 0n]);

  // V4_SWAP input = abi.encode(actions, params[])
  return abi.encode(['bytes', 'bytes[]'], [actions, [swapParam, settleParam, takeParam]]);
}

// ─── Token Info ──────────────────────────────────────────────────────────────

async function getTokenInfo(tokenAddress) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  try {
    const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
    return { symbol, decimals: Number(decimals) };
  } catch {
    return { symbol: 'TOKEN', decimals: 18 };
  }
}

// getFeeTier is only used to trigger discovery; actual values stored in user DB
async function getFeeTier(tokenAddress) {
  return null;
}

// ─── Buy: ETH → Token via V4 Universal Router ────────────────────────────────
// poolKey is passed in directly from user settings (no chain lookup at trade time)

async function buyToken(privateKey, tokenAddress, amountEth, _feeTier, poolKey) {
  if (!poolKey) throw new Error('Pool key not configured. Re-set the token address first.');

  const wallet   = new ethers.Wallet(privateKey, provider);
  const router   = new ethers.Contract(UNIVERSAL_ROUTER, ROUTER_ABI, wallet);
  const amountIn = ethers.parseEther(amountEth.toFixed(8));

  // Buying TOKEN: paying WETH (currency1) → receiving TOKEN (currency0)
  // i.e. swapping currency1 → currency0 = zeroForOne: false
  const payingWETH = poolKey.currency1.toLowerCase() === WETH.toLowerCase();
  const zeroForOne = !payingWETH; // false when currency1 = WETH

  // WRAP_ETH (0x0b) + V4_SWAP (0x10)
  const commands = '0x0b10';

  const wrapInput = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint256'],
    [ADDRESS_THIS, amountIn] // ADDRESS_THIS keeps WETH in router for V4 settle
  );
  const v4Input   = encodeV4Swap({ poolKey, zeroForOne, amountIn });

  const deadline = Math.floor(Date.now() / 1000) + 300;
  return sendTx(wallet, {
    to:       UNIVERSAL_ROUTER,
    data:     new ethers.Interface(ROUTER_ABI).encodeFunctionData('execute', [commands, [wrapInput, v4Input], deadline]),
    value:    amountIn,
    gasLimit: 700000n,
  });
}

// ─── Sell: Token → ETH via V4 Universal Router ───────────────────────────────

async function sellToken(privateKey, tokenAddress, percentage, _feeTier, decimals = 18, poolKey) {
  if (!poolKey) throw new Error('Pool key not configured. Re-set the token address first.');

  const wallet  = new ethers.Wallet(privateKey, provider);
  const token   = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
  const permit2 = new ethers.Contract(PERMIT2, PERMIT2_ABI, wallet);
  const router  = new ethers.Contract(UNIVERSAL_ROUTER, ROUTER_ABI, wallet);

  const balance = await token.balanceOf(wallet.address);
  if (balance === 0n) throw new Error('No tokens to sell');
  const amountIn = (balance * BigInt(percentage)) / 100n;

  // Selling TOKEN → WETH: currency0 → currency1 = zeroForOne: true
  const zeroForOne = poolKey.currency0.toLowerCase() === tokenAddress.toLowerCase();

  const MAX_UINT160 = BigInt('0xffffffffffffffffffffffffffffffffffffffff');
  const MAX_UINT48  = BigInt('0xffffffffffff');

  // Ensure ERC20 → Permit2 approval
  const erc20Allow = await token.allowance(wallet.address, PERMIT2);
  if (erc20Allow < amountIn) {
    await sendTx(wallet, {
      to:       tokenAddress,
      data:     token.interface.encodeFunctionData('approve', [PERMIT2, ethers.MaxUint256]),
      gasLimit: 100000n,
    });
    // ERC20 → Permit2 approved
  }

  // Ensure Permit2 → Universal Router approval (uint160 max, not uint256!)
  let needsP2Approve = true;
  try {
    const [p2Amount] = await permit2.allowance(wallet.address, tokenAddress, UNIVERSAL_ROUTER);
    needsP2Approve = p2Amount < amountIn;
  } catch {}

  if (needsP2Approve) {
    const expiry = Math.floor(Date.now() / 1000) + 86400 * 30;
    await sendTx(wallet, {
      to:       PERMIT2,
      data:     permit2.interface.encodeFunctionData('approve', [tokenAddress, UNIVERSAL_ROUTER, MAX_UINT160, expiry]),
      gasLimit: 100000n,
    });
    // Permit2 → Router approved
  }

  // PERMIT2_TRANSFER_FROM (0x02) + V4_SWAP (0x10) + UNWRAP_WETH (0x0c)
  const commands = '0x02100c';

  const transferInput = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint160'],
    [tokenAddress, UNIVERSAL_ROUTER, amountIn]
  );
  const v4Input = encodeV4Swap({ poolKey, zeroForOne, amountIn });
  const unwrapInput = ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint256'],
    [wallet.address, 0n]
  );

  const deadline = Math.floor(Date.now() / 1000) + 300;
  const receipt = await sendTx(wallet, {
    to:       UNIVERSAL_ROUTER,
    data:     new ethers.Interface(ROUTER_ABI).encodeFunctionData('execute', [commands, [transferInput, v4Input, unwrapInput], deadline]),
    gasLimit: 700000n,
  });

  // Auto-unwrap any remaining WETH to ETH
  await unwrapWETH(wallet);
  return receipt;
}

// ─── Balances ────────────────────────────────────────────────────────────────

// ─── Auto-unwrap WETH → ETH ──────────────────────────────────────────────────

const WETH_ABI_EXTRA = [
  'function withdraw(uint256 amount) external',
  'function balanceOf(address) view returns (uint256)',
];

async function unwrapWETH(wallet) {
  try {
    const weth = new ethers.Contract(WETH, WETH_ABI_EXTRA, wallet);
    const bal = await weth.balanceOf(wallet.address);
    if (bal > 0n) {
      await sendTx(wallet, {
        to:       WETH,
        data:     weth.interface.encodeFunctionData('withdraw', [bal]),
        gasLimit: 60000n,
      });
    }
  } catch {
    // WETH unwrap failed silently — non-critical
  }
}

async function getTokenPriceUsd(tokenAddress) {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
      { signal: AbortSignal.timeout(5000) }
    );
    const data = await res.json();
    const pair = data?.pairs?.[0];
    return pair?.priceUsd ? parseFloat(pair.priceUsd) : null;
  } catch {
    return null;
  }
}

async function getBalances(walletAddress, tokenAddress, decimals = 18) {
  const wethContract = new ethers.Contract(WETH, WETH_ABI_EXTRA, provider);
  const [ethBalance, wethBalance] = await Promise.all([
    provider.getBalance(walletAddress),
    wethContract.balanceOf(walletAddress).catch(() => 0n),
  ]);

  let tokenBalance = 0n;
  let tokenSymbol  = 'TOKEN';
  if (tokenAddress) {
    try {
      const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
      [tokenBalance, tokenSymbol] = await Promise.all([
        token.balanceOf(walletAddress),
        token.symbol(),
      ]);
    } catch {}
  }

  const [ethPrice, tokenPrice] = await Promise.all([
    getEthPrice().catch(() => null),
    tokenAddress ? getTokenPriceUsd(tokenAddress).catch(() => null) : null,
  ]);

  const ethFloat   = parseFloat(ethers.formatEther(ethBalance));
  const wethFloat  = parseFloat(ethers.formatEther(wethBalance));
  const tokenFloat = tokenBalance > 0n ? parseFloat(ethers.formatUnits(tokenBalance, decimals)) : 0;

  return {
    eth:        ethFloat.toFixed(4),
    weth:       wethFloat > 0 ? wethFloat.toFixed(6) : null,
    token:      tokenFloat > 0 ? tokenFloat.toLocaleString() : '0',
    tokenSymbol,
    ethUsd:     ethPrice ? (ethFloat * ethPrice).toFixed(2) : null,
    wethUsd:    (ethPrice && wethFloat > 0) ? (wethFloat * ethPrice).toFixed(2) : null,
    tokenUsd:   tokenPrice ? (tokenFloat * tokenPrice).toFixed(4) : null,
  };
}


module.exports = { buyToken, sellToken, getBalances, getTokenInfo, getFeeTier, discoverPoolKey, unwrapWETH };
