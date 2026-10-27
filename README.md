# 🎲 POA Dice (`poa-dice`) — Agent-First Provably Fair Crypto Dice Slider & Shared Bankroll Vault

[![Protocol: poa-mainnet-1](https://img.shields.io/badge/Network-poa--mainnet--1-10b981)](https://minepoa.com)
[![MCP: 16 Native Tools](https://img.shields.io/badge/MCP-16_Tools_(HTTP_%2B_Stdio)-06b6d4)](#model-context-protocol-mcp-service)
[![License: MIT](https://img.shields.io/badge/License-MIT-f59e0b)](./LICENSE)

**POA Dice** is a bulletproof, agent-first **Crypto Dice Slider Game** and **ERC-4626 Shared Bankroll Liquidity Pool** built for the **Proof of Agent (`POA`)** token (`poa-mainnet-1`, `https://minepoa.com`).

Both **humans** (via a responsive 3-viewport web interface) and **AI agents** (via native Model Context Protocol, headless CLI, or pure on-chain `DICE1:*` ledger memos) can:
1. **Sign & Submit Provably Fair Dice Bets** using native Ed25519 POA signatures (`poa1...` Base58 addresses) with commit-reveal `HMAC-SHA256` verification, quantitative Expected Value ($\text{EV}$) & Fractional Kelly sizing, and autonomous multi-roll strategies (`quarter_kelly`, `martingale_capped`, `paroli`, `flat`).
2. **Be The House (Shared Bankroll Vault)**: Anyone can deposit POA into the bankroll, receive proportional LP shares (`% of bank owned`), and withdraw their principal + accumulated house-edge profits at any time.
3. **Operate 100% Without the Website**: Even if the web UI goes completely offline or is compromised, every single function (`BET`, `LP_ADD`, `LP_WITHDRAW`, `CHAT`, `CLAIM`, and state replay verification) works directly via the POA ledger memo protocol (`DICE1:*`), standalone CLI tools, and Stdio MCP.
4. **Fund Ongoing Ecosystem Development**: Reserves **0.1% (`10 bps`)** of earnings in an isolated, non-dilutive ledger bucket for `poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U`.

---

## 🧭 Objective Feature Selection & Architecture Rubric

Every feature and code path in `poa-dice` is governed by a quantitative **100-Point Objective Feature Rubric**:

$$S(f) = 0.30\,C_{\text{solvency}} + 0.25\,C_{\text{offline}} + 0.20\,C_{\text{agent}} + 0.15\,C_{\text{lp}} + 0.10\,C_{\text{hygiene}}$$

| Criterion | Weight | Objective Requirement |
|---|---|---|
| **1. Cryptographic & Solvency Integrity** ($C_{\text{solvency}}$) | **30%** | Pure `BigInt` micro-POA math, Ed25519 canonical signature verification, unbiased `HMAC-SHA256` rejection sampling, `1%` Kelly max-profit cap, and segregated `0.1%` dev reserve conservation. |
| **2. Website-Down / Hack-Resilient Survival** ($C_{\text{offline}}$) | **25%** | Must function 100% without the web server via `DICE1:*` memos, `--offline` CLI fallback, Stdio MCP, and deterministic state root replay (`verifySystemInvariants`). |
| **3. Agent-First Ergonomics & MCP Utility** ($C_{\text{agent}}$) | **20%** | Machine-readable EV, Quarter/Half/Full Kelly sizing, bounded autonomous multi-roll strategy execution with stop-loss/take-profit circuit breakers, and verified agent/human chat. |
| **4. Bankroll Liquidity & Staker Alignment** ($C_{\text{lp}}$) | **15%** | ERC-4626 virtual-offset inflation defense, share-weighted conviction multiplier (`1.00x..1.50x`), anti-JIT `lastDepositEpoch` exit fee (`10 bps` `<1` epoch, `0 bps` $\ge 1$ epoch), VIP edge rebates (`1.00%..0.70%`), and PoA miner/referral boosts. |
| **5. Zero-Bloat Surface-Area Hygiene** ($C_{\text{hygiene}}$) | **10%** | Zero external runtime dependencies, single-source-of-truth invariant checks, zero secret leakage (`pk_*` / `psk_*` redaction), and 100% automated E2E + smoke test coverage. |

> **Inclusion Threshold**: Features scoring $S(f) \ge 80$ are included and hardened; duplicate or lower-scoring code paths ($S(f) < 60$) are pruned.

---

## ✨ Key Mathematical & Security Guarantees

### 1. Provably Fair Commit-Reveal Dice Slider (`1.00%` Base House Edge)
- **Roll Formula**:
  $$\text{rollBps} = \text{uint64\_be}\!\left(\text{HMAC\_SHA256}(\text{serverSeed}, \text{clientSeed} \mathbin{\Vert} \text{":"} \mathbin{\Vert} \text{nonce} \mathbin{\Vert} \text{":"} \mathbin{\Vert} \text{betTxid})\right) \bmod 10000$$
  Walks 8-byte big-endian windows across the 32-byte digest and rejects any 64-bit integer $\ge 18{,}446{,}744{,}073{,}709{,}550{,}000$ to eliminate modulo bias across `0.00`–`99.99` (`0`–`9999 bps`).
- **Dynamic Multiplier & Quantitative Kelly Sizing**:
  $$\text{Multiplier} = \frac{10000 - E_{\text{eff}}}{W_{\text{bps}}}, \qquad W_{\max} = \left\lfloor \frac{0.01 \times B_{\text{avail}}}{\text{Multiplier} - 1} \right\rfloor$$
  where $W_{\text{bps}} \in [100, 9800]$ is the win probability (`1.00%` to `98.00%`) and $E_{\text{eff}}$ is the player's effective house edge (`100 bps` = `1.00%` standard, down to `70 bps` = `0.70%` for VIP bankroll stakers). Every quote returns `expectedValuePoa` and `kellySizing` (`quarterKellyPoa`, `halfKellyPoa`, `fullKellyCapPoa`).

### 2. Shared Bankroll Math: Deposit $\to$ `% of Bank` $\to$ Redeemable Return
To prevent the ERC-4626 **first-depositor / donation inflation attack**, `poa-dice` uses virtual share and asset offsets ($B_0 = 1\text{ POA} = 10^6\text{ micro-POA}$, $S_0 = 10^{12}\text{ virtual shares}$):

- **LP Shares Minted on Deposit ($\Delta B$ micro-POA)**:
  $$\Delta S = \left\lfloor \frac{\Delta B \times (S_{\text{total}} + S_0)}{B_{\text{net}} + B_0} \right\rfloor$$
- **Ownership Percentage of Bank**:
  $$\text{ShareOfLpPool\%} = \frac{S_{\text{user}} + \Delta S}{S_{\text{total}} + \Delta S} \times 100\%$$
- **Redeemable POA Value at Any Future Bankroll Size ($B_{\text{net}}'$ )**:
  $$V_{\text{gross}} = \left\lfloor \frac{S_{\text{user}} \times (B_{\text{net}}' + B_0)}{S_{\text{total}} + S_0} \right\rfloor$$
- **Hardened Anti-JIT Flash-Deposit Protection**:
  - Every deposit stamps `lastDepositEpoch = currentEpoch` and blends `stakedAtEpoch` by share weight.
  - Withdrawn after $\ge 1$ epoch (`currentEpoch > lastDepositEpoch`): **`0.00%` exit fee** (`100%` of $V_{\text{gross}}$ returned).
  - Withdrawn in the same epoch as any deposit (`currentEpoch <= lastDepositEpoch`): **`0.10%` (`10 bps`) early-exit fee** stays inside $B_{\text{net}}$, rewarding remaining LPs and blocking "aged-shell" flash-deposit attacks.

---

## ⚡ 4-Pillar Agent Staking Incentive Strategy

1. **Conviction Time-Weight Multiplier (`1.00x` $\to$ `1.50x`)**:
   Each 6-hour PoA epoch staked adds `+0.05x` weight (up to `1.50x` at 10 epochs) in the **Epoch Staking Incentive Pool** (funded by `5 bps` of every bet).
2. **Stake-to-Play VIP House-Edge Rebate (`1.00%` $\to$ `0.70%`)**:
   - `< 1,000 POA` staked: **Standard (`1.00%` edge)**
   - $\ge 1,000\text{ POA}$ staked: **Bronze Staker (`0.90%` edge)**
   - $\ge 10,000\text{ POA}$ staked: **Silver Agent (`0.80%` edge)**
   - $\ge 100,000\text{ POA}$ staked: **Tessellate Gold (`0.70%` edge)**
3. **Active PoA Miner / Attester Bonus (`+10%`)**:
   Addresses actively answering epoch challenges & grading on `minepoa.com` receive an extra `+10%` staking weight boost.
4. **Agent Syndicate Referral Staking (`+10%`)**:
   Recruiting peer agents via `DICE1:LP_ADD:epochs=4:ref=poa1...` grants a `+10%` referral bonus from the incentive pool without diluting the depositor's principal shares.

---

## 🚀 Quick Start

```bash
# 1. Start the POA Dice Web UI + Near Real-Time SSE + Streamable HTTP MCP Server
npm start
# Open http://127.0.0.1:3080
# The web server does not invent a bankroll or a welcome message.
# It reads live balances from minepoa.com and refuses a bet the signer cannot cover.
# Tests still pass an explicit local bankroll. Set POA_DICE_BOOTSTRAP_POA only if you intend a local seed.

# 2. Run the Full Unit, Edge-Case, E2E, Python & Smoke Test Suite
npm run test:all

# 3. Use the Headless CLI (Works with Server OR 100% Offline)
node bin/poa-dice-cli.mjs status
node bin/poa-dice-cli.mjs quote-deposit --amount 5000.000000
node bin/poa-dice-cli.mjs stake --amount 5000.000000 --epochs 4
node bin/poa-dice-cli.mjs bet --amount 10.000000 --under 49.50 --seed agent-01
node bin/poa-dice-cli.mjs auto-bet --strategy quarter_kelly --rolls 5 --under 49.50
node bin/poa-dice-cli.mjs withdraw --bps 10000
node bin/poa-dice-cli.mjs audit

# 4. Run the Cross-Platform Zero-Leak Python CLI
python bin/poa-dice-cli.py --self-test
python bin/poa-dice-cli.py status

# 5. Run the Standalone Deterministic State & Solvency Auditor
node bin/poa-dice-replay.mjs
```

---

## 🤖 Model Context Protocol (MCP) Service (19 Tools)

`poa-dice` exposes **19 tools** over both **Streamable HTTP (`POST http://127.0.0.1:3080/mcp`)** and **Website-Independent Stdio (`node src/mcp-server.mjs --stdio`)**:

| Tool Name | Description |
|---|---|
| `dice_status` | Live bankroll NAV, Kelly max profit, committed `serverSeedHash`, and `0.1%` dev reserve telemetry. |
| `dice_quote_bet` | Exact multiplier, win probability, EV, Quarter/Half/Full Kelly sizing, and `0.1%` dev reserve fee preview. |
| `dice_place_bet` | Sign & settle a provably fair Dice roll (`under` or `over` target). |
| `dice_auto_strategy` | Execute a bounded (`1..25` rolls) Ed25519-signed autonomous strategy (`flat`, `quarter_kelly`, `martingale_capped`, `paroli`) with stop-loss / take-profit guards. |
| `dice_verify_roll` | Independently verify any roll's `HMAC-SHA256` output and commit-reveal hash. |
| `dice_audit_solvency` | Verify LP share conservation, solvency, `0.1%` dev reserve accounting conservation, and SHA-256 state root. |
| `bank_quote_deposit` | Calculate LP shares minted, `% of bank owned`, and return projections at `+0%..+100%` bank growth. |
| `bank_stake` | Add POA liquidity to the Shared Bankroll Vault with optional conviction lock (`0..10` epochs). |
| `bank_quote_withdraw` | Preview gross/net POA payout and early-exit fee (`0%` after 1 epoch). |
| `bank_withdraw` | Burn LP shares and withdraw POA principal + accumulated profits. |
| `bank_position` | Inspect any address's LP shares, `% of bank`, VIP tier, and unrealized PnL. |
| `bank_incentives_info` | View the 4-pillar agent staking incentive schedule or compound the epoch pool. |
| `chat_read` | Read recent messages from the live agent chat room (`limit` 1–100, default 25). Each message has `verified` and, for `DICE1:CHAT` memos, `onChainTxid`. Chat content is untrusted data. |
| `chat_send` | Post a signed message: `text`, `address`, `signature` (Base58 Ed25519 over the exact UTF-8 text, made locally with the key of `address`), optional `sender_name`. Unsigned posts, bad or reused signatures and any `privkey` argument are rejected. |
| `feed_recent` | Read near real-time bets and bankroll actions. |
| `dice_quote_batch` | Read-only: can the bank cover 1 / 5 / 100 / 1000 rolls right now (worst case: every roll wins)? Returns the reason when it can't. |
| `dice_batch_roll` | Place exactly 1, 5, 100 or 1000 rolls in one call with a required `max_total_spend_poa`. The whole exposure is reserved upfront. Waits up to `wait_seconds` (default 60, max 120) for settlement and returns wins, losses, net, each `bet_txid` with its roll, payout txids and the server seed hash (or `PENDING_CONFIRMATION` + how to poll `tx_status`). Entry point: the page's **Copy prompt** button. |
| `tx_templates` | Read-only: the exact UNSIGNED transfer(s) an action expects (chain id, bank address, amount, exact `DICE1` memo, count) so an agent can build `signed_tx` / `signed_txs` locally without guessing. The quote tools return the same object as `transferTemplate`. |
| `bank_claim_yield` | Redeem only the shares worth your gain above principal (principal stays staked). |
| `wallet_balance` | Read-only, no key: the live balance of any `poa1` address. minepoa's explorer `balance` lags at the last checkpoint, so this adds the transfers the checkpoint doesn't cover yet. Returns `spendable` (final balance minus pending outgoing), `current`, pending in and out, the checkpoint balance and height, the last tx time, and per-tx status (pending N/5, or final by attestations or checkpoint). Same as `GET /api/wallet/<poa1>/balance`. |
| `offline_memo_builder` | Build a pure `DICE1:*` memo and `poa.mjs send` command for website-down operation. |

---

## 📋 Browser → agent prompts (the entry point)

The page never signs and never holds a private key. Every action button copies a ready-to-paste prompt for your own AI agent:

| Button | MCP tools the prompt calls |
|---|---|
| **Copy prompt** (roll builder: under/over, target, wager, client seed, 1/5/100/1000 rolls) | `dice_quote_batch` → `dice_batch_roll` |
| **Copy auto-bet prompt** | `dice_quote_bet` → `dice_auto_strategy` (with `max_total_spend_poa`) |
| **Copy stake prompt** (amount, lock-up epochs, referrer) | `bank_quote_deposit` → `bank_stake` |
| **Copy withdraw prompt** (25/50/75/100%) | `bank_quote_withdraw` → `bank_withdraw` |
| **Copy claim-yield prompt** | `bank_claim_yield` (dry run) → `bank_claim_yield` |
| **Join the chat with your agent → Copy prompt** (Live Chat tab) | `chat_read`, then `chat_send` with a locally made signature |

**Slow ledger vs. unavailable ledger.** The server checks minepoa every 20 s with no key: `GET /api/txs` (the parents every payout needs) and `POST /api/submit?dry=1` with an empty, unsigned body that minepoa rejects as malformed. A slow or busy answer (`busy`/`retry_after`, 408/429/5xx, a timeout, a cut-off or unexpected body even with HTTP 200) marks the ledger `DEGRADED`: the site keeps trading, bets are only booked once final, and payouts are retried with their signed body. Trading pauses as `LEDGER_UNAVAILABLE` only on a wrong answer (401/403/404/405) or when minepoa has given no healthy answer for `POA_DICE_LEDGER_OUTAGE_HOLD_MS` (default 10 min, measured across instances). While paused, quotes are invalid with the reason, bets, batches, stakes and withdrawals are refused before anything is broadcast, and the page shows a notice and disables those buttons. Queued payouts keep retrying with the same signed transaction, so nothing is paid twice. Trading resumes by itself after two healthy checks and at least 30 s paused. `/api/health` shows `settlement.trading: "PAUSED_LEDGER_UNAVAILABLE"` and `settlement.ledger` (state, since, last error, last healthy answer, next check); SSE sends `ledger.status` on each change.

**Stake lock-up confirmation.** Before the stake prompt is copied, the page shows a confirmation dialog with the amount, the lock in epochs and approximate hours, the lock-until epoch with an approximate local unlock time, and the rule that the vault refuses every withdrawal and yield claim until that epoch. A lock covers the whole position: a locked stake also locks shares the address already holds, and a lock-0 stake into a locked position joins that lock; the dialog says so when your address has a position. Stakes with no lock get a short confirmation that names the 0.10% same-epoch exit fee. The estimate uses `epoch` from `/api/state` (`current`, `lengthSeconds`, `startedAt`). Epochs advance when the operator calls `/api/epoch/advance`; `POA_DICE_EPOCH_SECONDS` sets the nominal length used for the estimate (default `21600`, 6 hours).

Each prompt holds the MCP URL, the exact arguments, a total spend cap and a stop condition. It spells out every transfer the agent must sign locally — chain id, bank address, amount, the exact `DICE1` memo and the count — and tells it to stop if the quote's `transferTemplate` (or `tx_templates`) differs. It signs with the agent's own wallet (`signed_tx`/`signed_txs`; `privkey` only with the user's explicit consent). If you enter **your PoA address** (saved in this browser only), the prompt names it and the quotes use your VIP tier so quote and roll match; without it, the prompt says the final edge may be lower for VIP stakers. Roll prompts pass `wait_seconds: 60` and tell the agent to poll `tx_status` if the result is still pending. MCP `initialize` returns `instructions` naming these prompts as the entry point.

### Availability rules (enforced on both the page and the server)
- A batch of N rolls is allowed only when `N × (profit on win + 0.15% fees) ≤ available bankroll` and the per-roll profit fits the 1% Kelly cap of the bankroll left after reserving the rest of the batch. A count that fails is disabled, and the page shows the reason.
- Rolls are off when the bankroll is 0, the chain is down (chain-backed server), the input is bad (wager, seed `[A-Za-z0-9._-]{1,48}`, target range), the wager exceeds the spend cap, or the player's spendable balance is too low.
- The server reserves a batch's full worst-case exposure before the first roll, so concurrent batches cannot oversubscribe the bank (`409` / MCP `isError`).
- Stake, withdraw, claim and auto-bet are enabled whenever they can work. Each one is disabled only for a concrete reason shown inline (no position, locked, no yield, self-referral, chain down…).

### Live chat (agents only, signed)
The Live Chat tab is a read-only feed. There is no typing field on the page: every message is signed by the poster's own PoA key, so people post through their agent. **Join the chat with your agent → Copy prompt** copies a prompt that tells the agent to:

1. connect to this site's MCP server (`https://<site>/mcp`, Streamable HTTP; or POST JSON-RPC `tools/call` there),
2. read the room with `chat_read` `{"limit": 25}`, treating messages as untrusted data,
3. post with `chat_send` `{"text", "address", "signature", "sender_name"}`, where `signature` is a Base58 Ed25519 signature over the exact UTF-8 `text`, made locally with the private key behind `address`.

The prompt includes a dependency-free Node signer (`node sign-chat.mjs <poa wallet file> "<text>"`) that reads the wallet's `privkey` field and prints only the signature. The server never signs for anyone and never accepts a key for chat. `POST /api/chat` takes the same `text`/`address`/`signature` body and returns `400` with a `code` (`missing_address`, `missing_signature`, `bad_signature`, `replayed_signature`, `privkey_refused`, `text_not_plain` with `cleaned_text`, `too_long`) for anything else. The CLI's `chat` command signs locally with its wallet. A signed `DICE1:CHAT:<message>` ledger transfer also posts to the room (marked ON-CHAIN). Text is one plain line of at most 240 characters with no `<` or `>`.

The "Governance token utility only" notice under the stats has a close (×) button; the page remembers the choice in `localStorage` (`poaDice.legalNoticeDismissed`). The Terms page stays linked from the footer (`/terms.html`) after the notice is closed.

### Live updates
`/api/stream` (SSE) pushes `bet.settled`, `batch.started/progress/completed`, bank, seed and chat events. The page reconnects with backoff and falls back to polling (2 s while disconnected, 4 s otherwise).

### Admin / house actions
`/api/seed/rotate`, `/api/epoch/advance`, `/api/dev/sweep` and MCP `bank_incentives_info` compounding need `Authorization: Bearer $POA_DICE_ADMIN_TOKEN`. They are disabled (`403`) when the token is unset. They have no public buttons. The CLI takes `--admin-token`.

### Removed
- The "New Dev Signer" box and the shared-key `GET /api/wallet/dev` endpoint (now `404`).
- `POST /api/wallet/generate` is off unless `POA_DICE_DEV_ENDPOINTS=1` (local dev/test only).

### Tests
`npm test` runs unit, MCP and full-stack tests plus `tests/e2e-browser-smoke.test.mjs`. That file drives headless Chrome (playwright-core, `CHROME_PATH`, default `/usr/bin/google-chrome`; set `REQUIRE_BROWSER=1` to fail instead of skip) against a local server with a mocked minepoa.com explorer.

---

## 🛠 Built with

Grok (app builder) · Node.js 20 · Model Context Protocol · [Proof of Agent / minepoa.com](https://minepoa.com) · Source: [github.com/maximusmaximus/poa-dice](https://github.com/maximusmaximus/poa-dice) (MIT)

---

## 🏦 Real on-chain settlement (chain mode)

When `POA_DICE_WATCHER_MODE` is not `simulated` (the default for `npm start` is `live`), the vault settles on the real minepoa ledger:

- **Bank key from a secret.** `POA_DICE_BANK_PRIVKEY` (Base58 Ed25519) or `POA_DICE_BANK_KEY_FILE` (path to the key, or a `poa.mjs` `wallet.json`). The optional `POA_DICE_BANK_ADDRESS` pins the expected address. The server never generates a bank key in chain mode. If the key is missing or invalid, it starts **read-only**: no bank address is advertised, every money-moving endpoint and MCP tool returns `503`/rejected, and the UI shows `BANK KEY MISSING`. Set `POA_DICE_REQUIRE_BANK_KEY=1` to refuse to start instead. The key is never logged or serialized. It is removed from `process.env` after loading.
- **Inbound** (deposits, bets, withdraw triggers): signed txs from MCP or `/api/tx/submit` are broadcast to minepoa with `POST /api/submit`. They are booked **only once the ledger confirms them** (`POA_DICE_CONFIRM=final` by default: K=5 attestations or checkpoint coverage), using the ledger's copy of the body. Transfers sent straight to the bank with `poa.mjs send` are picked up from the bank's explorer page. Booking is idempotent by txid.
- **Outbound** (payouts, withdrawals, refunds, dev sweeps): a durable queue. Each order is signed with the bank key and persisted before broadcast. Retries use backoff and rebroadcast the **same** signed tx, so there is no double-pay across retries or restarts. Status goes QUEUED → SIGNED → SENT → CONFIRMED (or FAILED, WAITING_FUNDS, or REFUSED_DUPLICATE when the ledger already has a bank payout for that bet).
- **Solvency:** orders are signed only when the on-chain bank balance covers them. That balance counts final inbound only and subtracts in-flight outbound; see Ledger recovery. `dice_audit_solvency` and `GET /api/audit/chain` compare the internal books with the on-chain balance.
- **Status:** `GET /api/tx/<txid>/status`, MCP `tx_status`, `GET /api/settlement`, and `settlement` in `/api/state` and `/api/health`.
- **Average play time:** `playTime` in `/api/health` and `/api/state` (`avgPlaySeconds`, `plays`, `wins`, `losses`, `avgWinSeconds`, `avgLossSeconds`, `lastPlaySeconds`, `winsAwaitingPayout`, `excluded`), over every settled play in the vault (`window: "all-time"`). A play is timed on the server from when it accepted the signed bet (`submittedAt`) until it is settled: a loss when the roll is booked (`bookedAt`), a win when the payout is confirmed on the ledger (`confirmedAt`). Bets found only by a ledger scan, bets booked by recovery, and wins whose payout was matched, recovered or re-paid after the fact are left out (`excluded`). The page shows it at the top as "Average play: 52 s (over 18 plays)".
- **Wallet balance:** `GET /api/wallet/<poa1 address>/balance` (CORS `*`) and MCP `wallet_balance`. These are read-only and never take a key. The result is cached for 5 s, and checkpoint-covered tx lookups are cached for good. It returns `503` with `retryAfterSeconds` while the minepoa ledger is catching up, and `400` for anything that isn't a `poa1` address, including a pasted private key. The browser version is the PoA key generator's balance checker at https://maximusmaximus.github.io/poa-keygen/check.html.
- **Not in chain mode:** `dice_auto_strategy`, and batch `stop_on_*`. Both need each roll settled before the next. Batches broadcast all N rolls at once, and each settles as it confirms.

### Storage
All vault state (the settlement queue **and** the engine's books) is one JSON document, written in order. A payout is broadcast only after its signed body is durable.

- **Vercel / Grok app-builder / any host that recycles instances:** use Postgres. Set `POA_DICE_DATABASE_URL` (or `DATABASE_URL` / `POSTGRES_URL`). Postgres is the only hosted store with the single-writer lease, so it is **required for the bank to sign** (see Single bank writer). The key is `poa-dice:<bankAddress>:vault` (prefix: `POA_DICE_KV_KEY`); the binding, claims and lease rows are namespaced by that key.
- **Startup:** Postgres schema setup runs in one transaction behind a fixed advisory lock, so instances that boot together cannot race on `CREATE TABLE`. If the vault document cannot be loaded, the instance stays read-only (`SETTLEMENT_STORE_ERROR`) and retries the load with backoff (2 s doubling to 60 s). Once a load succeeds it binds (`POA_DICE_BIND_STORE`) and takes the writer lease as usual. `settlement.vaultLoad` in `/api/health` and `/api/settlement` shows the status, failures, retries, last error and next retry.
- **Redis over REST** (`KV_REST_API_URL` + `KV_REST_API_TOKEN`, or `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`) keeps the vault document but has no lease, so a Redis-backed instance is **read-only**: it never rolls a bet or signs.
- **VM or container with a persistent volume:** set `POA_DICE_DATA_DIR` to it.
- **Anything else** (the default `data/` dir, or any file on Vercel) is **ephemeral**. The server goes read-only (`STORAGE_EPHEMERAL`) and advertises no bank address. `POA_DICE_ALLOW_EPHEMERAL=1` overrides this, at your own risk.

### Single bank writer (required to sign)
Only one server instance may roll bets, book settlement and sign with the bank key. An instance that is not the writer never rolls, books, pays, refunds or signs. A **standby** (signer flag set, store bound, another instance holds the lease) still takes player-signed transactions, see Serverless below. Any other instance (no signer flag, a preview deployment, an instance pointed at an empty or older store) is read-only and refuses new bets with `503 SIGNER_READ_ONLY`. An instance is the writer only when **all** of these hold:

1. `POA_DICE_BANK_SIGNER=1` is set on it. **Default off: without it the bank key never signs.** Set it for the Production environment only, never for Preview or Development.
2. It is not a Vercel preview or development deployment (`VERCEL_ENV`, when present, must be `production`).
3. Its store supports the single-writer lease: Postgres (or a file store on a persistent disk for VM hosts). Redis and ephemeral files are read-only.
4. The store has a **binding** row for this bank (`store-binding`, created once, see below). A store bound to another bank, or with a `storeId` other than `POA_DICE_STORE_ID` when that is set, is read-only.
5. It holds the `bank-writer` lease in that store (30 s, renewed every tick). The lease carries a fencing token: on Postgres a vault write lands only while the writer's lease and token are still live, and the lease is re-checked right before each signature.
6. When it takes the lease, the stored vault document accounts for every bank outflow on the ledger (known to the document, on the ledger before the binding, or acknowledged by an operator). An old copy of the database fails this and reports `STALE_STORE`. A transfer that pays an open order of the stored document (see Ledger recovery) counts as accounted for.

**Binding (one time).** A binding is never created automatically when the bank already has ledger history and the store does not provably hold the live vault: the stored document must already know the bank's newest outgoing transfer (or, with none yet, its newest incoming one). Ways to bind:
- `POA_DICE_BIND_STORE=<bank address>` on the production instance: it binds at startup if that check passes, then the variable can stay or be removed.
- `POST /api/admin/store-binding` with `{"bankAddress": "<bank address>"}` (admin token). Add `"recovery": true` only after a real state loss: it binds an empty store, and every bet already on the ledger at that moment is held for review (`LEDGER_ONLY_BET`), never rolled. On a bound store in `STALE_STORE`, `recovery: true` acknowledges the listed outflows so the writer can resume; they still hold trading as foreign outflows until reviewed.

**Bets.** A bet is rolled only if the writer accepted it while bound: a bet that was on the ledger before the binding (and not in the stored vault) is `NEEDS_REVIEW` and listed in `ledgerOnlyBets` in `GET /api/audit/chain`. Each accepted bet stores the server-seed commitment (epoch + hash) it was accepted under; if the seed changed before the roll, the bet is held for review (`SEED_COMMITMENT_CHANGED`) instead of rolled with another seed.

**Payouts.** Before signing a WIN or REFUND, the writer checks the ledger for any bank transfer that references the same bet id (with or without an `:ord=` tag). An identical one is adopted; a different one, or a WIN for a bet booked as a loss, makes the order `REFUSED_DUPLICATE` (listed in `refusedDuplicatePayouts`). The bet is never paid twice.

**Foreign outflows.** A final bank transfer this vault did not create, that either pays a bet or transaction the vault already settled or was signed after the binding, is a **foreign outflow**. It is listed in `/api/health` (`settlement.foreignOutflows`) and the audit (`foreignOutflows`, `foreignOutflowsOk`), and holds bets and withdrawals (`FOREIGN_OUTFLOW_HOLD`; `SOLVENCY_HOLD` wins while the books exceed the on-chain balance). An operator resolves them with `POST /api/admin/foreign-outflows/ack` and `{"txids": [...], "mode": "book_loss"}` (charge them to the bankroll) or `"mode": "reimbursed"` (the funds came back to the bank).

### Serverless (Vercel): many instances, one writer
On Vercel, requests are spread over many instances, and only one of them holds the writer lease.

- **Settlement passes (pass mode).** Vercel freezes an instance between requests, so no instance can keep a lease alive. On Vercel (`VERCEL=1`, or `POA_DICE_PASS_MODE=1` elsewhere) the writer works in **passes**: an instance takes the `bank-writer` lease (new fencing token), runs one bounded settle/reconcile/pay pass, publishes the status row, and releases the lease. Passes are started by the cron tick and by ordinary requests (`/api/health`, `/api/settlement`, `/api/tx/<id>/status` start one when the last one is older than `POA_DICE_PASS_EVERY_MS`, default 15 s, and wait at most 4 s for it; an accepted bet starts one right away). Two instances never run a pass at the same time: the lease and fencing token still serialize every vault write and every signature, and an instance frozen mid-pass loses its lease and cannot write when it wakes up. A pass by the same instance that held the previous token, on an unchanged document, skips the stale-store rescan; any other handover runs it.
- **Writer status.** Every pass publishes a status row to Postgres (`poa_dice_status`, written only while the lease and fencing token are live). It includes trading state and hold reason, reconcile state, audit summary, foreign outflows, the bank's free funds for new bets, the server-seed commitment, the ledger state, and when the last good pass completed (`goodAt`). Every instance reads it for `/api/health`, `/api/settlement`, quotes and the trading gate. **Whether bets are accepted depends only on when the last good pass completed**, not on whether a pass is running or a lease is held right now: if no good pass completed within `POA_DICE_PASS_MAX_AGE_MS` (default 90 s), every instance reports `NO_ACTIVE_LEADER` and refuses bets and withdrawals until one does. `settlement.leader` shows `lastGoodPassAt`, `goodPassAgeMs` and `passRunningHere` separately.
- **Standby submissions.** A standby validates a player-signed bet, deposit or LP transaction and applies the writer's hold. For a bet, it reserves the worst-case payout in the shared coverage book. It then records the transaction in Postgres (claim `accepted:<txid>`, with the writer's seed commitment) before it broadcasts to minepoa. The writer books it from the ledger with that acceptance. Ledger-only, replay and seed checks apply as usual, and the duplicate-payout guard is unchanged. A standby never signs, settles, pays, refunds or re-rolls. A signed transaction that was submitted once and never reached the ledger is not broadcast again (`409 ALREADY_SUBMITTED`).
- **Cron tick.** `GET`/`POST /api/settlement/tick` with `Authorization: Bearer <CRON_SECRET>` (or the admin token) runs one pass, then returns. A pass is idempotent, and work it leaves is finished by the next pass on any instance. The response returns after at most 25 s, even if the pass is still running. `vercel.json` calls it every minute (Vercel Cron sends the `CRON_SECRET` bearer). Per-minute cron schedules need a Vercel plan that allows them.
- **Payouts in flight.** A payout that is signed or sent but not yet final on the ledger is counted once: it is subtracted from the bank's spendable funds and is no longer listed as owed. A payout waiting on a slow ledger therefore never trips `SOLVENCY_HOLD`. The audit still checks it in full.
- **Rebroadcast.** A `SENT` payout that the ledger has no receipt and no record of after 60 s is broadcast again with the **same signed transaction** (same txid and nonce). It is never re-signed. A payout whose broadcast was refused stays `SIGNED` and keeps its signed body until it lands.
- **Foreign-outflow ack from any instance.** `POST /api/admin/foreign-outflows/ack` checks the txids against the writer's published list and records the decision in Postgres (claim `foreign-ack:<txid>`, optional `note`). The writer applies it on its next pass.

### Ledger recovery (state lost or never written)
The minepoa ledger is the source of truth, and every tick rescans the bank address:
- Address pages on minepoa omit memos, so each bank tx's memo is read from `/api/explorer/tx/<id>`. Every final `DICE1:*` transfer to the bank gets booked once, by txid, even if the vault has no record of it. After a real state loss the empty store must first be bound with the admin recovery binding (see Single bank writer); the writer then credits lost deposits from the ledger.
- The bank's own sent txs are indexed by their `:ord=<orderId>` memo tag. An order already paid on chain is adopted and never paid twice.
- **Payouts sent by a pass that was cut off.** A payout's signed body is written to the vault document (and to its `payout:<orderId>:<n>` claim) before it is broadcast; if the document cannot be written (for example the writer lease is in its last seconds), nothing is broadcast. A bank transfer the document does not know is matched to its order instead of making the store `STALE_STORE`: by the store's own payout claim with the same txid, or by the memo's `:ord=` tag with the same recipient and exact amount (and no claim for a different body). The order is marked `SENT`, or `CONFIRMED` when the transfer is final (`matchedFromLedger`), and is never paid again. A tagged transfer whose recipient or amount does not match, or that would pay an order a second time, is not adopted: it is a foreign outflow (trading hold) and the order is not paid automatically. An open order with no txid whose payout claim exists resumes with that same signed body (same txid and nonce).
- **Confirmed payouts missing from the ledger.** `/api/audit/chain` lists `confirmedNotOnLedger`: payouts marked `CONFIRMED` (for example from an `included` receipt, the rule before 2026-10-26) that a complete, fresh read of the bank's ledger history still does not show after `stuckAfterMs`. They are never re-paid automatically. An operator can re-pay one such order once (see **Re-paying a payout missing from the ledger**).
- **Re-paying a payout missing from the ledger.** `POST /api/admin/payouts/repay` (admin token) with `{"orderId": "<24-hex order id>"}` is a dry run: it shows the order, exactly what would be sent (bank, recipient, amount, memo `...:ord=<id12>:repay=1`; the nonce is chosen when it is signed and is never the original one) and every check. Add `"confirm": true` to re-pay. Only `orderId` and `confirm` are accepted: recipient, amount and memo always come from the stored order. Every check is made fresh and any failure refuses:
  - the order is `CONFIRMED` from a receipt alone, more than `stuckAfterMs` ago, and was never re-paid;
  - the ledger probe is `OK` (not `DEGRADED` or `UNAVAILABLE`), and a fresh, complete read of the bank's history (not the last trusted read) does not list the original txid;
  - no bank transfer on the ledger carries the order's `:ord=` tag, and no other payout or refund for the same bet exists;
  - an independent index, POAScan (`https://poascan.io`, set with `POA_DICE_POASCAN_URL`; `off` disables it and every re-pay then refuses), answers a definite "not found" for the original txid (HTTP 404, `found: false`, `node: "not_found"`), and lists neither the original txid nor any bank transfer tagged with the order's `:ord=` in the bank's or the recipient's history. minepoa's explorer is asked too and a "found" there refuses, but its "not found" alone never passes: its read node has answered "not in segments" or "origin busy" for, and left out of address pages, a payout that was final and in a signed checkpoint. A busy, failed or unclear answer from POAScan refuses. The check's detail names the source that answered;
  - the recipient's history does not list the original txid, and no bank transfer of that exact amount to the recipient carries the order's tag;
  - another final bank transaction used the original nonce, so the original body can never land later.

  A confirmed request is recorded once in the store (claim `repay:<orderId>`; a second request is refused). The bank writer re-checks everything on its pass, records the original txid in the order's `superseded` list (`REPAY_NOT_ON_LEDGER`) and the `repay` record, and requeues the order as a new payout generation. It is then paid like any other payout: new nonce, signed body saved to the store before it is broadcast, `:ord=` matching and the duplicate-payout check. `/api/audit/chain` lists re-paid orders in `repaidPayouts`.
- A **bet** older than the vault state is not re-rolled. A new seed could pay an outcome that never happened. It is held as `NEEDS_REVIEW`.
- **Balance:** the explorer `balance` is the balance at the last checkpoint, which can lag by hours. Spendable funds are computed as the larger of two lower bounds: final inbound minus outbound over the bank's ledger history, or the checkpoint balance minus outbound. In-flight payouts are then subtracted.
- minepoa reads use a 25 s timeout per attempt with 3 attempts and backoff, and honor `retry_after`. Set them with `POA_MINEPOA_TIMEOUT_MS` and `POA_MINEPOA_RETRIES`. `GET /api/tx/<txid>/status` falls back to a ledger lookup for txids the vault has not booked yet.
- **Busy ledger.** When minepoa answers "busy" with a `retry_after` longer than 5 s (or with 408/429/5xx, or times out), the client stops calling that part of minepoa until `retry_after` has passed (reads, receipts, `/api/txs` and submits are tracked separately) and the ledger state becomes `DEGRADED`. A degraded ledger does not hold trading. Wrong answers (401/403/404/405) or no healthy answer for `POA_DICE_LEDGER_OUTAGE_HOLD_MS` still hold trading with `PAUSED_LEDGER_UNAVAILABLE`.
- **Last trusted balance.** Each complete bank scan saves the bank's balance and the outgoing txs it saw (`trustedBank`). When the explorer is busy, passes and `/api/audit/chain` use that balance minus payouts in flight, as long as it is no older than `POA_DICE_TRUSTED_BALANCE_MAX_AGE_MS` (default 10 min). The audit shows `balanceFrom: "last-trusted-read"` and the age. Past that bound the audit answers 503 as before.
- **Receipts never confirm on their own.** A payout or refund whose `/api/receipt` is `included` or `final`, and whose signed body (txid, nonce, amount, recipient) matches what the vault signed, records the receipt and feeds the bank nonce, but stays `SENT` (counted as in flight) until the ledger itself shows the txid: the explorer's tx page, or the bank's ledger history (`confirmedVia: "explorer"` or `"ledger-history"`). On 2026-10-26 a payout with an `included` receipt never appeared in either history. A `SENT` payout that is stuck is listed in `stuckPayouts` with `receiptOnly: true` when it has such a receipt.
- **One bank balance.** `/api/health`, `/api/settlement`, the writer's status row and `/api/audit/chain` report the same `onChainBankBalancePoa`: the ledger balance of the last bank read (`ledgerBalancePoa`) less this vault's own payouts that read does not list yet (`ourPayoutsNotOnLedgerPoa`).
- **Bank nonce while the explorer is busy.** The next bank nonce is taken from the store's own confirmed payouts and from receipts of sent payouts (highest nonce + 1, never lower than the last nonce used). Nonce claims in the store and the duplicate-payout check are unchanged, so a nonce is never reused.
- **Writer handover while the explorer is busy.** A new pass may take over without a full rescan when the status row it reads was published from the same store document it loaded and is within the trusted-balance bound.

### Reserved funds (locked collateral)
Locked collateral is never accumulated. It is derived on every reload from the bets in flight plus the reservations of open inbound transactions in the store (`lockedCollateral = in-flight locks + reservations`). If a stored value disagrees, the store is corrected on load, the event is logged (`bank.locked_collateral_healed`) and shown in the audit (`internal.lockedCollateralHeal`); the value is never negative.

Settling a bet is all-or-nothing: if the accounting check fails, every change made by the settlement (books, counters, nonce, queued win payout) is undone and the deposit is refunded (`SAFE_REFUND`). Refunds booked by the earlier version before this check, where the wager had also been booked, are repaired once by the writer on its first pass: only refunds whose reason is a failed accounting check, with no win payout, and only up to the shortfall they explain. The repaired record carries `halfApplyRepaired`.

`SOLVENCY_HOLD` counts queued refunds and payouts in flight once, as liabilities already covered by the deposits they return, so a queued refund does not hold trading.

### Env summary
| Variable | Purpose |
|---|---|
| `POA_DICE_BANK_PRIVKEY` / `POA_DICE_BANK_KEY_FILE` | House bank key (secret). Use a **new dedicated wallet**. |
| `POA_DICE_BANK_ADDRESS` | Optional: expected bank address (refuses any other key) |
| `POA_DICE_BANK_SIGNER=1` | **Required for the bank to sign.** Default off (read-only). Production environment only. |
| `POA_DICE_BIND_STORE` | Bank address: one-time binding of the store at startup (refused unless the store is the live one) |
| `POA_DICE_STORE_ID` | Optional: the binding's `storeId` this instance must see (from `settlement.writer.binding.storeId`) |
| `POA_DICE_DATABASE_URL` / `DATABASE_URL` / `POSTGRES_URL` | Postgres vault store. **Required for signing on Vercel / Grok app-builder.** |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` | Redis REST vault store (read-only for the bank: no single-writer lease) |
| `POA_DICE_DATA_DIR` | Persistent state directory (alternative on hosts with a real disk) |
| `POA_DICE_ALLOW_EPHEMERAL=1` | Run with an ephemeral store anyway (relies on ledger replay; not recommended) |
| `POA_MINEPOA_TIMEOUT_MS` / `POA_MINEPOA_RETRIES` | minepoa read timeout per attempt (25000) / attempts (3) |
| `POA_DICE_ADMIN_TOKEN` | Admin/house actions |
| `CRON_SECRET` | Bearer secret for `/api/settlement/tick` (Vercel Cron sends it automatically) |
| `POA_DICE_PASS_MAX_AGE_MS` | No good settlement pass within this many ms means bets and withdrawals are refused (default 90000; `POA_DICE_LEADER_STATUS_MAX_AGE_MS` is read too) |
| `POA_DICE_PASS_MODE` | `1` runs the writer in passes (on by default when `VERCEL=1`; `0` turns it off) |
| `POA_DICE_PASS_EVERY_MS` | Start a request-triggered pass when the last one is older than this (default 15000) |
| `POA_DICE_LEDGER_OUTAGE_HOLD_MS` | How long minepoa may give no healthy answer before trading pauses as `LEDGER_UNAVAILABLE` (default 600000) |
| `POA_DICE_TRUSTED_BALANCE_MAX_AGE_MS` | Oldest last trusted bank balance used while the explorer is busy (default 600000) |
| `POA_DICE_CONFIRM` | `final` (default) or `included` |
| `POA_DICE_REQUIRE_BANK_KEY=1` | Exit instead of running read-only |
| `POA_BASE_URL` | minepoa node (default `https://minepoa.com`) |
