# Bullshot Gem Bot

Bot for [Bullshot Gem](https://gem.bullshot.io): mining, reward claiming, quests, upgrades and shop — for one or many wallets, run manually or 24/7.

Fork of [madsilx10/bullshot](https://github.com/madsilx10/bullshot). Config moved to `.env`, bugs fixed, and added an auto mode, GEMS spending protection and smarter mining location choice.

## Modes

| # | Mode | What it does |
|---|------|--------------|
| 1 | Mining + Quests | Starts mining and runs daily/weekly quests |
| 2 | Mining | Starts positions while energy lasts |
| 3 | Claim | Claims GEMS from finished positions |
| 4 | Quests | Daily or Weekly |
| 5 | Auto 24/7 | Claim → mining → quests in a loop, sleeps until the next position finishes |
| 6 | Upgrades | Mining Power / Energy Capacity / Mining Speed, N times |
| 7 | Shop | Buy equipment (1 item per account) |
| 8 | Auto 24/7 + buying | Mode 5 plus automatic upgrades/shop purchases with a GEMS reserve |

## Installation

Requires [Node.js](https://nodejs.org) 18+.

```bash
git clone https://github.com/Xaveron/bullshot.git
cd bullshot
npm install
cp .env.example .env
```

Fill in `.env` and run:

```bash
node bullshot.js
```

On Windows you can just double-click `start.bat`.

## `.env` settings

| Key | Description |
|-----|-------------|
| `PRIVATE_KEYS` | Private keys, comma-separated (with or without `0x`) |
| `TWITTER_USERNAMES` | X/Twitter usernames, comma-separated, same order as keys |
| `REF_CODE` | Your referral code (empty = none) |
| `DELAY_MS` | Delay between actions, ms, range `[min,max]` |
| `ACCOUNT_DELAY_MS` | Delay between accounts, ms, `[min,max]` |
| `MINING_LOCATIONS` | Empty = auto (highest tier the account qualifies for); or a manual priority, e.g. `crystal-cavern,greenstone-quarry` |
| `REQUEST_TIMEOUT_MS` / `REQUEST_RETRIES` | Timeout and retries on network errors / 429 / 5xx |
| `AUTO_*_WAIT_SEC` | Auto mode wait times, seconds |
| `AUTO_GEMS_RESERVE` | Mode 8: GEMS balance that is never spent |
| `AUTO_CYCLES` | Number of auto cycles (0 = infinite) |

## Changes compared to upstream

- **Config in `.env`** instead of `wallet.txt` / `usn.txt` / `akun.txt`; no hardcoded referral code
- **24/7 mode** (5 and 8): calculates when the next position finishes and sleeps until then
- **Location choice by real requirements** (level and Mining Power) instead of the `isLocked` flag, which the server reports incorrectly. The bot always mines the highest tier available (Crystal → Ember → Frozen → Void) and moves up automatically as the account levels; energy is saved for it instead of being spent on a cheaper location
- **GEMS protection**: confirmation before buying, balance reserve, per-account price checks
- **Reliable networking**: 60s timeout, retries on drops, 429 and 5xx
- **Input fixes**: an invalid menu number no longer crashes the script, piped answers are not lost
- **No fabricated tweet URLs** — tweet-verification quests must be done manually

## Security

- Use **separate empty wallets**. A private key gives full access to the wallet.
- `.env` is in `.gitignore` — never commit it or share it.
- Keys are only used to sign the login message locally; requests go only to `gemapi.bullshot.io`.
- Automation may violate the platform's rules and accounts can be banned. Use at your own risk.
