const { Wallet } = require('ethers');
const fs = require('fs');
const readline = require('readline');

const BASE_URL = 'https://gemapi.bullshot.io';
const REF_CODE  = '0x413c3593';
const TW_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const BULLSHOT_TWEET = 'https://twitter.com/Bullshot911/status/2114813596278604001';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomDelay = (min = 3000, max = 8000) => sleep(min + Math.random() * (max - min));
const accountDelay = () => sleep(2000 + Math.random() * 4000);

// ─── TWEET TEXTS ─────────────────────────────────────────────────────────────
const WEEKLY_POST_TEXTS = [
  ref => `Another solid week stacking GEMS and upgrading miners on @Bullshot911! ⚒️🔥\n\nBull GEM on Base is easily the smoothest idle miner right now. Check it out: https://gem.bullshot.io/r/${ref}\n\n#Bullshot #BullGems #BaseChain`,
  ref => `Weekly grind secured! Mining GEMS nonstop with @Bullshot911 on Base ⛏️💎\n\nIf you're not mining Bull GEM yet, you're missing out: https://gem.bullshot.io/r/${ref}\n\n#BullGems #Bullshot #BaseChain`,
  ref => `Stack week complete! GEMS keep rolling in on @Bullshot911 ⚒️🔥\n\nBull GEM on Base hits different. Jump in: https://gem.bullshot.io/r/${ref}\n\n#Bullshot #BullGems #Base`,
  ref => `Another week, another bag of GEMS from @Bullshot911! 💎⛏️\n\nIdling has never been this rewarding. Start mining: https://gem.bullshot.io/r/${ref}\n\n#BullGems #BaseChain #Bullshot`,
  ref => `Weekly miners report: GEMS stacked, upgrades done, vibes immaculate 🔥⚒️\n\nJoin me on @Bullshot911 Bull GEM: https://gem.bullshot.io/r/${ref}\n\n#Bullshot #BullGems #BaseChain`,
  ref => `7 days deep in the quarry with @Bullshot911. GEMS don't stop ⛏️🔥\n\nGet in early: https://gem.bullshot.io/r/${ref}\n\n#BullGems #Bullshot #Base`,
  ref => `Miner grind never sleeps with @Bullshot911! Week after week on Base 💎⚒️\n\nStart here: https://gem.bullshot.io/r/${ref}\n\n#Bullshot #BullGems #BaseChain`,
];

const WEEKLY_QRT_TEXTS = [
  ref => `Mining deep in the quarries with @Bullshot911! Don't sleep on Bull Gems on Base ⚒️💎\nhttps://gem.bullshot.io/r/${ref} #Bullshot`,
  ref => `Still going strong in the mines! @Bullshot911 keeping the GEMS flowing 🔥⛏️\nhttps://gem.bullshot.io/r/${ref} #BullGems`,
  ref => `Can't stop won't stop mining with @Bullshot911 💎⚒️ Bull GEM on Base is the play\nhttps://gem.bullshot.io/r/${ref} #Bullshot`,
  ref => `Weekly check-in from the quarry! @Bullshot911 delivering every week 🔥\nhttps://gem.bullshot.io/r/${ref} #BullGems #BaseChain`,
  ref => `Gems don't stop with @Bullshot911! Base chain mining at its finest ⛏️💎\nhttps://gem.bullshot.io/r/${ref} #Bullshot`,
  ref => `Another week grinding GEMS alongside @Bullshot911 on Base 🔥⚒️\nhttps://gem.bullshot.io/r/${ref} #BullGems`,
  ref => `@Bullshot911 never misses. Weekly GEMS secured 💎 Bull GEM on Base\nhttps://gem.bullshot.io/r/${ref} #Bullshot #BaseChain`,
];

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

// ─── TWITTER POST ─────────────────────────────────────────────────────────────
const TW_QUERY_ID = '7TKRKCPuAGsmYde0CudbVg';
const TW_FEATURES = {
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  articles_preview_enabled: true,
  rweb_video_timestamps_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  freedom_of_speech_not_reach_the_sky_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

async function postTweet(authToken, ct0, text, attachUrl = null) {
  const variables = {
    tweet_text: text,
    media: { media_entities: [], possibly_sensitive: false },
    semantic_annotation_ids: [],
    disallowed_reply_controls: [],
    ...(attachUrl ? { attachment_url: attachUrl } : {}),
  };

  const res = await fetch(`https://api.x.com/graphql/${TW_QUERY_ID}/CreateTweet`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${TW_BEARER}`,
      'cookie': `auth_token=${authToken}; ct0=${ct0}`,
      'x-csrf-token': ct0,
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'id',
      'origin': 'https://x.com',
      'referer': 'https://x.com/',
    },
    body: JSON.stringify({ variables, features: TW_FEATURES, queryId: TW_QUERY_ID }),
  });

  const data = await res.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  const tweetId = data?.data?.create_tweet?.tweet_results?.result?.rest_id;
  if (!tweetId) throw new Error('No tweet ID: ' + JSON.stringify(data));
  const username = data?.data?.create_tweet?.tweet_results?.result?.core?.user_results?.result?.legacy?.screen_name;
  return `https://x.com/${username}/status/${tweetId}`;
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
