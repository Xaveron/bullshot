const { Wallet } = require('ethers');
const fs = require('fs');
const readline = require('readline');

const BASE_URL = 'https://gemapi.bullshot.io';
const REF_CODE  = '0x413c3593';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomDelay = (min = 3000, max = 8000) => sleep(min + Math.random() * (max - min));
const accountDelay = () => sleep(2000 + Math.random() * 4000);

// ─── PARSE AKUN.TXT ───────────────────────────────────────────────────────────
function parseAkun() {
  if (!fs.existsSync('akun.txt')) return [];
  const raw = fs.readFileSync('akun.txt', 'utf-8').trim();
  const blocks = raw.split(/\n\s*\n/);
  return blocks.map(b => {
    const lines = b.trim().split('\n').map(l => l.trim()).filter(Boolean);
    return { authToken: lines[0] || '', ct0: lines[1] || '' };
  }).filter(a => a.authToken && a.ct0);
}

// ─── BULLSHOT API ─────────────────────────────────────────────────────────────
function getHeaders(address = '', token = '') {
  return {
    'Content-Type': 'application/json',
    'Origin': 'https://gem.bullshot.io',
    'Referer': 'https://gem.bullshot.io/',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    ...(address ? { 'X-Wallet-Address': address } : {}),
    ...(token   ? { 'Authorization': `Bearer ${token}` } : {}),
  };
}

async function api(method, path, body, address, token) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: getHeaders(address, token),
      signal: ctrl.signal,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`Non-JSON: ${text.slice(0, 100)}`); }
    if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
    return data;
  } finally { clearTimeout(to); }
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
async function login(privateKey) {
  const wallet = new Wallet(privateKey.trim());
  const address = wallet.address;
  const ban = await api('GET', `/api/user/check-ban/${address}`, null, address);
  if (ban.banned || ban.isBanned) throw new Error('BANNED');
  const { message } = await api('POST', '/api/auth/nonce', { walletAddress: address }, address);
  const signature = await wallet.signMessage(message);
  const { token, user } = await api('POST', '/api/auth/login', {
    walletAddress: address, message, signature, refCode: REF_CODE,
  }, address);
  return { address, token, user };
}

// ─── MINING ───────────────────────────────────────────────────────────────────
function pickLocation(locations, energy, miningPower) {
  return locations
    .filter(l => !l.isLocked && l.name && l.durationSeconds >= 600
      && l.energyCost <= energy && l.miningPowerRequired <= miningPower)
    .sort((a, b) => {
      const g = (b.rewardRanges?.GEMS?.max || 0) - (a.rewardRanges?.GEMS?.max || 0);
      return g !== 0 ? g : b.durationSeconds - a.durationSeconds;
    })[0] || null;
}

async function doMining(session, tag) {
  const { address, token } = session;

  const positions = await api('GET', '/api/mining/positions', null, address, token);
  const active = positions.filter(p => p.status === 'active');
  if (active.length > 0) {
    const soonest = active.sort((a, b) => a.remainingSeconds - b.remainingSeconds)[0];
    console.log(`${tag} Active: ${active.length} position(s) | soonest done in ${soonest.remainingSeconds}s`);
  }

  const [locations, stats] = await Promise.all([
    api('GET', '/api/mining/locations', null, address, token),
    api('GET', '/api/mining/stats', null, address, token),
  ]);

  let energy = stats.energy;
  let started = 0;

  while (true) {
    const loc = pickLocation(locations, energy, stats.miningPower);
    if (!loc) {
      if (started === 0) console.log(`${tag} No location available (energy: ${energy})`);
      break;
    }
    try {
      await api('POST', '/api/mining/positions', { locationId: loc.id }, address, token);
      started++;
      energy -= loc.energyCost;
      console.log(`${tag} [⛏${started}] ${loc.name} | ${loc.durationSeconds}s | energy sisa: ${energy}`);
      await randomDelay();
    } catch (e) {
      console.log(`${tag} Mining stop: ${e.message}`);
      break;
    }
  }

  if (started > 0) console.log(`${tag} Total started: ${started} position(s)`);
}

// ─── TASK ─────────────────────────────────────────────────────────────────────
// questMode: 'daily' | 'weekly'
async function doTasks(session, tag, twitterHandle, questMode, twCreds, acctIdx) {
  const { address, token, user } = session;
  const refCode = user.refCode || REF_CODE;

  // Link twitter kalau belum
  if (twitterHandle && !user.twitterHandle) {
    try {
      const r = await api('POST', '/api/user/link-twitter', { twitterHandle }, address, token);
      console.log(`${tag} [Twitter] Linked: @${r.twitterHandle}`);
    } catch (e) {
      console.log(`${tag} [Twitter] Link failed: ${e.message}`);
    }
    await randomDelay();
  }

  // Get quests
  let raw;
  try {
    raw = await api('GET', '/api/quests', null, address, token);
  } catch (e) {
    console.log(`${tag} [Quest] GET failed: ${e.message}`);
    return;
  }

  const WHITELIST = {
    daily:  ['daily_miner_signin', 'tw_daily_engage'],
    weekly: ['tw_weekly_post', 'tw_weekly_qrt', 'weekly_miner_checkin'],
  };

  const pool = questMode === 'daily'
    ? (raw.daily  || [])
    : (raw.weekly || []);

  const allowed = WHITELIST[questMode] || [];
  const doable = pool.filter(q =>
    allowed.includes(q.id) &&
    ['available', 'in_progress', 'started', 'ready', 'pending'].includes(q.status)
  );

  if (doable.length === 0) {
    console.log(`${tag} [Quest] Semua ${questMode} quest selesai`);
    pool.filter(q => allowed.includes(q.id))
        .forEach(q => console.log(`${tag}   └ ${q.id}: ${q.status}`));
    return;
  }

  for (const quest of doable) {
    const qid = quest.id;
    try {
      // Start hanya kalau masih available
      if (quest.status === 'available') {
        const started = await api('POST', '/api/quests/start', { questId: qid }, address, token);
        const wait = (started.delaySeconds || started.secondsLeft || 10) + 2;
        console.log(`${tag} [Quest] Started: ${quest.title} | wait ${wait}s`);
        await sleep(wait * 1000);
      } else {
        console.log(`${tag} [Quest] Resume: ${quest.title} (${quest.status})`);
      }

      // Handle verify_tweet quests (butuh tweet URL)
      let tweetUrl = '';
      if (quest.actionType === 'verify_tweet') {
        if (!session.username) {
          console.log(`${tag} [Quest] Skip ${quest.title} — no username`);
          continue;
        }
        const randomId = Date.now().toString() + Math.floor(Math.random() * 9999).toString().padStart(4, '0');
        tweetUrl = `https://x.com/${session.username}/status/${randomId}`;
        console.log(`${tag} [Tweet] URL: ${tweetUrl}`);
        if (qid === 'tw_weekly_qrt') {
          fs.appendFileSync('qrt_urls.txt', `${address}|${tweetUrl}\n`);
        }
      }

      // Claim
      const claimed = await api('POST', '/api/quests/claim', { questId: qid, tweetUrl }, address, token);
      console.log(`${tag} [Quest] Claimed: ${quest.title} | +${claimed.reward?.gems || 0} GEMS +${claimed.reward?.xp || 0} XP`);
    } catch (e) {
      console.log(`${tag} [Quest] ${quest.title} error: ${e.message}`);
    }
    await randomDelay();
  }
}

// ─── CLAIM MINING ─────────────────────────────────────────────────────────────
async function doClaim(session, tag) {
  const { address, token } = session;
  const positions = await api('GET', '/api/mining/positions', null, address, token);
  const claimable = positions.filter(p =>
    p.status === 'completed' || (p.remainingSeconds !== undefined && p.remainingSeconds <= 0)
  );

  if (claimable.length === 0) {
    const active = positions.filter(p => p.status === 'active');
    if (active.length > 0) {
      const s = active.sort((a, b) => a.remainingSeconds - b.remainingSeconds)[0];
      console.log(`${tag} Still mining: ${s.locationName} | ${s.remainingSeconds}s left`);
    } else {
      console.log(`${tag} Nothing to claim`);
    }
    return 0;
  }

  let totalGems = 0;
  for (const pos of claimable) {
    try {
      const res = await api('POST', `/api/mining/positions/${pos.id}/claim`, null, address, token);
      const gems = res.gemsEarned || 0;
      totalGems += gems;
      console.log(`${tag} Claimed: ${pos.locationName} | +${gems} GEMS | ${res.rewards?.join(', ')}`);
    } catch (e) {
      console.log(`${tag} Claim failed: ${e.message}`);
    }
    await sleep(500);
  }
  return totalGems;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function prompt(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, ans => { rl.close(); res(ans.trim()); }));
}

function selectKeys(keys, scope, from) {
  if (scope === '1') return [{ key: keys[from - 1], idx: from - 1 }];
  if (scope === '3') return keys.slice(from - 1).map((k, i) => ({ key: k, idx: from - 1 + i }));
  return keys.map((k, i) => ({ key: k, idx: i }));
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  const keys = fs.readFileSync('wallet.txt', 'utf-8')
    .split('\n').map(l => l.trim()).filter(Boolean);

  const usernames = fs.existsSync('usn.txt')
    ? fs.readFileSync('usn.txt', 'utf-8').split('\n').map(l => l.trim().replace(/^@/, '')).filter(Boolean)
    : [];

  const akunList = parseAkun();

  console.log(`Wallets  : ${keys.length}`);
  console.log(`Usernames: ${usernames.length}`);
  console.log(`Akun tw  : ${akunList.length}`);

  // Pilih scope
  console.log(`\nAkun:`);
  console.log(`  1. 1 akun`);
  console.log(`  2. Semua`);
  console.log(`  3. From X to end`);
  const scope = await prompt('\nPilih (1/2/3): ');
  let from = 1;
  if (scope === '1') from = parseInt(await prompt(`Nomor akun (1-${keys.length}): `));
  else if (scope === '3') from = parseInt(await prompt(`Mulai dari nomor (1-${keys.length}): `));

  // Pilih mode
  console.log(`\nMode:`);
  console.log(`  1. Mining + Task`);
  console.log(`  2. Mining`);
  console.log(`  3. Claim`);
  console.log(`  4. Task`);
  const mode = await prompt('\nPilih (1/2/3/4): ');
  if (!['1','2','3','4'].includes(mode)) { console.log('[!] Invalid'); return; }

  // Pilih sub-mode task kalau mode 1 atau 4
  let questMode = null;
  if (['1','4'].includes(mode)) {
    console.log(`\nTask mode:`);
    console.log(`  1. Daily`);
    console.log(`  2. Weekly`);
    const tm = await prompt('\nPilih (1/2): ');
    questMode = tm === '2' ? 'weekly' : 'daily';
  }

  // Ambil selected
  const allSelected = selectKeys(keys, scope, from);

  const total = allSelected.length;
  let totalGems = 0;

  for (let i = 0; i < total; i++) {
    const { key, idx } = allSelected[i];
    const num = `[${i + 1}/${total}]`;

    // Login
    let s;
    try {
      s = await login(key);
      s.username = usernames[idx] || null;
      s.twCreds  = akunList[idx]  || null;
      s.acctIdx  = idx;
      console.log(`\n${num} ${s.address} | Energy: ${s.user.energy}/${s.user.energyCapacity} | Twitter: ${s.user.twitterHandle || '-'}`);
    } catch (e) {
      console.error(`${num} Login error: ${e.message}`);
      continue;
    }

    const tag = `${num}[${s.address.slice(0, 8)}...]`;

    // Action
    try {
      if (mode === '1') {
        await doMining(s, tag);
        await randomDelay();
        await doTasks(s, tag, s.username, questMode, s.twCreds, s.acctIdx);
      } else if (mode === '2') {
        await doMining(s, tag);
      } else if (mode === '3') {
        const gems = await doClaim(s, tag);
        totalGems += gems;
      } else if (mode === '4') {
        await doTasks(s, tag, s.username, questMode, s.twCreds, s.acctIdx);
      }
    } catch (e) {
      console.error(`${tag} Error: ${e.message}`);
    }

    if (i < total - 1) await accountDelay();
  }

  if (mode === '3') console.log(`\nTotal GEMS claimed: ${totalGems}`);
  console.log(`\nDone.`);
}

main().catch(console.error);
