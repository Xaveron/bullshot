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
  // CATATAN PENTING: isLocked TIDAK dipakai sebagai filter lagi.
  // Bukti dari Network tab user 2026-11-03: GET /api/mining/locations
  // bilang Crystal Cavern locked:true, tapi POST /api/mining/positions
  // manual dengan { locationId: "crystal-cavern" } di akun yang sama
  // tetap 200 OK dan posisi aktif (durasi 1800). Jadi flag isLocked
  // itu tidak ditegakkan oleh endpoint POST — yang jadi penentu akhir
  // adalah POST itu sendiri (kalau benar-benar tidak bisa, POST gagal
  // dan loop berhenti di "Mining stop"). Kolam lain tetap ke-skip
  // karena syarat power/energy/durasi: Ember butuh power 60, Frozen 120,
  // Void 250, sementara power akun utama 27.
  return locations
    .filter(l => l.name && l.durationSeconds >= 600
      && l.energyCost <= energy && l.miningPowerRequired <= miningPower)
    .sort((a, b) => {
      const g = (b.rewardRanges?.GEMS?.max || 0) - (a.rewardRanges?.GEMS?.max || 0);
      return g !== 0 ? g : b.durationSeconds - a.durationSeconds;
    })[0] || null;
}

async function doMining(session, tag) {
  // Auto saja (pickLocation, reward terbesar yang lolos): pilihan paksa
  // Crystal sempat ditambahkan lalu dibatalkan user 2026-11-03 karena
  // auto untuk akun utama memang sudah Crystal dulu, Greenstone hanya
  // untuk sisa energy / akun yang tidak lolos Crystal.
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

  // DEBUG LOKASI: supaya jelas kenapa satu kolam kepilih dan kolam
  // lain tidak. locked di sini hanya info, BUKAN alasan skip lagi
  // (lihat komentar di pickLocation: POST manual Crystal berhasil
  // walau locations bilang locked:true).
  {
    const statParts = [`energy: ${stats.energy}`, `miningPower: ${stats.miningPower}`];
    if (stats.level !== undefined) statParts.push(`level: ${stats.level}`);
    console.log(`${tag} [Lokasi] Stats: ${statParts.join(' | ')}`);
    (Array.isArray(locations) ? locations : []).forEach(l => {
      const reasons = [];
      if (!l.name) reasons.push('tanpa nama');
      if (l.durationSeconds !== undefined && l.durationSeconds < 600) reasons.push(`durasi ${l.durationSeconds}<600`);
      if (l.energyCost !== undefined && l.energyCost > energy) reasons.push(`energyCost ${l.energyCost} > energy ${energy}`);
      if (l.miningPowerRequired !== undefined && l.miningPowerRequired > stats.miningPower) reasons.push(`powerRequired ${l.miningPowerRequired} > power ${stats.miningPower}`);
      const rewardMax = l.rewardRanges?.GEMS?.max;
      // Tampilkan id juga, supaya payload yang akan dikirim ({ locationId:
      // id }) bisa dicek langsung: untuk Crystal harusnya "crystal-cavern",
      // sama seperti payload manual yang terbukti 200 OK.
      console.log(`${tag} [Lokasi] ${l.name || '-'} (id: ${l.id}) | locked: ${!!l.isLocked} | durasi: ${l.durationSeconds} | energyCost: ${l.energyCost} | powerRequired: ${l.miningPowerRequired} | rewardMax: ${rewardMax !== undefined ? rewardMax : '-'} | ${reasons.length ? `SKIP: ${reasons.join(', ')}` : 'ELIGIBLE'}`);
    });
  }

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
// questMode: 'daily' | 'weekly' | 'oneTime'
// One-time dicek dari GET /api/quests (field 'oneTime', bukan 'one_time'):
//  - tw_follow_bullshot : intent, follow @Bullshot911 di X, 300 / 150 XP
//                         (gerbangnya link X di Miner Center, sudah ditangani
//                         link-twitter di bawah; tidak ditemukan endpoint
//                         verify_follow di API publik, jadi polanya start+claim)
//  - tg_join_bullshot   : intent, join https://t.me/Bullshot9, 300 / 150 XP
//                         (TIDAK ada gerbang link Telegram di API publik:
//                         tidak ada field userTelegramLinked / tombol link
//                         Telegram, jadi TIDAK pakai sessions Telegram,
//                         polanya sama: start, tunggu delay, claim)
//  - dc_join_bullshot   : intent, join Discord, 300 / 150 XP (pola sama)
//  - tw_start_mining_tweet : verify_tweet, 450 / 225 XP
//                         (pakai tweetUrl seperti quest verify_tweet lainnya)
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
    oneTime: ['tw_follow_bullshot', 'tg_join_bullshot', 'dc_join_bullshot', 'tw_start_mining_tweet'],
  };

  const pool = raw[questMode] || [];

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

// ─── UPGRADE MINING ───────────────────────────────────────────────────────────
// Sumber terverifikasi: GET /api/upgrades (API publik, tanpa login).
// Daftar saat dicek (3 item, tier I saja):
//  - upg-power-1  : Mining Power I    | type miningPower    | +5  | biaya 250
//  - upg-energy-1 : Energy Capacity I | type energyCapacity | +20 | biaya 180
//                   (extra: baseCost 180, maxCapacity 320, currentCapacity 100)
//  - upg-speed-1  : Mining Speed I    | type miningSpeed    | +5  | biaya 350
// PENTING, jangan diasumsikan:
//  - API /api/upgrades TIDAK mengembalikan requiredLevel / unlockLevel /
//    minLevel / level maksimum, dan TIDAK melabeli mata uang cost.
//    Yang punya field levelRequired itu lokasi mining (mis. Crystal Cavern
//    level 4, Ember Mine level 8, Void Rift level 20), BUKAN upgrade.
//  - Endpoint beli TERVERIFIKASI dari Network tab user (bukan tebakan):
//    POST /api/upgrades/{id} TANPA body (Content-Length 0), dengan header
//    Authorization + X-Wallet-Address yang sama seperti api() di atas.
//    Contoh: POST /api/upgrades/upg-power-1 -> 200, success true,
//    "Successfully purchased Mining Power I!", user.miningPower +5.
//    PEMBELIAN BISA DIULANG dengan endpoint + id yang SAMA: pembelian
//    power ke-2 tetap POST /api/upgrades/upg-power-1, cost 250, +5 lagi
//    (power 7 -> 12, gems 3694.25 -> 3444.25 di test user). Jadi tidak ada
//    id tier II yang berubah — tiap klik beli = 1x increment.
//    PERHATIAN BIAYA: patokan biaya adalah cost dari GET /api/upgrades
//    per akun, BUKAN cost di respons beli. Contoh energy di test user:
//    GET cost 360 dan gems turun 360, padahal respons beli menulis cost
//    180. Karena itu log di bawah menampilkan GET cost + gems respons.
//  - Mode ini SEKARANG BENAR-BENAR MEMBELI: N x per upgrade terpilih per
//    akun, dengan N = pilihan "berapa kali" di menu mode 5 (default 1).
//    Pilih "Semua" = beli 3 upgrade (power, energy, speed) masing-
//    masing N x per akun. Jalankan dulu dengan scope 1 akun untuk test.
//    Total spend per akun = N x GET cost per upgrade terpilih.
//  - AKUN BEDA LEVEL: fungsi ini dipanggil per akun, dengan token akun itu
//    sendiri (lihat loop di main: satu akun gagal tidak menghentikan akun
//    lain). Jadi JANGAN hardcode satu ambang level global di menu / di sini.
//    Yang jadi patokan adalah daftar yang dikembalikan server untuk akun
//    itu: kalau satu tier belum muncul / belum eligible untuk akun itu,
//    akun itu di-skip untuk tier tersebut, akun lain yang sudah eligible
//    tetap jalan. Contoh perumpamaan level 5 -> tier B, level 8 -> tier A
//    BUKAN data terverifikasi, jadi tidak ditulis sebagai aturan di kode.
//  - BUKTI TEST LOGIN: Energy Capacity di satu akun tampil biaya 360 dan
//    maxCapacity 1980, padahal API publik 180 / 320. Artinya harga dan
//    kapasitas memang dinamis per akun — selalu pakai angka dari output
//    per akun, bukan angka menu / API publik.
async function doUpgrades(session, tag, upgradeType, repeatCount = 1) {
  // Jumlah pengulangan yang dipilih di menu; 1 = perilaku lama (1x).
  repeatCount = Math.max(1, parseInt(repeatCount) || 1);
  // Hasil per percobaan, dipakai ringkasan akhir di main(): { upgrade,
  // attempt, total, status: 'BERHASIL'|'GAGAL'|'SKIP', detail }.
  const results = [];
  const { address, token, user } = session;
  // Info level akun kalau server login mengembalikannya (kalau tidak ada,
  // baris ini tidak tampil — tidak diasumsikan).
  if (user) {
    const info = [];
    if (user.level !== undefined) info.push(`level: ${user.level}`);
    if (user.xp !== undefined) info.push(`xp: ${user.xp}`);
    if (user.gems !== undefined) info.push(`gems: ${user.gems}`);
    if (info.length > 0) console.log(`${tag} [Upgrade] Akun: ${info.join(' | ')}`);
  }

  let upgrades;
  try {
    upgrades = await api('GET', '/api/upgrades', null, address, token);
  } catch (e) {
    console.log(`${tag} [Upgrade] GET /api/upgrades failed: ${e.message}`);
    results.push({ upgrade: upgradeType, attempt: 0, total: repeatCount, status: 'GAGAL', detail: `GET /api/upgrades failed: ${e.message}` });
    return results;
  }
  if (!Array.isArray(upgrades)) upgrades = upgrades.upgrades || upgrades.items || [];
  // Simpan respons mentah saat login, supaya hasil test lewat skrip bisa
  // dicek: kalau respons login ternyata berisi field level / tier / beli
  // yang tidak ada di API publik, itu akan kelihatan di file ini.
  try { fs.appendFileSync('upgrades_debug.txt', `${address}|${JSON.stringify(upgrades)}\n`); } catch {}
  if (upgrades.length === 0) {
    console.log(`${tag} [Upgrade] Tidak ada upgrade dari /api/upgrades`);
    results.push({ upgrade: upgradeType, attempt: 0, total: repeatCount, status: 'SKIP', detail: 'Tidak ada upgrade dari /api/upgrades' });
    return results;
  }

  const LEVEL_FIELDS = ['requiredLevel', 'unlockLevel', 'minLevel', 'levelRequired', 'required_level', 'unlock_level'];
  const show = (u) => {
    const parts = [`${u.name || u.id} (${u.id})`, `type: ${u.type || '-'}`];
    if (u.increment !== undefined) parts.push(`+${u.increment}`);
    if (u.cost !== undefined) parts.push(`biaya: ${u.cost}`);
    for (const f of LEVEL_FIELDS) if (u[f] !== undefined) parts.push(`${f}: ${u[f]}`);
    if (u.level !== undefined) parts.push(`level: ${u.level}`);
    if (u.maxLevel !== undefined) parts.push(`maxLevel: ${u.maxLevel}`);
    if (u.maxCapacity !== undefined) parts.push(`maxCapacity: ${u.maxCapacity}`);
    if (u.currentCapacity !== undefined) parts.push(`currentCapacity: ${u.currentCapacity}`);
    if (u.isCapped !== undefined) parts.push(`isCapped: ${u.isCapped}`);
    console.log(`${tag} [Upgrade] ${parts.join(' | ')}`);
  };

  const list = upgradeType === 'all' ? upgrades : upgrades.filter(u => u.type === upgradeType);
  if (list.length === 0) {
    console.log(`${tag} [Upgrade] Skip akun ini: tidak ada upgrade type '${upgradeType}' di daftar akun ini (kemungkinan belum unlock untuk level akun ini). Akun lain tetap lanjut. Daftar lengkap akun ini:`);
    upgrades.forEach(show);
    results.push({ upgrade: upgradeType, attempt: 0, total: repeatCount, status: 'SKIP', detail: 'Tidak ada upgrade type ini di daftar akun ini (kemungkinan belum unlock)' });
    return results;
  }
  list.forEach(show);
  if (repeatCount > 1) {
    const est = list.map(u => `${u.name || u.id}: ${u.cost} x ${repeatCount} = ${u.cost !== undefined ? u.cost * repeatCount : '?'}`).join(', ');
    console.log(`${tag} [Upgrade] Jumlah beli: ${repeatCount}x per upgrade | Estimasi total: ${est}`);
  }

  // Beli: repeatCount x per upgrade terpilih, per akun. Gagal di satu
  // percobaan menghentikan pengulangan upgrade itu saja (mis. gems habis
  // / sudah capped, percobaan berikutnya pasti gagal juga), tapi tidak
  // menghentikan upgrade lain / akun lain (loop utama juga punya
  // try/catch per akun).
  for (const upg of list) {
    for (let n = 1; n <= repeatCount; n++) {
      try {
        const res = await api('POST', `/api/upgrades/${upg.id}`, null, address, token);
        const u = res.user || {};
        const stats = [];
        if (u.miningPower !== undefined) stats.push(`miningPower: ${u.miningPower}`);
        if (u.energyCapacity !== undefined) stats.push(`energyCapacity: ${u.energyCapacity}`);
        if (u.miningSpeed !== undefined) stats.push(`miningSpeed: ${u.miningSpeed}`);
        if (u.gems !== undefined) stats.push(`gems: ${u.gems}`);
        console.log(`${tag} [Upgrade] BOUGHT (${n}/${repeatCount}): ${upg.name || upg.id} | GET biaya: ${upg.cost} | ${res.message || 'success'}${stats.length ? ` | ${stats.join(' | ')}` : ''}`);
        results.push({ upgrade: upg.name || upg.id, attempt: n, total: repeatCount, status: 'BERHASIL', detail: stats.join(' | ') });
      } catch (e) {
        console.log(`${tag} [Upgrade] Buy failed (${n}/${repeatCount}): ${upg.name || upg.id} | ${e.message} | berhenti mengulang upgrade ini`);
        results.push({ upgrade: upg.name || upg.id, attempt: n, total: repeatCount, status: 'GAGAL', detail: e.message });
        break;
      }
      await randomDelay();
    }
  }
  return results;
}

// ─── SHOP / TRADE (MODE TERPISAH DARI UPGRADE) ───────────────────────────────
// Sistem BERBEDA dari /api/upgrades: ini beli alat (equipment) yang masuk
// inventory, bukan stat increment langsung.
// Endpoint TERVERIFIKASI dari Network tab user (bukan tebakan):
//   POST /api/shop/purchase  body: { itemId: "..." }  -> 200, success true
// Contoh terverifikasi: { itemId: "copper-turbo-drill" } -> Copper Turbo
// Drill (+15 Mining Power, 1000 GEMS), miningPower 12 -> 27,
// gems 3444.25 -> 2444.25.
// Daftar di bawah dari SS items user 2026-11-03; daftar ini MUNGKIN TIDAK
// LENGKAP dan harga/efek bisa berubah — yang jadi patokan beli adalah
// itemId yang dipilih di menu, dan respons server (gems/stat baru).
// Item yang masih terkunci untuk akun itu akan gagal di server (log
// Buy failed) dan tidak menghentikan akun lain. Item yang SUDAH DIMILIKI
// tidak perlu / tidak bisa dibeli ulang: tombolnya tidak bisa diklik dan
// bukan purchase lagi (info user 2026-11-03), jadi mode ini tetap 1x
// per item per jalan, tanpa pilihan pengulangan. TIDAK ADA pilihan "Semua"
// di mode ini, sengaja, supaya tidak belanja besar tanpa sengaja:
// total semua item di daftar ini > 50000 GEMS.
// Energy Pack itu consumable (+5 energy sekali pakai), bukan alat permanen.
const SHOP_ITEMS = [
  { id: 'rusty-pickaxe',     name: 'Rusty Pickaxe',     effect: '+0 Mining Power', price: 10 },
  { id: 'iron-pickaxe',      name: 'Iron Pickaxe',      effect: '+2 Mining Power', price: 100 },
  { id: 'energy-pack',       name: 'Energy Pack',       effect: '+5 energy (consumable)', price: 150 },
  { id: 'iron-drill',        name: 'Iron Drill',        effect: '+6 Mining Power', price: 350 },
  { id: 'copper-turbo-drill', name: 'Copper Turbo Drill', effect: '+15 Mining Power', price: 1000 },
  { id: 'ruby-laser',        name: 'Ruby Laser',        effect: '+35 Mining Power', price: 3500 },
  { id: 'cryo-plasma-drill', name: 'Cryo Plasma Drill', effect: '+80 Mining Power', price: 10000 },
  { id: 'void-annihilator',  name: 'Void Annihilator',  effect: '+200 Mining Power', price: 35000 },
];

async function doShop(session, tag, shopItem) {
  const { address, token, user } = session;
  if (!shopItem) { console.log(`${tag} [Shop] Tidak ada item terpilih`); return null; }

  // Cek saldo dari login dulu (kalau server login mengembalikannya).
  // Ini hanya pra-cek; keputusan akhir tetap di server saat POST.
  if (user && user.gems !== undefined && user.gems < shopItem.price) {
    console.log(`${tag} [Shop] Skip: gems ${user.gems} < harga ${shopItem.price} (${shopItem.name})`);
    return { item: shopItem.name, status: 'GAGAL', locked: false, detail: `gems ${user.gems} < harga ${shopItem.price}` };
  }

  // TIDAK ADA endpoint GET daftar shop yang terverifikasi, jadi status
  // lock hanya bisa ketahuan dari respons POST: kalau server menolak
  // karena terkunci, error-nya ditandai locked dan ditampilkan lengkap
  // di log + ringkasan akhir. Kalau sudah unlock dan berhasil, tidak
  // perlu detail tambahan di ringkasan.
  console.log(`${tag} [Shop] Beli: ${shopItem.name} (${shopItem.id}) | ${shopItem.effect} | harga: ${shopItem.price} GEMS`);
  try {
    const res = await api('POST', '/api/shop/purchase', { itemId: shopItem.id }, address, token);
    const u = res.user || {};
    const stats = [];
    if (u.miningPower !== undefined) stats.push(`miningPower: ${u.miningPower}`);
    if (u.energyCapacity !== undefined) stats.push(`energyCapacity: ${u.energyCapacity}`);
    if (u.miningSpeed !== undefined) stats.push(`miningSpeed: ${u.miningSpeed}`);
    if (u.energy !== undefined) stats.push(`energy: ${u.energy}`);
    if (u.gems !== undefined) stats.push(`gems: ${u.gems}`);
    console.log(`${tag} [Shop] BOUGHT: ${res.item?.name || shopItem.name} | ${stats.length ? stats.join(' | ') : (res.message || 'success')}`);
    return { item: res.item?.name || shopItem.name, status: 'BERHASIL', locked: false, detail: '' };
  } catch (e) {
    const locked = /lock|unlock|terkunci|belum terbuka|not unlocked|requires level|level required/i.test(e.message);
    if (locked) {
      console.log(`${tag} [Shop] TERKUNCI: ${shopItem.name} belum bisa dibeli akun ini | detail: ${e.message}`);
      return { item: shopItem.name, status: 'TERKUNCI', locked: true, detail: e.message };
    }
    console.log(`${tag} [Shop] Buy failed: ${shopItem.name} | ${e.message}`);
    return { item: shopItem.name, status: 'GAGAL', locked: false, detail: e.message };
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
  console.log(`  5. Upgrade Mining`);
  console.log(`  6. Shop (Beli Alat Mining)`);
  const mode = await prompt('\nPilih (1/2/3/4/5/6): ');
  if (!['1','2','3','4','5','6'].includes(mode)) { console.log('[!] Invalid'); return; }

  // Pilih sub-mode task kalau mode 1 atau 4
  let questMode = null;
  if (['1','4'].includes(mode)) {
    console.log(`\nTask mode:`);
    console.log(`  1. Daily`);
    console.log(`  2. Weekly`);
    console.log(`  3. One-Time`);
    const tm = await prompt('\nPilih (1/2/3): ');
    questMode = tm === '2' ? 'weekly' : tm === '3' ? 'oneTime' : 'daily';
  }

  // Pilih sub-menu upgrade kalau mode 5 (satu jenis per pilihan, karena
  // tiap upgrade beda type dan efek — lihat doUpgrades).
  // Harga TIDAK ditulis di menu ini karena terbukti beda per akun saat
  // login (contoh test: Energy Capacity 360, bukan 180 di API publik).
  // Harga asli per akun selalu tampil di output mode 5.
  let upgradeType = null;
  let upgradeCount = 1;
  if (mode === '5') {
    console.log(`\nUpgrade mining:`);
    console.log(`  1. Mining Power`);
    console.log(`  2. Energy Capacity`);
    console.log(`  3. Mining Speed`);
    console.log(`  4. Semua (tampilkan semua upgrade)`);
    const um = await prompt('\nPilih (1/2/3/4): ');
    upgradeType = um === '2' ? 'energyCapacity' : um === '3' ? 'miningSpeed' : um === '4' ? 'all' : 'miningPower';
    // Berapa kali beli per upgrade terpilih, per akun. 1 = perilaku lama.
    // Beli ulang upgrade itu terverifikasi bisa (endpoint + id sama, +5
    // lagi per klik), jadi angka > 1 di sini memang sengaja mengulang.
    const uc = parseInt(await prompt('Berapa kali upgrade (1 = sekali, mis. 3 untuk +15 power): '));
    upgradeCount = Math.max(1, uc || 1);
  }

  // Pilih sub-menu shop kalau mode 6 (mode TERPISAH dari mode 5).
  // Satu item per pilihan, TANPA pilihan "Semua" — sengaja, supaya
  // tidak belanja puluhan ribu GEMS tanpa sengaja. Item yang masih
  // terkunci untuk akun itu akan gagal di server dan di-log, bukan
  // memaksa beli.
  let shopItem = null;
  if (mode === '6') {
    console.log(`\nShop (beli alat mining, 1 item per akun):`);
    SHOP_ITEMS.forEach((it, i) => console.log(`  ${i + 1}. ${it.name} (${it.effect}, ${it.price} GEMS)`));
    const sm = parseInt(await prompt(`\nPilih (1-${SHOP_ITEMS.length}): `));
    shopItem = SHOP_ITEMS[sm - 1] || null;
    if (!shopItem) { console.log('[!] Invalid shop item'); return; }
  }

  // Ambil selected
  const allSelected = selectKeys(keys, scope, from);

  const total = allSelected.length;
  let totalGems = 0;
  // Ringkasan akhir mode 5 / 6: { akun (nomor wallet.txt, 1-based),
  // address, ...hasil doUpgrades/doShop }.
  const upgradeSummary = [];
  const shopSummary = [];

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
      } else if (mode === '5') {
        const res5 = await doUpgrades(s, tag, upgradeType, upgradeCount) || [];
        res5.forEach(r => upgradeSummary.push({ akun: idx + 1, address: s.address, ...r }));
      } else if (mode === '6') {
        const res6 = await doShop(s, tag, shopItem);
        if (res6) shopSummary.push({ akun: idx + 1, address: s.address, ...res6 });
      }
    } catch (e) {
      console.error(`${tag} Error: ${e.message}`);
    }

    if (i < total - 1) await accountDelay();
  }

  if (mode === '3') console.log(`\nTotal GEMS claimed: ${totalGems}`);

  // Ringkasan akhir upgrade: berhasil + gagal per akun + upgrade, supaya
  // langsung kelihatan akun mana yang gagal dan upgrade apa.
  if (upgradeSummary.length > 0) {
    const ok = upgradeSummary.filter(r => r.status === 'BERHASIL').length;
    const fail = upgradeSummary.filter(r => r.status !== 'BERHASIL').length;
    console.log(`\n=== RINGKASAN UPGRADE: ${ok} berhasil, ${fail} gagal/skip ===`);
    upgradeSummary.forEach(r => {
      const attempt = r.total > 1 || r.attempt > 0 ? ` (${r.attempt}/${r.total})` : '';
      console.log(`  Akun ${r.akun} (${r.address.slice(0, 8)}...): ${r.upgrade}${attempt} - ${r.status}${r.detail ? ` | ${r.detail}` : ''}`);
    });
  }

  // Ringkasan akhir shop: item yang masih terkunci ditampilkan lengkap
  // dengan detailnya, supaya jelas kenapa tidak bisa dibeli. Item yang
  // sudah unlock dan berhasil dibeli tidak perlu detail lagi.
  if (shopSummary.length > 0) {
    const ok = shopSummary.filter(r => r.status === 'BERHASIL').length;
    const locked = shopSummary.filter(r => r.status === 'TERKUNCI').length;
    console.log(`\n=== RINGKASAN SHOP: ${ok} berhasil, ${locked} terkunci ===`);
    shopSummary.forEach(r => {
      // Detail hanya untuk yang terkunci, sesuai permintaan: yang sudah
      // unlock / berhasil tidak perlu detail lagi di ringkasan.
      const detail = r.locked && r.detail ? ` | detail: ${r.detail}` : '';
      console.log(`  Akun ${r.akun} (${r.address.slice(0, 8)}...): ${r.item} - ${r.status}${detail}`);
    });
  }

  console.log(`\nDone.`);
}

main().catch(console.error);
