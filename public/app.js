// @ts-nocheck
/**
 * POA Dice — Interactive Frontend Controller (public/app.js)
 *
 * Features:
 *  - Bidirectional Dice Slider (Target <-> Win Chance <-> Multiplier <-> Profit <-> Kelly Max)
 *  - Client-side Ed25519 self-custody wallet persistence in sessionStorage + signed transaction execution
 *  - Shared Bankroll Vault Deposit & Withdrawal calculators with exact LP share math & growth projections
 *  - 0.1% Reserved Dev Earnings telemetry & instant sweep to poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U
 *  - Near Real-Time SSE stream (/api/stream) updating bets, stakers, bankroll NAV, and verified chat
 *  - Offline / Website-Down pure DICE1:* memo command generator
 */

const state = {
  direction: 'under', // 'under' | 'over'
  targetBps: 4950,    // 100..9899
  wagerPoa: '10.000000',
  clientSeed: 'tessellate-agent-seed-01',
  withdrawBps: 10000,
  wallet: null,       // { address, pubkey }
  _demoPrivkey: null,
  summary: null,
  lastBetQuote: null,
  recentBets: [],
  chatMessages: [],
  stakers: [],
  sseConnected: false,
  rollAnimating: false,
  hasRolled: false,
  rollAnimFrame: 0,
};

const $ = (id) => document.getElementById(id) || document.createElement('div');

function api(path) {
  if (typeof window === 'undefined') return path;
  const host = window.location.hostname.toLowerCase();
  const previewHosts = new Set(['preview.grok.genai.mil', 'preview.grok.mil', 'preview.grokgsac.com']);
  if (!previewHosts.has(host)) return path;
  const match = window.location.pathname.match(/^\/hds-[a-z0-9]+-\d+-[a-z0-9]+/i);
  return match ? match[0] + path : path;
}

function shortAddr(addr) {
  if (!addr || addr.length < 18) return addr || 'poa1...';
  return `${addr.slice(0, 9)}...${addr.slice(-5)}`;
}

function formatNum(poaStr, decimals = 4) {
  const num = Number(poaStr || 0);
  if (!Number.isFinite(num)) return '0.0000';
  return num.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Wallet Management ───────────────────────────────────────────────────────

async function initWallet(forceNew = false) {
  const cacheKey = 'poa_dice_dev_wallet';
  try {
    const res = await fetch(api('/api/wallet/dev'), {
      method: forceNew ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: forceNew ? JSON.stringify({ rotate: true }) : undefined,
    });
    const data = await res.json();
    if (data && data.address && data.privkey) {
      state.wallet = { address: data.address, pubkey: data.pubkey };
      state._demoPrivkey = data.privkey;
      try {
        localStorage.setItem(
          cacheKey,
          JSON.stringify({
            address: data.address,
            pubkey: data.pubkey,
            _priv: data.privkey,
            source: data.source || 'dev-store',
          })
        );
      } catch {
        // Ignore storage error
      }
      renderWalletHeader(data.source || 'dev-store');
      return;
    }
  } catch {
    // Fall through to the last key this browser already pulled from dev.
  }

  try {
    const saved = localStorage.getItem(cacheKey) || sessionStorage.getItem('poa_dice_session_wallet');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && parsed.address && parsed._priv) {
        state.wallet = { address: parsed.address, pubkey: parsed.pubkey };
        state._demoPrivkey = parsed._priv;
        renderWalletHeader(parsed.source || 'local-cache');
        return;
      }
    }
  } catch {
    // Ignore storage error
  }
  if ($('activeWalletAddr')) {
    $('activeWalletAddr').textContent = 'Offline Mode (Use Local ~/.poa/key CLI)';
  }
}

function renderWalletHeader(source) {
  if (!state.wallet) return;
  const el = document.getElementById('activeWalletAddr');
  if (!el) return;
  el.textContent = shortAddr(state.wallet.address);
  const label =
    source === 'env'
      ? 'loaded from dev env'
      : source === 'dev-store'
        ? 'loaded from dev key store'
        : source === 'generated'
          ? 'new key saved to dev store'
          : 'cached signer';
  el.title = `Ed25519 self-custody address (${label}): ${state.wallet.address}`;
  const header = document.querySelector('.wallet-header .metric-label');
  if (header) {
    header.textContent =
      source === 'env' ? 'DEV ENV SIGNER' : source === 'generated' ? 'NEW DEV SIGNER' : 'DEV STORE SIGNER';
  }
}

// ─── Slider & Visual Track Sync ──────────────────────────────────────────────

function updateSliderVisuals() {
  const pct = (state.targetBps / 100).toFixed(2);
  const track = $('sliderTrackVisual');
  if (state.direction === 'under') {
    track.style.background = `linear-gradient(90deg, rgba(16, 185, 129, 0.88) 0%, rgba(16, 185, 129, 0.88) ${pct}%, rgba(244, 63, 94, 0.78) ${pct}%, rgba(244, 63, 94, 0.78) 100%)`;
  } else {
    track.style.background = `linear-gradient(90deg, rgba(244, 63, 94, 0.78) 0%, rgba(244, 63, 94, 0.78) ${pct}%, rgba(16, 185, 129, 0.88) ${pct}%, rgba(16, 185, 129, 0.88) 100%)`;
  }

  $('directionText').textContent = state.direction === 'under' ? 'Roll Under' : 'Roll Over';
  $('thresholdBadge').textContent =
    state.direction === 'under'
      ? `ROLL UNDER ${pct} TO WIN`
      : `ROLL OVER ${pct} TO WIN`;

  if (!state.rollAnimating && !state.hasRolled) {
    const digits = $('rollDigits');
    digits.textContent = pct;
    digits.className = 'roll-digits';
    $('rollStatusLabel').textContent = 'TARGET SET — SIGN & ROLL';
  }

  const winBps = state.direction === 'under' ? state.targetBps : 9999 - state.targetBps;
  $('targetInput').value = (state.targetBps / 100).toFixed(2);
  $('winChanceInput').value = (winBps / 100).toFixed(2);
  $('diceSlider').value = String(state.targetBps);

  updateOfflineCommandPreview();
}

function updateOfflineCommandPreview() {
  const bankAddr = state.summary?.bankAddress || 'poa1...';
  $('bannerBankAddr').textContent = bankAddr;
  const clientSeed = ($('clientSeedInput').value || 'client-seed-1').replace(/[^a-zA-Z0-9._-]/g, '');
  const wager = $('wagerInput').value || '10.000000';
  const memo = `DICE1:BET:${state.direction}:${state.targetBps}:${clientSeed}`;
  $('lastSignedMemoText').textContent = memo;
  $('liveOfflineCommand').textContent =
    `node poa.mjs send --node https://minepoa.com --wallet ~/.poa --to ${bankAddr} --amount ${wager} --memo "${memo}"`;
}

// ─── Quotes & Bankroll Telemetry ─────────────────────────────────────────────

async function fetchState() {
  try {
    const addr = state.wallet?.address || '';
    const res = await fetch(api(`/api/state?address=${encodeURIComponent(addr)}`));
    const data = await res.json();
    if (data && data.bankroll) {
      applyStateSnapshot(data);
    }
  } catch {
    // Offline fallback handled gracefully
  }
}

function applyStateSnapshot(data) {
  state.summary = data;
  const b = data.bankroll;
  if (b) {
    $('topBankNav').textContent = `${formatNum(b.bankNavPoa, 4)} POA`;
    $('topBankAvail').textContent = `${formatNum(b.availableBankrollPoa, 4)} POA`;
    $('topKellyMax').textContent = `${formatNum(b.kellyMaxProfitPoa, 4)} POA`;
  }
  const chain = data.chain;
  $('topBankChain').textContent = chain?.bank?.balance ? `Chain ${chain.bank.balance} POA` : 'Chain unavailable';
  if (chain?.dev?.balance) {
    $('topDevChain').textContent = `Chain ${chain.dev.balance} POA`;
    $('topDevChain').title = `Live minepoa.com balance of ${chain.dev.address}. This is not vault fee accrual.`;
  } else if ($('topDevChain')) {
    $('topDevChain').textContent = 'Chain unavailable';
  }
  if ($('chainBalanceText')) {
    $('chainBalanceText').textContent = chain?.player?.spendable
      ? `Spendable ${chain.player.spendable} POA`
      : 'Chain balance unavailable';
  }
  const sse = $('sseStatusText');
  if (sse && chain) {
    sse.textContent = chain.ok ? (state.sseConnected ? 'CHAIN LIVE' : 'CHAIN') : 'CHAIN DOWN';
  }

  if (data.devReserve) {
    const devAddr = data.devReserve.address;
    $('topDevAddrShort').textContent = shortAddr(devAddr);
    $('topDevAddrShort').title = `${devAddr} (0.1% / 10 bps reserved earnings)`;
    $('topDevAccrued').textContent = `${formatNum(data.devReserve.accruedUnpaidPoa, 6)} POA`;
  }

  if (data.incentives) {
    $('incentivePoolBalText').textContent = `${formatNum(data.incentives.poolBalancePoa, 6)} POA`;
    $('currentEpochText').textContent = `E${data.currentEpoch}`;
  }

  if (data.provablyFair) {
    const h = data.provablyFair.serverSeedHash;
    if (h) {
      $('seedHashShort').textContent = `${h.slice(0, 10)}...${h.slice(-8)}`;
      $('seedHashShort').title = `Committed Server Seed SHA-256: ${h}`;
      if (!$('verifyServerSeedHash').value) {
        $('verifyServerSeedHash').value = h;
      }
    }
  }

  if (Array.isArray(data.stakersLeaderboard)) {
    state.stakers = data.stakersLeaderboard;
    renderStakersTable();
  }
  renderUserLpPosition(data.userPosition);

  if (Array.isArray(data.recentBets)) {
    state.recentBets = data.recentBets;
    renderLiveBetsTable();
  }
  if (Array.isArray(data.recentChat)) {
    state.chatMessages = [...data.recentChat].reverse();
    renderChatMessages();
  }

  updateOfflineCommandPreview();
}

async function fetchBetQuote() {
  const amountPoa = $('wagerInput').value || '10.000000';
  const address = state.wallet?.address || '';
  const alertEl = $('betErrorAlert');

  try {
    const qs = new URLSearchParams({
      amountPoa,
      targetBps: String(state.targetBps),
      direction: state.direction,
      address,
    });
    const res = await fetch(api(`/api/quote/bet?${qs.toString()}`));
    const q = await res.json();
    state.lastBetQuote = q;

    $('multiplierDisplay').textContent = q.multiplierDisplay || '--';
    $('profitOnWinDisplay').textContent = `+${formatNum(q.profitOnWinPoa, 6)} POA`;
    $('maxWagerHint').textContent = `Max: ${formatNum(q.maxAllowedWagerPoa, 2)} POA`;
    $('edgeHintBadge').textContent = `${q.houseEdgePercent}% Edge`;
    $('walletVipBadge').textContent = `${q.vipTierName} (${q.houseEdgePercent}% Edge)`;
    const qKelly = q.kellySizing?.quarterKellyPoa ? ` • 1/4 Kelly: ${formatNum(q.kellySizing.quarterKellyPoa, 2)} POA` : '';
    $('payoutPreviewText').textContent =
      `Payout: ${formatNum(q.payoutOnWinPoa, 4)} POA • EV: ${q.expectedValuePoa || '-0.100000'} POA • 0.1% Dev: ${q.devReserveFeePoa} POA${qKelly}`;

    if (!q.valid) {
      alertEl.textContent = `⚠️ ${q.error}`;
      alertEl.classList.remove('hidden');
    } else if (state.summary?.chain?.ok && state.summary.chain.player?.spendable != null && Number(state.summary.chain.player.spendable) < Number(amountPoa)) {
      alertEl.textContent = `On-chain spendable is ${state.summary.chain.player.spendable} POA. This key cannot cover ${amountPoa} POA.`;
      alertEl.classList.remove('hidden');
    } else {
      alertEl.classList.add('hidden');
    }
  } catch {
    // Offline fallback math
    const winBps = state.direction === 'under' ? state.targetBps : 9999 - state.targetBps;
    const mult = (9900 / winBps).toFixed(4);
    const wager = Number(amountPoa) || 0;
    const payout = wager * Number(mult);
    const profit = Math.max(0, payout - wager);
    $('multiplierDisplay').textContent = `${mult}x`;
    $('profitOnWinDisplay').textContent = `+${profit.toFixed(6)} POA`;
  }
}

async function fetchDepositQuote() {
  const amountPoa = $('depositAmountInput').value || '1000.000000';
  const lockEpochs = Number($('lockEpochsInput').value || 0);
  const boost = (1 + Math.min(lockEpochs, 10) * 0.05).toFixed(2);
  $('convictionBoostPreview').textContent = `${lockEpochs} Epochs = ${boost}x Yield Weight`;

  try {
    const qs = new URLSearchParams({
      amountPoa,
      lockEpochs: String(lockEpochs),
      address: state.wallet?.address || '',
    });
    const res = await fetch(api(`/api/quote/deposit?${qs.toString()}`));
    const q = await res.json();
    if (!q.valid) return;
    $('quoteSharesMinted').textContent = Number(q.sharesMinted).toLocaleString('en-US');
    $('quoteBankPercent').textContent = `${q.shareOfLpPoolPercent}% of Bank`;
    $('quoteVipUnlocked').textContent = `${q.unlockedVipTier.name} (${q.unlockedVipTier.houseEdgePercent}% Dice Edge)`;

    const tbody = $('depositProjectionsBody');
    tbody.innerHTML = (q.projections || [])
      .map(
        (p) => `
        <tr>
          <td>+${p.bankrollGrowthPercent}% Bank Growth</td>
          <td class="highlight-cyan">${formatNum(p.projectedPositionValuePoa, 4)} POA</td>
          <td class="highlight-emerald">+${formatNum(p.projectedNetProfitPoa, 4)} POA</td>
        </tr>
      `
      )
      .join('');
  } catch {
    // Ignore when offline
  }
}

async function fetchWithdrawQuote() {
  if (!state.wallet?.address) return;
  try {
    const qs = new URLSearchParams({
      address: state.wallet.address,
      mode: state.withdrawBps === 10000 ? 'ALL' : 'BPS',
      bpsToRedeem: String(state.withdrawBps),
    });
    const res = await fetch(api(`/api/quote/withdraw?${qs.toString()}`));
    const q = await res.json();
    if (!q.valid) {
      $('withdrawQuoteShares').textContent = '0 (No Active Position)';
      $('withdrawQuoteGross').textContent = '0.000000 POA';
      $('withdrawQuoteFee').textContent = '0.000000 POA (0 bps)';
      $('withdrawQuoteNet').textContent = '0.000000 POA';
      return;
    }
    $('withdrawQuoteShares').textContent = Number(q.sharesRedeemed).toLocaleString('en-US');
    $('withdrawQuoteGross').textContent = `${formatNum(q.grossValuePoa, 6)} POA`;
    $('withdrawQuoteFee').textContent = `${formatNum(q.earlyExitFeePoa, 6)} POA (${q.earlyExitFeeBps} bps)`;
    $('withdrawQuoteNet').textContent = `${formatNum(q.netPayoutPoa, 6)} POA`;
    const statusEl = $('withdrawQuoteStatus');
    statusEl.textContent = q.instant ? 'INSTANT' : 'QUEUED (FIFO)';
    statusEl.className = `badge ${q.instant ? 'badge-emerald' : 'badge-vip'}`;
  } catch {
    // Ignore offline
  }
}

async function refreshAllQuotes() {
  await Promise.all([fetchBetQuote(), fetchDepositQuote(), fetchWithdrawQuote()]);
}

// ─── Render Tables & Lists ───────────────────────────────────────────────────

function renderUserLpPosition(pos) {
  if (!pos || !pos.hasPosition) {
    $('userSharePct').textContent = '0.0000%';
    $('userRedeemablePoa').textContent = '0.000000 POA';
    $('userNetPnlPoa').textContent = '0.000000 POA';
    $('userConvictionBadge').textContent = 'Conviction: 1.00x';
    return;
  }
  $('userSharePct').textContent = `${pos.shareOfLpPoolPercent}%`;
  $('userRedeemablePoa').textContent = `${formatNum(pos.currentValuePoa, 6)} POA`;
  const pnlNum = Number(pos.netPnlPoa || 0);
  $('userNetPnlPoa').textContent = `${pnlNum >= 0 ? '+' : ''}${formatNum(pos.netPnlPoa, 6)} POA`;
  $('userNetPnlPoa').className = `lp-pos-val ${pnlNum >= 0 ? 'highlight-emerald' : 'highlight-crimson'}`;
  $('userConvictionBadge').textContent = `Conviction: ${pos.convictionMultiplier} (${pos.vipTier?.tierName || 'Standard'})`;
}

function renderStakersTable() {
  $('stakersCountBadge').textContent = `${state.stakers.length} Staker${state.stakers.length === 1 ? '' : 's'}`;
  const tbody = $('stakersTableBody');
  if (state.stakers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4">No deposits yet. The vault only counts signed deposits.</td></tr>';
    return;
  }
  tbody.innerHTML = state.stakers
    .map((s) => {
      const isMe = s.address === state.wallet?.address;
      return `
        <tr>
          <td title="${escapeHtml(s.address)}">
            <code>${escapeHtml(shortAddr(s.address))}</code>
            ${isMe ? '<span class="badge badge-cyan">YOU</span>' : ''}
          </td>
          <td class="highlight-cyan"><strong>${escapeHtml(s.shareOfLpPoolPercent)}%</strong></td>
          <td class="highlight-emerald">${formatNum(s.currentValuePoa, 4)} POA</td>
          <td>${escapeHtml(s.convictionMultiplier)} &bull; ${escapeHtml(s.vipTier?.tierName || 'Standard')}</td>
        </tr>
      `;
    })
    .join('');
}

function sigShort(sig) {
  if (!sig || typeof sig !== 'string') return '';
  if (sig.length <= 16) return sig;
  return `${sig.slice(0, 8)}…${sig.slice(-6)}`;
}

function upsertBet(bet) {
  if (!bet || !bet.betTxid) return;
  const idx = state.recentBets.findIndex((b) => b.betTxid === bet.betTxid);
  if (idx === -1) state.recentBets.unshift(bet);
  else state.recentBets[idx] = { ...state.recentBets[idx], ...bet };
}

function renderInlineHistory() {
  const list = $('inlineRollHistory');
  const count = $('inlineHistoryCount');
  if (!list) return;
  const bets = state.recentBets.filter((b) => b && b.rollDisplay).slice(0, 8);
  if (count) count.textContent = String(state.recentBets.filter((b) => b && b.rollDisplay).length);
  if (state.rollAnimating) return;
  if (bets.length === 0) {
    list.innerHTML = '<li class="roll-card roll-card-empty">Signed rolls show up here as they land.</li>';
    return;
  }
  list.innerHTML = bets
    .map((b) => {
      const sig = b.playerSig || '';
      const cond = `${b.direction === 'under' ? 'Under' : 'Over'} ${b.targetDisplay || (b.targetBps / 100).toFixed(2)}`;
      return `
        <li class="roll-card ${b.won ? 'is-win' : 'is-loss'}" data-bet-txid="${escapeHtml(b.betTxid)}">
          <div class="roll-card-num">${escapeHtml(b.rollDisplay)}</div>
          <div class="roll-card-meta">
            <strong>${b.won ? 'Win' : 'Loss'}</strong>
            <span>${escapeHtml(cond)} · ${formatNum(b.wagerPoa, 2)} POA</span>
            <span>${b.won ? '+' + formatNum(b.payoutPoa, 4) : '0.0000'} POA</span>
            <code class="roll-card-sig" title="${escapeHtml(sig || 'Signature missing')}">${sig ? 'Ed25519 ' + escapeHtml(sigShort(sig)) : 'Unsigned'}</code>
          </div>
        </li>
      `;
    })
    .join('');
}

function renderLiveBetsTable() {
  $('betsCountBadge').textContent = String(state.recentBets.length);
  const tbody = $('liveBetsTableBody');
  if (state.recentBets.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#8fa3c7;">No bets yet — click Sign &amp; Roll Dice to place the first provably fair roll!</td></tr>`;
    renderInlineHistory();
    return;
  }

  tbody.innerHTML = state.recentBets
    .slice(0, 35)
    .map((b) => {
      const cond = `${b.direction === 'under' ? '<' : '>'} ${b.targetDisplay || (b.targetBps / 100).toFixed(2)}`;
      return `
        <tr data-bet-txid="${escapeHtml(b.betTxid)}" style="cursor:pointer;" title="Click to load into Provably Fair Verifier">
          <td><code>${escapeHtml(shortAddr(b.address))}</code></td>
          <td>${escapeHtml(cond)} (${escapeHtml(b.multiplierDisplay)})</td>
          <td>${formatNum(b.wagerPoa, 4)} POA</td>
          <td class="${b.won ? 'bet-win-pill' : 'bet-loss-pill'}">
            ${escapeHtml(b.rollDisplay)}
            <code class="sig-mini" title="${escapeHtml(b.playerSig || '')}">${b.playerSig ? escapeHtml(sigShort(b.playerSig)) : '—'}</code>
          </td>
          <td class="${b.won ? 'bet-win-pill' : ''}">${b.won ? '+' + formatNum(b.payoutPoa, 4) : '0.0000'} POA</td>
        </tr>
      `;
    })
    .join('');

  renderInlineHistory();

  tbody.querySelectorAll('tr[data-bet-txid]').forEach((row) => {
    row.addEventListener('click', () => {
      const txid = row.getAttribute('data-bet-txid');
      const bet = state.recentBets.find((x) => x.betTxid === txid);
      if (bet) {
        $('verifyServerSeedHash').value = bet.provablyFair?.serverSeedHash || '';
        $('verifyClientSeed').value = bet.provablyFair?.clientSeed || '';
        $('verifyNonce').value = String(bet.provablyFair?.nonce || 1);
        $('verifyBetTxid').value = bet.betTxid || '';
        $('verifyTargetBps').value = String(bet.targetBps || 4950);
        $('verifyDirection').value = bet.direction || 'under';
        switchFeedTab('verify');
      }
    });
  });
}

function renderChatMessages() {
  $('chatCountBadge').textContent = String(state.chatMessages.length);
  const list = $('chatMessagesList');
  if (state.chatMessages.length === 0) {
    list.innerHTML = '<div class="chat-msg"><div class="chat-text">No signed messages yet.</div></div>';
    return;
  }
  list.innerHTML = state.chatMessages
    .slice(-50)
    .map((m) => {
      const time = m.ts ? new Date(m.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
      return `
        <div class="chat-msg">
          <div class="chat-msg-header">
            <div>
              <span class="chat-sender">${escapeHtml(m.senderName || shortAddr(m.address))}</span>
              ${m.isAgent ? '<span class="badge badge-cyan">AGENT</span>' : '<span class="badge">HUMAN</span>'}
              ${m.verified ? '<span class="badge badge-emerald" title="Ed25519 Signature Verified">✓ SIG</span>' : ''}
            </div>
            <span>${escapeHtml(time)}</span>
          </div>
          <div class="chat-text">${escapeHtml(m.text)}</div>
        </div>
      `;
    })
    .join('');
  list.scrollTop = list.scrollHeight;
}

// ─── Actions: Sign & Submit Bet, Deposit, Withdraw, Sweep, Chat ──────────────

async function signAndRollSingle() {
  if (!state._demoPrivkey) {
    await initWallet(true);
  }
  const btn = $('btnRollDice');
  const alertEl = $('betErrorAlert');
  alertEl.classList.add('hidden');
  btn.disabled = true;

  try {
    const clientSeed = ($('clientSeedInput').value || 'agent-seed-01').trim();
    const amountPoa = $('wagerInput').value || '10.000000';
    const memo = `DICE1:BET:${state.direction}:${state.targetBps}:${clientSeed}`;
    $('lastSignedMemoText').textContent = memo;

    const res = await fetch(api('/api/action/sign-and-submit'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        privkey: state._demoPrivkey,
        action: 'BET',
        amountPoa,
        direction: state.direction,
        targetBps: state.targetBps,
        clientSeed,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      alertEl.textContent = `⚠️ ${data.error || 'Bet failed'}`;
      alertEl.classList.remove('hidden');
      return null;
    }

    const receipt = data.receipt;
    if (receipt.action === 'REFUND_QUEUED') {
      alertEl.textContent = `🛡️ Safe Auto-Refund Queued: ${receipt.reason}`;
      alertEl.classList.remove('hidden');
      return receipt;
    }

    if (data.signedTx?.body?.sig) receipt.playerSig = data.signedTx.body.sig;
    await animateRollResult(receipt);
    await fetchState();
    await refreshAllQuotes();
    return receipt;
  } catch (err) {
    alertEl.textContent = `⚠️ Network error: ${err.message}`;
    alertEl.classList.remove('hidden');
    return null;
  } finally {
    btn.disabled = false;
  }
}

function paintSettledRoll(bet) {
  const stage = $('rollStage');
  const digits = $('rollDigits');
  const statusLbl = $('rollStatusLabel');
  const pin = $('lastRollPin');
  const pinText = $('lastRollPinText');
  digits.textContent = bet.rollDisplay;
  digits.className = `roll-digits ${bet.won ? 'win-text' : 'loss-text'}`;
  stage.className = `roll-stage ${bet.won ? 'win-glow' : 'loss-glow'}`;
  statusLbl.textContent = bet.won
    ? `YOU WON +${formatNum(bet.netPlayerDeltaPoa, 4)} POA (${bet.multiplierDisplay})`
    : `ROLLED ${bet.rollDisplay} — HOUSE COLLECTS ${formatNum(bet.wagerPoa, 4)} POA`;
  const pct = Math.min(99, Math.max(1, bet.rollBps / 100));
  pin.style.left = `${pct}%`;
  pinText.textContent = bet.rollDisplay;
  pin.classList.remove('hidden');
}

function showLiveHistoryCard() {
  const list = $('inlineRollHistory');
  if (!list) return;
  const empty = list.querySelector('.roll-card-empty');
  if (empty) empty.remove();
  const existing = document.getElementById('inlineLiveCard');
  if (existing) existing.remove();
  const card = document.createElement('li');
  card.id = 'inlineLiveCard';
  card.className = 'roll-card is-rolling';
  card.innerHTML = `
    <div class="roll-card-num" id="inlineLiveDigits">00.00</div>
    <div class="roll-card-meta">
      <strong>Rolling</strong>
      <span>Signing the roll…</span>
      <code class="roll-card-sig">Ed25519 …</code>
    </div>
  `;
  list.prepend(card);
}

function animateRollResult(bet) {
  return new Promise((resolve) => {
    if (!bet || typeof bet.rollBps !== 'number') {
      resolve();
      return;
    }
    if (state.rollAnimFrame) cancelAnimationFrame(state.rollAnimFrame);
    state.rollAnimating = true;
    state.hasRolled = true;
    showLiveHistoryCard();
    const digits = $('rollDigits');
    const liveDigits = () => document.getElementById('inlineLiveDigits');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const finish = () => {
      state.rollAnimating = false;
      state.rollAnimFrame = 0;
      paintSettledRoll(bet);
      const live = liveDigits();
      if (live) live.textContent = bet.rollDisplay;
      upsertBet(bet);
      renderInlineHistory();
      renderLiveBetsTable();
      resolve();
    };
    if (reduce) {
      finish();
      return;
    }
    $('rollStatusLabel').textContent = 'ROLLING…';
    $('rollStage').className = 'roll-stage is-rolling';
    const start = performance.now();
    const step = (now) => {
      if (!document.getElementById('rollDigits')) {
        state.rollAnimating = false;
        resolve();
        return;
      }
      if (now - start < 1100) {
        const spinning = (Math.floor(Math.random() * 10000) / 100).toFixed(2);
        digits.textContent = spinning;
        digits.className = 'roll-digits is-spinning';
        const live = liveDigits();
        if (live) live.textContent = spinning;
        state.rollAnimFrame = requestAnimationFrame(step);
      } else {
        finish();
      }
    };
    state.rollAnimFrame = requestAnimationFrame(step);
  });
}

async function playRollSequence(receipts) {
  for (const receipt of receipts) {
    if (!receipt || typeof receipt.rollBps !== 'number') continue;
    await animateRollResult(receipt);
  }
}

async function runAgentBurst() {
  if (!state._demoPrivkey) await initWallet(true);
  const btn = $('btnAgentAutoBurst');
  btn.disabled = true;
  const origText = btn.textContent;
  try {
    btn.textContent = '🤖 Running 5-Roll Kelly Strategy...';
    const res = await fetch(api('/api/action/auto-bet'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        privkey: state._demoPrivkey,
        strategy: 'flat',
        baseWagerPoa: $('wagerInput').value || '10.000000',
        targetBps: state.targetBps,
        direction: state.direction,
        rolls: 5,
        clientSeed: ($('clientSeedInput').value || 'agent-seed-01').trim(),
      }),
    });
    const data = await res.json();
    if (data.ok && Array.isArray(data.receipts) && data.receipts.length > 0) {
      await playRollSequence(data.receipts);
      await fetchState();
      await refreshAllQuotes();
    }
  } finally {
    btn.textContent = origText;
    btn.disabled = false;
  }
}

async function submitBankDeposit() {
  if (!state._demoPrivkey) await initWallet(true);
  const amountPoa = $('depositAmountInput').value || '1000.000000';
  const lockEpochs = Number($('lockEpochsInput').value || 0);
  const memo = `DICE1:LP_ADD:epochs=${lockEpochs}`;
  $('lastSignedMemoText').textContent = memo;

  const res = await fetch(api('/api/action/sign-and-submit'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      privkey: state._demoPrivkey,
      action: 'LP_ADD',
      amountPoa,
      lockEpochs,
    }),
  });
  const data = await res.json();
  if (data.ok) {
    await fetchState();
    await refreshAllQuotes();
  }
}

async function submitBankWithdraw() {
  if (!state._demoPrivkey) await initWallet(true);
  const memo = state.withdrawBps === 10000 ? 'DICE1:LP_WITHDRAW:ALL' : `DICE1:LP_WITHDRAW:BPS=${state.withdrawBps}`;
  $('lastSignedMemoText').textContent = memo;

  const res = await fetch(api('/api/action/sign-and-submit'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      privkey: state._demoPrivkey,
      action: 'LP_WITHDRAW',
      bps: state.withdrawBps,
      mode: state.withdrawBps === 10000 ? 'ALL' : 'BPS',
    }),
  });
  const data = await res.json();
  if (data.ok) {
    await fetchState();
    await refreshAllQuotes();
  }
}

async function sweepDevReserve() {
  const res = await fetch(api('/api/dev/sweep'), { method: 'POST' });
  const data = await res.json();
  if (data.ok) {
    await fetchState();
  }
}

async function advanceEpoch() {
  const res = await fetch(api('/api/epoch/advance'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ distributeIncentives: true }),
  });
  const data = await res.json();
  if (data.ok) {
    await fetchState();
    await refreshAllQuotes();
  }
}

async function rotateAndRevealSeed() {
  const res = await fetch(api('/api/seed/rotate'), { method: 'POST' });
  const data = await res.json();
  if (data.ok && data.revealed) {
    $('verifyServerSeed').value = data.revealed.serverSeed;
    $('verifyServerSeedHash').value = data.revealed.serverSeedHash;
    if (state.recentBets.length > 0) {
      const b = state.recentBets[0];
      $('verifyClientSeed').value = b.provablyFair?.clientSeed || 'tessellate-agent-seed-01';
      $('verifyNonce').value = String(b.provablyFair?.nonce || 1);
      $('verifyBetTxid').value = b.betTxid || '';
      $('verifyTargetBps').value = String(b.targetBps || 4950);
      $('verifyDirection').value = b.direction || 'under';
    }
    await runVerifyRoll();
    await fetchState();
  }
}

async function runVerifyRoll() {
  const payload = {
    serverSeed: $('verifyServerSeed').value.trim(),
    serverSeedHash: $('verifyServerSeedHash').value.trim(),
    clientSeed: $('verifyClientSeed').value.trim(),
    nonce: Number($('verifyNonce').value || 1),
    betTxid: $('verifyBetTxid').value.trim() || '0'.repeat(64),
    targetBps: Number($('verifyTargetBps').value || 4950),
    direction: $('verifyDirection').value,
  };
  if (!payload.serverSeed) {
    $('verifyResultPre').textContent = 'Click "Rotate & Reveal Server Seed" first to reveal the plaintext server_seed.';
    return;
  }
  const res = await fetch(api('/api/verify'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  $('verifyResultPre').textContent = JSON.stringify(data, null, 2);
}

// ─── Near Real-Time SSE Stream ───────────────────────────────────────────────

let bootGeneration = 0;
let eventSource = null;
let pollTimer = null;

export function stopPoaDice() {
  bootGeneration += 1;
  if (state.rollAnimFrame) {
    cancelAnimationFrame(state.rollAnimFrame);
    state.rollAnimFrame = 0;
  }
  state.rollAnimating = false;
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function bootPoaDice() {
  const myGen = ++bootGeneration;
  const alive = () => myGen === bootGeneration && !!document.getElementById('btnRollDice');
  bindEvents();
  updateSliderVisuals();
  void (async () => {
    if (!alive()) return;
    await initWallet(false);
    if (!alive()) return;
    await fetchState();
    if (!alive()) return;
    await refreshAllQuotes();
    if (!alive()) return;
    connectRealtimeStream(alive);
  })();
}

function connectRealtimeStream(alive) {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  try {
    eventSource = new EventSource(api('/api/stream'));
    eventSource.onopen = () => {
      state.sseConnected = true;
      const label = document.getElementById('sseStatusText');
      if (label) label.textContent = 'LIVE SSE';
    };
    eventSource.onmessage = (ev) => {
      if (!alive()) return;
      try {
        const msg = JSON.parse(ev.data);
        handleRealtimeEvent(msg);
      } catch {
        // Ignore malformed event
      }
    };
    eventSource.onerror = () => {
      state.sseConnected = false;
      const label = document.getElementById('sseStatusText');
      if (label) label.textContent = 'RECONNECTING';
    };
  } catch {
    const label = document.getElementById('sseStatusText');
    if (label) label.textContent = 'OFFLINE CLI';
  }
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!alive()) {
      clearInterval(pollTimer);
      pollTimer = null;
      return;
    }
    void fetchState();
  }, 4000);
}

function handleRealtimeEvent(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'bet.settled' && msg.payload) {
    const bet = msg.payload;
    const exists = state.recentBets.some((b) => b.betTxid === bet.betTxid);
    if (!exists) {
      state.recentBets.unshift(bet);
      renderLiveBetsTable();
    }
    fetchState();
  } else if (msg.type === 'chat.message' && msg.payload) {
    const chat = msg.payload;
    const exists = state.chatMessages.some((c) => c.id === chat.id);
    if (!exists) {
      state.chatMessages.push(chat);
      renderChatMessages();
    }
  } else if (
    msg.type === 'bank.deposit' ||
    msg.type === 'bank.withdraw' ||
    msg.type === 'dev.swept' ||
    msg.type === 'epoch.advanced'
  ) {
    fetchState();
    refreshAllQuotes();
  }
}

// ─── Tab Switching & Event Listeners ─────────────────────────────────────────

function switchBankTab(tabName) {
  document.querySelectorAll('[data-bank-tab]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-bank-tab') === tabName);
  });
  $('bankTabDeposit').classList.toggle('hidden', tabName !== 'deposit');
  $('bankTabWithdraw').classList.toggle('hidden', tabName !== 'withdraw');
  $('bankTabIncentives').classList.toggle('hidden', tabName !== 'incentives');
}

function switchFeedTab(tabName) {
  document.querySelectorAll('[data-feed-tab]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-feed-tab') === tabName);
  });
  $('feedTabChat').classList.toggle('hidden', tabName !== 'chat');
  $('feedTabBets').classList.toggle('hidden', tabName !== 'bets');
  $('feedTabVerify').classList.toggle('hidden', tabName !== 'verify');
  $('feedTabMcp').classList.toggle('hidden', tabName !== 'mcp');
}

function bindEvents() {
  const slider = $('diceSlider');
  slider.addEventListener('input', () => {
    state.targetBps = Number(slider.value);
    updateSliderVisuals();
    fetchBetQuote();
  });

  $('targetInput').addEventListener('change', (e) => {
    const val = Math.round(Number(e.target.value) * 100);
    const min = state.direction === 'under' ? 100 : 199;
    const max = state.direction === 'under' ? 9800 : 9899;
    state.targetBps = Math.max(min, Math.min(max, val || 4950));
    updateSliderVisuals();
    fetchBetQuote();
  });

  $('winChanceInput').addEventListener('change', (e) => {
    const winBps = Math.max(100, Math.min(9800, Math.round(Number(e.target.value) * 100) || 4950));
    state.targetBps = state.direction === 'under' ? winBps : 9999 - winBps;
    updateSliderVisuals();
    fetchBetQuote();
  });

  $('btnFlipDirection').addEventListener('click', () => {
    state.direction = state.direction === 'under' ? 'over' : 'under';
    state.targetBps = 9999 - state.targetBps;
    state.targetBps = Math.max(100, Math.min(9899, state.targetBps));
    updateSliderVisuals();
    fetchBetQuote();
  });

  $('wagerInput').addEventListener('input', () => {
    updateOfflineCommandPreview();
    fetchBetQuote();
  });

  $('btnBetMin').addEventListener('click', () => {
    $('wagerInput').value = '1.000000';
    updateOfflineCommandPreview();
    fetchBetQuote();
  });
  $('btnBetHalf').addEventListener('click', () => {
    const cur = Math.max(1, (Number($('wagerInput').value) || 10) / 2);
    $('wagerInput').value = cur.toFixed(6);
    updateOfflineCommandPreview();
    fetchBetQuote();
  });
  $('btnBetDouble').addEventListener('click', () => {
    const maxW = Number(state.lastBetQuote?.maxAllowedWagerPoa || 2500);
    const cur = Math.min(maxW, (Number($('wagerInput').value) || 10) * 2);
    $('wagerInput').value = cur.toFixed(6);
    updateOfflineCommandPreview();
    fetchBetQuote();
  });
  $('btnBetMax').addEventListener('click', () => {
    const maxW = state.lastBetQuote?.maxAllowedWagerPoa || '100.000000';
    $('wagerInput').value = maxW;
    updateOfflineCommandPreview();
    fetchBetQuote();
  });

  $('btnRandomSeed').addEventListener('click', () => {
    const rand = Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
    $('clientSeedInput').value = `poa-seed-${rand}`;
    updateOfflineCommandPreview();
  });

  $('clientSeedInput').addEventListener('input', updateOfflineCommandPreview);

  $('btnRollDice').addEventListener('click', signAndRollSingle);
  $('btnAgentAutoBurst').addEventListener('click', runAgentBurst);

  $('btnNewWallet').addEventListener('click', async () => {
    await initWallet(true);
    await fetchState();
    await refreshAllQuotes();
  });
  $('btnToggleOfflineMode').addEventListener('click', () => {
    $('offlineBanner').classList.toggle('hidden');
  });

  $('btnCopyOfflineCmd').addEventListener('click', async () => {
    const txt = $('liveOfflineCommand').textContent;
    try {
      await navigator.clipboard.writeText(txt);
      $('btnCopyOfflineCmd').textContent = 'Copied!';
      setTimeout(() => {
        $('btnCopyOfflineCmd').textContent = 'Copy Command';
      }, 1500);
    } catch {
      // Ignore clipboard permission error
    }
  });

  // Bankroll Tabs & Controls
  document.querySelectorAll('[data-bank-tab]').forEach((btn) => {
    btn.addEventListener('click', () => switchBankTab(btn.getAttribute('data-bank-tab')));
  });
  document.querySelectorAll('[data-set-deposit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('depositAmountInput').value = btn.getAttribute('data-set-deposit');
      fetchDepositQuote();
    });
  });
  $('depositAmountInput').addEventListener('input', fetchDepositQuote);
  $('lockEpochsInput').addEventListener('input', fetchDepositQuote);
  $('btnSubmitDeposit').addEventListener('click', submitBankDeposit);

  document.querySelectorAll('[data-withdraw-bps]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-withdraw-bps]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.withdrawBps = Number(btn.getAttribute('data-withdraw-bps'));
      $('withdrawBpsLabel').textContent = `${(state.withdrawBps / 100).toFixed(0)}% OF YOUR BANK SHARES`;
      fetchWithdrawQuote();
    });
  });
  $('btnSubmitWithdraw').addEventListener('click', submitBankWithdraw);

  $('btnSweepDev').addEventListener('click', sweepDevReserve);
  $('btnAdvanceEpoch').addEventListener('click', advanceEpoch);

  // Feed Tabs & Chat
  document.querySelectorAll('[data-feed-tab]').forEach((btn) => {
    btn.addEventListener('click', () => switchFeedTab(btn.getAttribute('data-feed-tab')));
  });

  $('chatForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const textInput = $('chatTextInput');
    const text = textInput.value.trim();
    if (!text) return;
    const senderName = $('chatSenderInput').value.trim() || 'POA-Player';
    const isAgent = $('chatIsAgentCheck').checked;

    textInput.value = '';
    await fetch(api('/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        privkey: state._demoPrivkey,
        address: state.wallet?.address || 'guest',
        senderName,
        text,
        isAgent,
      }),
    });
    await fetchState();
  });

  $('btnRotateSeed').addEventListener('click', rotateAndRevealSeed);
  $('btnRunVerify').addEventListener('click', runVerifyRoll);
}
