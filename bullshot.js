const { Wallet } = require('ethers');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ─── CONFIG (.env) ────────────────────────────────────────────────────────────
function loadEnv(file = path.join(__dirname, '.env')) {
  if (!fs.existsSync(file)) {
    console.error(`[!] ${file} not found. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    let val = m[2];
    if (/^(['"]).*\1$/.test(val)) val = val.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
}

const list = v => (v || '').split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
const num = (v, def) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : def);

// "[600,700]" → [600, 700]; a single number "500" → [500, 500]
function range(v, def) {
  const nums = (v || '').replace(/[\[\]\s]/g, '').split(/[,;]/).filter(Boolean).map(Number);
  if (!nums.length || nums.some(n => !Number.isFinite(n) || n < 0)) return def;
  const [a, b = a] = nums;
  return [Math.min(a, b), Math.max(a, b)];
}

loadEnv();

const CFG = {
  baseUrl:     process.env.BASE_URL || 'https://gemapi.bullshot.io',
  refCode:     process.env.REF_CODE || '',
  keys:        list(process.env.PRIVATE_KEYS).map(k => (k.startsWith('0x') ? k : `0x${k}`)),
  usernames:   list(process.env.TWITTER_USERNAMES).map(u => u.replace(/^@/, '')),
  delay:       range(process.env.DELAY_MS, [3000, 8000]),
  acctDelay:   range(process.env.ACCOUNT_DELAY_MS, [2000, 6000]),
  minDuration: num(process.env.MIN_LOCATION_SECONDS, 600),
  locations:   list(process.env.MINING_LOCATIONS), // location id priority; empty = auto (max GEMS)
  timeout:     num(process.env.REQUEST_TIMEOUT_MS, 60000),
  retries:     num(process.env.REQUEST_RETRIES, 2),
  // Auto mode (seconds)
  autoExtra:   range(process.env.AUTO_EXTRA_WAIT_SEC, [30, 180]),
  autoIdle:    range(process.env.AUTO_IDLE_WAIT_SEC, [1800, 3600]),
  autoMinWait: num(process.env.AUTO_MIN_WAIT_SEC, 60),
  autoMaxWait: num(process.env.AUTO_MAX_WAIT_SEC, 3600),
  autoCycles:  num(process.env.AUTO_CYCLES, 0), // 0 = infinite
  gemsReserve: num(process.env.AUTO_GEMS_RESERVE, 500), // mode 8: GEMS never spent
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * Math.max(0, max - min);
const randomDelay = () => sleep(rand(...CFG.delay));
const accountDelay = () => sleep(rand(...CFG.acctDelay));

// ─── BULLSHOT API ─────────────────────────────────────────────────────────────
function getHeaders(address, token) {
  return {
    'Content-Type': 'application/json',
    'Origin': 'https://gem.bullshot.io',
    'Referer': 'https://gem.bullshot.io/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    ...(address ? { 'X-Wallet-Address': address } : {}),
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
  };
}

async function api(method, urlPath, body, address, token) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), CFG.timeout);
    try {
      const res = await fetch(`${CFG.baseUrl}${urlPath}`, {
        method,
        headers: getHeaders(address, token),
        signal: ctrl.signal,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = null; }

      // 429 / 5xx — retry
      if ((res.status === 429 || res.status >= 500) && attempt < CFG.retries) {
        await sleep(3000 * (attempt + 1));
        continue;
      }
      if (data === null) throw new Error(`HTTP ${res.status}, non-JSON: ${text.slice(0, 100)}`);
      if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
      return data;
    } catch (e) {
      const retriable = e.name === 'AbortError' || e.cause?.code;
      if (retriable && attempt < CFG.retries) {
        await sleep(3000 * (attempt + 1));
        continue;
      }
      if (e.name === 'AbortError') throw new Error(`Timeout ${method} ${urlPath}`);
      throw e;
    } finally {
      clearTimeout(to);
    }
  }
}

const asArray = v => {
  if (Array.isArray(v)) return v;
  if (!v || typeof v !== 'object') return [];
  for (const k of ['data', 'positions', 'items', 'results', 'locations']) {
    if (Array.isArray(v[k])) return v[k];
    if (v[k] && typeof v[k] === 'object') {
      const inner = asArray(v[k]);
      if (inner.length) return inner;
    }
  }
  return Object.values(v).find(Array.isArray) || [];
};

// ─── LOGIN ────────────────────────────────────────────────────────────────────
async function login(privateKey) {
  const wallet = new Wallet(privateKey);
  const address = wallet.address;

  const ban = await api('GET', `/api/user/check-ban/${address}`, null, address);
  if (ban.banned || ban.isBanned) throw new Error('wallet is banned');

  const { message } = await api('POST', '/api/auth/nonce', { walletAddress: address }, address);
  const signature = await wallet.signMessage(message);
  const { token, user } = await api('POST', '/api/auth/login', {
    walletAddress: address, message, signature,
    ...(CFG.refCode ? { refCode: CFG.refCode } : {}),
  }, address);

  if (!token) throw new Error('server returned no token');
  return { address, token, user: user || {} };
}

// ─── MINING ───────────────────────────────────────────────────────────────────
// The server's isLocked flag does not reflect the account (Crystal Cavern is locked:true
// at level 7 / power 50), so we check the real requirements: levelRequired and miningPowerRequired.
// Locations the server still rejects are remembered and not tried again.
const rejectedLocs = new Map(); // address → Set(locationId)

function bestLocation(locations, level, miningPower, address) {
  const rejected = rejectedLocs.get(address) || new Set();
  const ok = locations.filter(l => l.name && l.durationSeconds >= CFG.minDuration
    && !rejected.has(l.id)
    && (l.miningPowerRequired || 0) <= miningPower
    && (level === undefined || (l.levelRequired || 0) <= level));

  if (CFG.locations.length) {
    // Priority from .env: the first one the account qualifies for
    return CFG.locations.map(id => ok.find(l => l.id === id)).find(Boolean) || null;
  }
  return ok.sort((a, b) =>
    (b.rewardRanges?.GEMS?.max || 0) - (a.rewardRanges?.GEMS?.max || 0)
    || b.durationSeconds - a.durationSeconds)[0] || null;
}

function soonest(positions) {
  return [...positions].sort((a, b) => a.remainingSeconds - b.remainingSeconds)[0];
}

async function doMining(s, tag) {
  const { address, token } = s;

  const active = asArray(await api('GET', '/api/mining/positions', null, address, token))
    .filter(p => p.status === 'active');
  if (active.length) {
    console.log(`${tag} Active positions: ${active.length} | next done in ${soonest(active).remainingSeconds}s`);
  }

  const [locRaw, stats] = await Promise.all([
    api('GET', '/api/mining/locations', null, address, token),
    api('GET', '/api/mining/stats', null, address, token),
  ]);
  const locations = asArray(locRaw);

  let energy = stats.energy ?? 0;
  let started = 0;
  const level = stats.level ?? s.user.level;

  for (;;) {
    // Take the best available location; if there is not enough energy for it, wait
    // instead of spending energy on a cheaper one (Crystal: 45 GEMS / 20 energy beats Greenstone: 15 / 10)
    const loc = bestLocation(locations, level, stats.miningPower ?? 0, address);
    if (!loc) {
      if (!started) console.log(`${tag} No suitable location (level: ${level ?? '?'}, power: ${stats.miningPower ?? '?'})`);
      break;
    }
    if (loc.energyCost > energy) {
      if (!started) console.log(`${tag} ${loc.name}: needs ${loc.energyCost} energy, have ${energy} — waiting`);
      break;
    }
    try {
      await api('POST', '/api/mining/positions', { locationId: loc.id }, address, token);
      started++;
      energy -= loc.energyCost;
      console.log(`${tag} [⛏ ${started}] ${loc.name} | ${loc.durationSeconds}s | energy left: ${energy}`);
      await randomDelay();
    } catch (e) {
      if (/lock|level|power|require/i.test(e.message)) {
        // The server won't allow this location — remember it and try the next one
        if (!rejectedLocs.has(address)) rejectedLocs.set(address, new Set());
        rejectedLocs.get(address).add(loc.id);
        console.log(`${tag} ${loc.name} unavailable: ${e.message} — trying next`);
        continue;
      }
      console.log(`${tag} Mining stopped: ${e.message}`);
      break;
    }
  }

  if (started) console.log(`${tag} Positions started: ${started}`);
}

// ─── CLAIM MINING ─────────────────────────────────────────────────────────────
async function doClaim(s, tag) {
  const { address, token } = s;
  const positions = asArray(await api('GET', '/api/mining/positions', null, address, token));
  const DONE = ['completed', 'complete', 'ready', 'finished', 'done', 'claimable'];
  const GONE = ['claimed', 'expired', 'cancelled', 'canceled'];
  const status = p => String(p.status || '').toLowerCase();
  const timeUp = p => {
    if (typeof p.remainingSeconds === 'number') return p.remainingSeconds <= 0;
    const end = p.endsAt || p.endTime || p.completesAt || p.completedAt || p.endAt;
    return end ? new Date(end).getTime() <= Date.now() : false;
  };
  // Never claim a position that still has time left, whatever its status or flags say
  const claimable = positions.filter(p => !p.claimed && !GONE.includes(status(p))
    && !(typeof p.remainingSeconds === 'number' && p.remainingSeconds > 0)
    && (p.isReady || p.canClaim || p.claimable || DONE.includes(status(p)) || timeUp(p)));

  if (!claimable.length) {
    const active = positions.filter(p => status(p) === 'active');
    if (active.length) {
      const p = soonest(active);
      console.log(`${tag} Still mining: ${p.locationName} | ${p.remainingSeconds}s left`);
    } else {
      const counts = {};
      positions.forEach(p => { counts[status(p) || '?'] = (counts[status(p) || '?'] || 0) + 1; });
      console.log(`${tag} Nothing to claim (positions: ${positions.length}${positions.length ? ', ' + JSON.stringify(counts) : ''})`);
    }
    return 0;
  }

  let total = 0;
  for (const pos of claimable) {
    try {
      const res = await api('POST', `/api/mining/positions/${pos.id}/claim`, null, address, token);
      const gems = res.gemsEarned || 0;
      total += gems;
      const extra = Array.isArray(res.rewards) && res.rewards.length ? ` | ${res.rewards.join(', ')}` : '';
      console.log(`${tag} Claimed: ${pos.locationName} | +${gems} GEMS${extra}`);
    } catch (e) {
      console.log(`${tag} Claim failed: ${e.message}`);
    }
    await sleep(500 + Math.random() * 1000);
  }
  return total;
}

// ─── TASKS ────────────────────────────────────────────────────────────────────
const QUESTS = {
  daily:  ['daily_miner_signin', 'tw_daily_engage'],
  weekly: ['tw_weekly_post', 'tw_weekly_qrt', 'weekly_miner_checkin'],
};
const OPEN_STATUSES = ['available', 'in_progress', 'started', 'ready', 'pending'];

async function doTasks(s, tag, questMode) {
  const { address, token, user, username } = s;

  if (username && !user.twitterHandle) {
    try {
      const r = await api('POST', '/api/user/link-twitter', { twitterHandle: username }, address, token);
      console.log(`${tag} [Twitter] Linked: @${r.twitterHandle || username}`);
    } catch (e) {
      console.log(`${tag} [Twitter] Link failed: ${e.message}`);
    }
    await randomDelay();
  }

  let raw;
  try {
    raw = await api('GET', '/api/quests', null, address, token);
  } catch (e) {
    console.log(`${tag} [Quest] Failed to fetch list: ${e.message}`);
    return false;
  }

  const allowed = QUESTS[questMode];
  const pool = asArray(raw[questMode]).filter(q => allowed.includes(q.id));
  const doable = pool.filter(q => OPEN_STATUSES.includes(q.status));

  if (!doable.length) {
    console.log(`${tag} [Quest] All ${questMode} quests done`);
    pool.forEach(q => console.log(`${tag}   └ ${q.id}: ${q.status}`));
    return true;
  }

  for (const quest of doable) {
    // Tweet-verification quests need a real tweet URL — skip them, never send fake URLs
    if (quest.actionType === 'verify_tweet') {
      console.log(`${tag} [Quest] Skipping "${quest.title}" — needs a real tweet, do it manually`);
      continue;
    }
    try {
      if (quest.status === 'available') {
        const st = await api('POST', '/api/quests/start', { questId: quest.id }, address, token);
        const wait = (st.delaySeconds || st.secondsLeft || 10) + 2;
        console.log(`${tag} [Quest] Started: ${quest.title} | waiting ${wait}s`);
        await sleep(wait * 1000);
      } else {
        console.log(`${tag} [Quest] Resuming: ${quest.title} (${quest.status})`);
      }

      const c = await api('POST', '/api/quests/claim', { questId: quest.id }, address, token);
      console.log(`${tag} [Quest] Claimed: ${quest.title} | +${c.reward?.gems || 0} GEMS +${c.reward?.xp || 0} XP`);
    } catch (e) {
      console.log(`${tag} [Quest] "${quest.title}" error: ${e.message}`);
    }
    await randomDelay();
  }
  return true;
}

// ─── UPGRADES ─────────────────────────────────────────────────────────────────
// POST /api/upgrades/{id} with no body = one purchase (+increment). Can be repeated with the same id.
// Prices differ per account — take them from that account's GET /api/upgrades.
const UPGRADE_TYPES = [
  { type: 'miningPower',    name: 'Mining Power' },
  { type: 'energyCapacity', name: 'Energy Capacity' },
  { type: 'miningSpeed',    name: 'Mining Speed' },
];

function statsLine(u = {}) {
  return [
    u.miningPower !== undefined && `power: ${u.miningPower}`,
    u.energyCapacity !== undefined && `energyCap: ${u.energyCapacity}`,
    u.miningSpeed !== undefined && `speed: ${u.miningSpeed}`,
    u.energy !== undefined && `energy: ${u.energy}`,
    u.gems !== undefined && `gems: ${u.gems}`,
  ].filter(Boolean).join(' | ');
}

// reserve — GEMS to keep (buy only if at least `reserve` remains afterwards)
async function doUpgrades(s, tag, types, count, reserve = 0) {
  const { address, token } = s;
  const results = [];
  let gems = s.user.gems;

  let upgrades;
  try {
    const raw = await api('GET', '/api/upgrades', null, address, token);
    upgrades = asArray(raw).length ? asArray(raw) : asArray(raw.upgrades || raw.items);
  } catch (e) {
    console.log(`${tag} [Upgrade] Failed to fetch list: ${e.message}`);
    return [{ name: '—', ok: 0, fail: 1, detail: e.message }];
  }

  for (const t of types) {
    const upg = upgrades.find(u => u.type === t);
    if (!upg) {
      console.log(`${tag} [Upgrade] ${t}: not in this account's list (still locked?) — skipping`);
      results.push({ name: t, ok: 0, fail: 0, detail: 'not in list' });
      continue;
    }
    const r = { name: upg.name || upg.id, ok: 0, fail: 0, detail: '' };
    console.log(`${tag} [Upgrade] ${r.name} | +${upg.increment ?? '?'} | price: ${upg.cost ?? '?'} GEMS${gems !== undefined ? ` | balance: ${gems}` : ''}`);

    for (let n = 1; n <= count; n++) {
      if (gems !== undefined && upg.cost !== undefined && gems - upg.cost < reserve) {
        r.detail = `not enough GEMS (${gems}, price ${upg.cost}${reserve ? `, reserve ${reserve}` : ''})`;
        console.log(`${tag} [Upgrade] Stop: ${r.detail}`);
        break;
      }
      try {
        const res = await api('POST', `/api/upgrades/${upg.id}`, null, address, token);
        r.ok++;
        if (res.user?.gems !== undefined) gems = res.user.gems;
        else if (gems !== undefined && upg.cost !== undefined) gems -= upg.cost;
        console.log(`${tag} [Upgrade] Bought ${n}/${count}: ${r.name} | ${statsLine(res.user) || res.message || 'ok'}`);
      } catch (e) {
        r.fail++;
        r.detail = e.message;
        console.log(`${tag} [Upgrade] Failed ${n}/${count}: ${r.name} | ${e.message} — not repeating`);
        break;
      }
      if (n < count) await randomDelay();
    }
    results.push(r);
    await randomDelay();
  }
  s.user.gems = gems;
  return results;
}

// ─── SHOP ─────────────────────────────────────────────────────────────────────
// POST /api/shop/purchase { itemId }. Items and prices may change — the server decides.
// Equipment you already own can't be bought again; Energy Pack is a consumable.
const SHOP_ITEMS = [
  { id: 'rusty-pickaxe',      name: 'Rusty Pickaxe',      effect: '+0 power',  price: 10 },
  { id: 'iron-pickaxe',       name: 'Iron Pickaxe',       effect: '+2 power',  price: 100 },
  { id: 'energy-pack',        name: 'Energy Pack',        effect: '+5 energy, consumable', price: 150 },
  { id: 'iron-drill',         name: 'Iron Drill',         effect: '+6 power',  price: 350 },
  { id: 'copper-turbo-drill', name: 'Copper Turbo Drill', effect: '+15 power', price: 1000 },
  { id: 'ruby-laser',         name: 'Ruby Laser',         effect: '+35 power', price: 3500 },
  { id: 'cryo-plasma-drill',  name: 'Cryo Plasma Drill',  effect: '+80 power', price: 10000 },
  { id: 'void-annihilator',   name: 'Void Annihilator',   effect: '+200 power', price: 35000 },
];

async function doShop(s, tag, item, reserve = 0) {
  const { address, token, user } = s;
  if (user.gems !== undefined && user.gems - item.price < reserve) {
    console.log(`${tag} [Shop] Skipping: ${user.gems} GEMS, price ${item.price}${reserve ? `, reserve ${reserve}` : ''} (${item.name})`);
    return { name: item.name, ok: 0, fail: 1, detail: `not enough GEMS (${user.gems})` };
  }
  try {
    const res = await api('POST', '/api/shop/purchase', { itemId: item.id }, address, token);
    if (res.user?.gems !== undefined) user.gems = res.user.gems;
    else if (user.gems !== undefined) user.gems -= item.price;
    console.log(`${tag} [Shop] Bought: ${res.item?.name || item.name} | ${statsLine(res.user) || res.message || 'ok'}`);
    return { name: item.name, ok: 1, fail: 0, detail: '' };
  } catch (e) {
    const owned = /owned|already/i.test(e.message);
    const locked = owned || /lock|level/i.test(e.message);
    console.log(`${tag} [Shop] ${locked ? 'Unavailable' : 'Error'}: ${item.name} | ${e.message}`);
    return { name: item.name, ok: 0, fail: 1, owned, detail: e.message };
  }
}

// ─── AUTO 24/7 ────────────────────────────────────────────────────────────────
const time = () => new Date().toLocaleTimeString('en-GB');
const dayKey = () => new Date().toISOString().slice(0, 10); // UTC date
function weekKey() {
  const d = new Date();
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
  return monday.toISOString().slice(0, 10);
}
const fmtWait = sec => (sec >= 3600 ? `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`
  : sec >= 60 ? `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s` : `${Math.round(sec)}s`);

// Seconds until the nearest position finishes (null = no active positions)
async function nextReadySeconds(s) {
  const active = asArray(await api('GET', '/api/mining/positions', null, s.address, s.token))
    .filter(p => p.status === 'active');
  return active.length ? Math.max(0, soonest(active).remainingSeconds) : null;
}

// buy (optional): { upgTypes, upgCount, shopItem, reserve } — purchases every cycle
async function autoLoop(indexes, buy = null) {
  const done = {}; // idx → { daily, weekly, shop } — what's already done
  let totalGems = 0;

  for (let cycle = 1; !CFG.autoCycles || cycle <= CFG.autoCycles; cycle++) {
    console.log(`\n══════ Cycle ${cycle} | ${time()} ══════`);
    let waitSec = CFG.autoMaxWait;

    for (let i = 0; i < indexes.length; i++) {
      const idx = indexes[i];
      const prefix = `[${i + 1}/${indexes.length}]`;
      const st = (done[idx] ||= {});

      let s;
      try {
        s = await login(CFG.keys[idx]); // fresh login every cycle so the token never expires
        s.username = CFG.usernames[idx] || null;
      } catch (e) {
        console.error(`${prefix} ${time()} Login error (account #${idx + 1}): ${e.message}`);
        waitSec = Math.min(waitSec, rand(...CFG.autoIdle) / 3);
        continue;
      }

      const tag = `${prefix}[${s.address.slice(0, 8)}…]`;
      console.log(`${tag} ${time()} Energy: ${s.user.energy ?? '?'}/${s.user.energyCapacity ?? '?'}`);
      try {
        const claimed = await doClaim(s, tag);
        totalGems += claimed;
        if (s.user.gems !== undefined) s.user.gems += claimed;
        await randomDelay();

        // Buy before mining so new energy / power is used right away
        if (buy?.upgTypes) {
          await doUpgrades(s, tag, buy.upgTypes, buy.upgCount, buy.reserve);
        }
        if (buy?.shopItem && !st.shop) {
          const r = await doShop(s, tag, buy.shopItem, buy.reserve);
          // Equipment is bought once; Energy Pack is a consumable, bought every cycle
          if (buy.shopItem.id !== 'energy-pack' && (r.ok || r.owned)) st.shop = true;
          await randomDelay();
        }

        await doMining(s, tag);

        if (st.daily !== dayKey()) {
          await randomDelay();
          if (await doTasks(s, tag, 'daily')) st.daily = dayKey();
        }
        if (st.weekly !== weekKey()) {
          await randomDelay();
          if (await doTasks(s, tag, 'weekly')) st.weekly = weekKey();
        }

        const ready = await nextReadySeconds(s);
        waitSec = Math.min(waitSec, ready ?? rand(...CFG.autoIdle));
      } catch (e) {
        console.error(`${tag} Error: ${e.message}`);
      }

      if (i < indexes.length - 1) await accountDelay();
    }

    console.log(`\nTotal GEMS claimed this session: ${totalGems}`);
    if (CFG.autoCycles && cycle >= CFG.autoCycles) break;

    const sleepSec = Math.min(CFG.autoMaxWait, Math.max(CFG.autoMinWait, waitSec + rand(...CFG.autoExtra)));
    const wake = new Date(Date.now() + sleepSec * 1000).toLocaleTimeString('en-GB');
    console.log(`💤 Next cycle in ${fmtWait(sleepSec)} (at ${wake}). Press Ctrl+C to stop`);
    await sleep(sleepSec * 1000);
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
// Line queue: answers aren't lost even if input arrives before the question (e.g. via a pipe)
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
const lines = [];
const waiters = [];
rl.on('line', l => (waiters.length ? waiters.shift()(l.trim()) : lines.push(l.trim())));
rl.on('close', () => { while (waiters.length) waiters.shift()(null); });
function ask(q) {
  process.stdout.write(q);
  if (lines.length) return Promise.resolve(lines.shift());
  return new Promise(res => waiters.push(a => {
    if (a === null) { console.error('\n[!] Input closed'); process.exit(1); }
    res(a);
  }));
}

async function askChoice(title, options) {
  console.log(`\n${title}`);
  options.forEach((o, i) => console.log(`  ${i + 1}. ${o}`));
  for (;;) {
    const a = Number(await ask(`Choice (1-${options.length}): `));
    if (Number.isInteger(a) && a >= 1 && a <= options.length) return a;
    console.log('[!] Invalid input');
  }
}

async function askIndex(label, max) {
  for (;;) {
    const n = Number(await ask(`${label} (1-${max}): `));
    if (Number.isInteger(n) && n >= 1 && n <= max) return n;
    console.log('[!] Invalid number');
  }
}

const isYes = a => /^(y|yes|да)$/i.test(a);

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!CFG.keys.length) {
    console.error('[!] PRIVATE_KEYS in .env is empty');
    process.exit(1);
  }
  console.log(`Wallets  : ${CFG.keys.length}`);
  console.log(`Usernames: ${CFG.usernames.length}`);
  console.log(`Ref code : ${CFG.refCode || '—'}`);

  const scope = await askChoice('Accounts:', ['One', 'All', 'From N to end']);
  let indexes = CFG.keys.map((_, i) => i);
  if (scope === 1) indexes = [(await askIndex('Account number', CFG.keys.length)) - 1];
  if (scope === 3) indexes = indexes.slice((await askIndex('Start from number', CFG.keys.length)) - 1);

  const mode = await askChoice('Mode:', [
    'Mining + Quests', 'Mining', 'Claim rewards', 'Quests',
    'Auto 24/7 (claim + mining + quests in a loop)',
    'Upgrades — spends GEMS', 'Shop — spends GEMS',
    'Auto 24/7 + Upgrades + Shop (5+6+7) — spends GEMS',
  ]);
  if (mode === 5) {
    rl.close();
    return autoLoop(indexes);
  }
  if (mode === 8) {
    const reserve = CFG.gemsReserve;
    const u = await askChoice('Upgrades every cycle:', [...UPGRADE_TYPES.map(t => t.name), 'All of them', "Don't buy"]);
    const upgTypes = u > UPGRADE_TYPES.length + 1 ? null
      : u > UPGRADE_TYPES.length ? UPGRADE_TYPES.map(t => t.type) : [UPGRADE_TYPES[u - 1].type];
    const upgCount = upgTypes ? await askIndex('How many of each per cycle', 50) : 0;
    const it = await askChoice('Shop:', [
      ...SHOP_ITEMS.map(x => `${x.name} (${x.effect}) — ${x.price} GEMS`), "Don't buy"]);
    const shopItem = SHOP_ITEMS[it - 1] || null;

    console.log(`\n⚠️  Auto 24/7 on ${indexes.length} account(s). Every cycle:`);
    console.log(`   Upgrades: ${upgTypes ? `${upgTypes.join(', ')} × ${upgCount}` : 'none'}`);
    console.log(`   Shop    : ${shopItem ? `${shopItem.name} (${shopItem.price} GEMS)${shopItem.id === 'energy-pack' ? ' — every cycle' : ' — once'}` : 'none'}`);
    console.log(`   Reserve : ${reserve} GEMS are never spent (AUTO_GEMS_RESERVE in .env)`);
    const yes = await ask('Confirm? Type "yes": ');
    rl.close();
    if (!isYes(yes)) return console.log('Cancelled.');
    return autoLoop(indexes, (upgTypes || shopItem) ? { upgTypes, upgCount, shopItem, reserve } : null);
  }
  const questMode = [1, 4].includes(mode)
    ? ((await askChoice('Quests:', ['Daily', 'Weekly'])) === 2 ? 'weekly' : 'daily')
    : null;

  let upgTypes = null, upgCount = 1, shopItem = null;
  if (mode === 6) {
    const u = await askChoice('What to upgrade:', [...UPGRADE_TYPES.map(t => t.name), 'All of them']);
    upgTypes = u > UPGRADE_TYPES.length ? UPGRADE_TYPES.map(t => t.type) : [UPGRADE_TYPES[u - 1].type];
    upgCount = await askIndex('How many times to buy each upgrade', 50);
  }
  if (mode === 7) {
    const it = await askChoice('What to buy (1 per account):',
      SHOP_ITEMS.map(x => `${x.name} (${x.effect}) — ${x.price} GEMS`));
    shopItem = SHOP_ITEMS[it - 1];
  }
  if (mode === 6 || mode === 7) {
    const what = mode === 6
      ? `${upgTypes.length} upgrade(s) × ${upgCount} (price differs per account)`
      : `${shopItem.name} for ${shopItem.price} GEMS (up to ${shopItem.price * indexes.length} total)`;
    console.log(`\n⚠️  Will buy on ${indexes.length} account(s): ${what}`);
    const yes = await ask('Confirm? Type "yes": ');
    if (!isYes(yes)) {
      console.log('Cancelled.');
      rl.close();
      return;
    }
  }
  rl.close();

  let totalGems = 0;
  const summary = [];
  for (let i = 0; i < indexes.length; i++) {
    const idx = indexes[i];
    const prefix = `[${i + 1}/${indexes.length}]`;

    let s;
    try {
      s = await login(CFG.keys[idx]);
      s.username = CFG.usernames[idx] || null;
      console.log(`\n${prefix} ${s.address} | Energy: ${s.user.energy ?? '?'}/${s.user.energyCapacity ?? '?'} | Twitter: ${s.user.twitterHandle || '-'}`);
    } catch (e) {
      console.error(`\n${prefix} Login error (account #${idx + 1}): ${e.message}`);
      continue;
    }

    const tag = `${prefix}[${s.address.slice(0, 8)}…]`;
    try {
      if (mode === 1 || mode === 2) await doMining(s, tag);
      if (mode === 1) await randomDelay();
      if (mode === 1 || mode === 4) await doTasks(s, tag, questMode);
      if (mode === 3) totalGems += await doClaim(s, tag);
      if (mode === 6) (await doUpgrades(s, tag, upgTypes, upgCount)).forEach(r => summary.push({ acc: idx + 1, ...r }));
      if (mode === 7) summary.push({ acc: idx + 1, ...(await doShop(s, tag, shopItem)) });
    } catch (e) {
      console.error(`${tag} Error: ${e.message}`);
    }

    if (i < indexes.length - 1) await accountDelay();
  }

  if (mode === 3) console.log(`\nTotal GEMS claimed: ${totalGems}`);
  if (summary.length) {
    console.log(`\n═══ Purchase summary ═══`);
    summary.forEach(r => console.log(`  Account ${r.acc}: ${r.name} — bought ${r.ok}${r.detail ? ` | ${r.detail}` : ''}`));
  }
  console.log('\nDone.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
