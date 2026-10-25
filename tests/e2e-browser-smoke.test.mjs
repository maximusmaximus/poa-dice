// @ts-nocheck
/**
 * Browser e2e smoke test (headless Chrome via playwright-core).
 *
 * Runs ONLY against a local server on 127.0.0.1 with a mocked minepoa.com explorer.
 * Nothing here touches the live site or the real chain, and no real keys are used:
 * every signer is a throwaway keypair generated inside this test.
 *
 * Covers: clean top section (no dev-signer box, no shared-key endpoint), footer link,
 * copy-prompt buttons for every action with exact args, enabled/disabled edge cases
 * (bank 0, bank cannot cover the count, chain down, bad input), server-side rejection
 * of oversize batches (MCP + HTTP), concurrent reservations, MCP bank tools, live page
 * updates without reload (SSE) with measured latency, and the polling fallback.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiceServer } from '../src/server.mjs';
import { genKeypair } from '../src/crypto-poa.mjs';
import { BankrollEngine, DEV_RESERVE_ADDRESS } from '../src/bankroll-engine.mjs';

const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const ADMIN = 'browser-e2e-admin';
let chromium = null;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  chromium = null;
}
const haveBrowser = Boolean(chromium) && fs.existsSync(CHROME);
if (!haveBrowser && process.env.REQUIRE_BROWSER) throw new Error(`Browser e2e required but Chrome/playwright-core missing (${CHROME})`);
const skip = haveBrowser ? false : `headless Chrome not found at ${CHROME}`;

const latency = {};
const shotsDir = process.env.E2E_SCREENSHOT_DIR || '';

function tmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-browser-${tag}-`));
}

async function startServer({ bootstrap = '100000.000000', balances = {}, chainDown = () => false } = {}) {
  const app = createDiceServer({
    dataDir: tmp('srv'),
    initialBootstrapPoa: bootstrap,
    requireChain: true,
    chainCacheMs: 0,
    adminToken: ADMIN,
    chainFetch: async (address) => {
      if (chainDown()) throw new Error('mock minepoa.com down');
      return { address, balance: balances[address] ?? '0.000000' };
    },
  });
  const info = await app.listen(0, '127.0.0.1');
  balances[app.engine.bankAddress] = balances[app.engine.bankAddress] ?? bootstrap ?? '0.000000';
  balances[DEV_RESERVE_ADDRESS] = balances[DEV_RESERVE_ADDRESS] ?? '10.000000';
  return { app, url: info.url, close: () => info.close?.() ?? new Promise((r) => app.server.close(r)) };
}

let rpcId = 0;
async function mcp(url, name, args = {}) {
  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json();
  const text = body.result?.content?.[0]?.text || '{}';
  return { isError: Boolean(body.result?.isError), data: JSON.parse(text), raw: body };
}

async function openPage(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('[data-roll-count]:not([disabled])').length > 0 || /0 available|CHAIN DOWN|unreachable/i.test(document.getElementById('promptBlockReason')?.textContent || ''), null, { timeout: 10000 });
  return { page, context, errors };
}

async function setInput(page, sel, value) {
  await page.fill(sel, '');
  await page.fill(sel, value);
  await page.dispatchEvent(sel, 'input');
}

async function countStates(page) {
  return page.$$eval('[data-roll-count]', (els) => Object.fromEntries(els.map((e) => [e.dataset.rollCount, !e.disabled])));
}

async function clipboard(page) {
  return page.evaluate(() => navigator.clipboard.readText());
}

test('browser e2e: clean top, prompts, edge cases, MCP tools and live updates', { skip, timeout: 120000 }, async (t) => {
  const player = genKeypair();
  const staker = genKeypair();
  const balances = { [player.address]: '1000000.000000', [staker.address]: '500000.000000' };
  let down = false;
  const srv = await startServer({ balances, chainDown: () => down });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  try {
    const { page, errors } = await openPage(browser, srv.url);

    await t.test('top section is clean: dev-signer box removed, edge badge kept, footer links the repo', async () => {
      for (const id of ['activeWalletAddr', 'btnNewWallet', 'btnToggleOfflineMode', 'btnRollDice', 'btnSweepDev', 'btnRotateSeed', 'btnAdvanceEpoch', 'walletSpendable']) {
        assert.equal(await page.$(`#${id}`), null, `#${id} must not exist`);
      }
      const html = await page.content();
      assert.ok(!/New Dev Signer|Offline Mode/i.test(html), 'no dev signer / offline mode UI');
      assert.match(await page.textContent('#walletVipBadge'), /Edge\)/);
      assert.ok(await page.isVisible('.site-header #walletVipBadge'));
      const href = await page.getAttribute('.site-footer a#repoLink', 'href');
      assert.equal(href, 'https://github.com/maximusmaximus/poa-dice');
      assert.match(await page.textContent('.site-footer'), /Built with/);
      if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'top.png'), clip: { x: 0, y: 0, width: 1400, height: 1000 } });
    });

    await t.test('/api/wallet/dev and /api/wallet/generate are not publicly served; the browser never sends privkeys', async () => {
      for (const [method, p] of [['GET', '/api/wallet/dev'], ['POST', '/api/wallet/dev'], ['POST', '/api/wallet/generate']]) {
        const r = await fetch(srv.url + p, { method });
        assert.equal(r.status, 404, `${method} ${p}`);
        assert.ok(!/privkey|priv_key/i.test(await r.text()));
      }
      const appJs = await (await fetch(`${srv.url}/app.js`)).text();
      assert.ok(!appJs.includes('/api/wallet/dev'));
      assert.ok(!/privkey\s*:/.test(appJs), 'app.js must not put privkey in a request body');
    });

    await t.test('roll prompt for every count (1/5/100/1000) with exact args, preview and Copied state', async () => {
      const sent = [];
      page.on('request', (r) => r.method() === 'POST' && sent.push(r.postData() || ''));
      await setInput(page, '#wagerInput', '2.000000');
      await setInput(page, '#clientSeedInput', 'e2e-seed-1');
      await page.waitForTimeout(400);
      for (const n of [1, 5, 100, 1000]) {
        await page.click(`[data-roll-count="${n}"]`);
        await page.waitForFunction(() => !document.getElementById('btnCopyPrompt').disabled);
        await page.click('#btnCopyPrompt');
        await page.waitForFunction(() => /Copied/.test(document.getElementById('btnCopyPromptText').textContent));
        const text = await clipboard(page);
        assert.match(text, new RegExp(`${srv.url.replace(/[./]/g, '\\$&')}/mcp`));
        assert.match(text, /dice_quote_batch/);
        assert.match(text, /dice_batch_roll/);
        assert.match(text, new RegExp(`"count": ${n}\\b`));
        assert.match(text, /"amount_poa": "2\.000000"/);
        assert.match(text, /"client_seed": "e2e-seed-1"/);
        assert.match(text, new RegExp(`"max_total_spend_poa": "${(2 * n).toFixed(6)}"`));
        assert.match(text, /Spend cap: never send more than/);
        assert.match(text, /Stop condition/);
        // exact unsigned transfer spec: no guessing for the agent
        const bankAddr = (await (await fetch(`${srv.url}/api/health`)).json()).bankAddress;
        assert.match(text, new RegExp(n === 1 ? 'exactly 1 minepoa transfer' : `exactly ${n} separate minepoa transfers`));
        assert.match(text, /- chain id \(cid\): poa-mainnet-1/);
        assert.ok(text.includes(`- to (bank address): ${bankAddr}`), 'bank address spelled out');
        assert.match(text, /- amount: 2\.000000 POA/);
        assert.match(text, /- memo \(exact, byte for byte\): DICE1:BET:under:\d+:e2e-seed-1/);
        assert.match(text, new RegExp(`- count: ${n} transfer`));
        assert.match(text, /plus "signed_txs"/);
        assert.match(text, /tx_templates/);
        assert.match(text, /"wait_seconds": 60/);
        assert.match(text, /waits up to 60 s[\s\S]*payout txids[\s\S]*server seed hash/);
        assert.match(text, /PENDING_CONFIRMATION[\s\S]*tx_status/);
        assert.match(text, /My PoA address: not given[\s\S]*final edge may be lower/);
        assert.ok(!/"address"/.test(text), 'no address in the args when none is given');
        assert.match(text, /never add "privkey" unless I confirm/);
        assert.equal(await page.textContent('#promptPreview'), text, 'preview shows the copied prompt');
      }
      assert.ok(!sent.some((b) => /privkey/i.test(b)), 'no POST body from the page carries a private key');
      await page.click('[data-roll-count="1"]');
    });

    await t.test('disabled states: bad input, bank cannot cover the count, chain down', async () => {
      await setInput(page, '#clientSeedInput', 'bad seed!');
      await page.waitForFunction(() => document.getElementById('btnCopyPrompt').disabled);
      assert.match(await page.textContent('#promptBlockReason'), /Client seed/);
      await setInput(page, '#clientSeedInput', 'e2e-seed-1');
      await setInput(page, '#wagerInput', 'abc');
      await page.waitForFunction(() => document.getElementById('btnCopyPrompt').disabled);
      assert.match(await page.textContent('#promptBlockReason'), /Wager/);

      // 200 POA × 1000 = 200k worst case > 100k bank: only 1000 is off.
      await setInput(page, '#wagerInput', '200.000000');
      await page.waitForFunction(() => document.querySelector('[data-roll-count="1000"]').disabled && !document.querySelector('[data-roll-count="1"]').disabled);
      assert.deepEqual(await countStates(page), { 1: true, 5: true, 100: true, 1000: false });
      assert.match(await page.getAttribute('[data-roll-count="1000"]', 'title'), /bank only has|Kelly/);

      // Huge wager: Kelly cap blocks everything, with a reason.
      await setInput(page, '#wagerInput', '50000.000000');
      await page.waitForFunction(() => document.getElementById('btnCopyPrompt').disabled);
      assert.deepEqual(await countStates(page), { 1: false, 5: false, 100: false, 1000: false });
      assert.ok((await page.textContent('#promptBlockReason')).length > 10);

      down = true;
      await setInput(page, '#wagerInput', '1.000000');
      await page.waitForFunction(() => /CHAIN DOWN/.test(document.getElementById('promptBlockReason').textContent));
      assert.ok(await page.$eval('#btnSubmitDeposit', (b) => b.disabled), 'stake is off while chain is down');
      down = false;
      await setInput(page, '#wagerInput', '1.000000');
      await page.waitForFunction(() => !document.getElementById('btnCopyPrompt').disabled);
    });

    await t.test('MCP initialize names the browser prompts as the entry point and lists the new tools', async () => {
      const init = await (await fetch(`${srv.url}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) })).json();
      assert.match(init.result.instructions, /prompt/i);
      assert.match(init.result.instructions, /Copy prompt|copied/i);
      const list = await (await fetch(`${srv.url}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })).json();
      const names = list.result.tools.map((x) => x.name);
      for (const n of ['dice_quote_batch', 'dice_batch_roll', 'bank_claim_yield', 'bank_stake', 'bank_withdraw', 'dice_auto_strategy', 'chat_send']) assert.ok(names.includes(n), n);
    });

    await t.test('server rejects batches the bank cannot cover (MCP + HTTP) and keyless calls on a chain server', async () => {
      const big = { count: 1000, amount_poa: '200.000000', target_bps: 4950, direction: 'under', client_seed: 'big', max_total_spend_poa: '200000.000000', privkey: player.privkey };
      const r = await mcp(srv.url, 'dice_batch_roll', big);
      assert.equal(r.isError, true);
      assert.match(r.data.code || '', /bank_insufficient|kelly_cap/);
      const h = await fetch(`${srv.url}/api/action/batch-roll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(big) });
      assert.equal(h.status, 409);
      const noCap = await mcp(srv.url, 'dice_batch_roll', { ...big, count: 5, amount_poa: '1.000000', max_total_spend_poa: '1.000000' });
      assert.equal(noCap.isError, true, 'spend cap below count × wager is rejected');
      const keyless = await mcp(srv.url, 'dice_batch_roll', { count: 1, amount_poa: '1.000000', target_bps: 4950, direction: 'under', client_seed: 'k', max_total_spend_poa: '1.000000' });
      assert.equal(keyless.isError, true, 'chain-backed server needs the agent’s own signature');
      for (const p of ['/api/seed/rotate', '/api/dev/sweep', '/api/epoch/advance']) {
        assert.equal((await fetch(srv.url + p, { method: 'POST' })).status, 401, `${p} needs admin auth`);
      }
    });

    await t.test('live updates without reload: MCP roll and 5-roll batch (SSE), latency measured', async () => {
      await setInput(page, '#playerAddressInput', player.address);
      await page.waitForFunction(() => /Spendable/.test(document.getElementById('chainBalanceText').textContent));
      await page.evaluate(() => (window.__noReload = 'still-here'));
      const before = Number(await page.textContent('#statTotalBets'));
      const spendBefore = await page.textContent('#chainBalanceText');

      let t0 = Date.now();
      const one = await mcp(srv.url, 'dice_batch_roll', { count: 1, amount_poa: '1.000000', target_bps: 4950, direction: 'under', client_seed: 'live-1', max_total_spend_poa: '1.000000', privkey: player.privkey });
      assert.equal(one.isError, false, JSON.stringify(one.data).slice(0, 300));
      const txid = one.data.rolls[0].betTxid;
      await page.waitForSelector(`#inlineRollHistory [data-bet-txid="${txid}"]`, { timeout: 5000 });
      latency.singleRollHistoryMs = Date.now() - t0;
      await page.waitForFunction((b) => Number(document.getElementById('statTotalBets').textContent) === b + 1, before, { timeout: 5000 });
      latency.singleRollStatsMs = Date.now() - t0;
      assert.equal(await page.textContent('#rollDigits'), one.data.rolls[0].rollDisplay);

      t0 = Date.now();
      const five = await mcp(srv.url, 'dice_batch_roll', { count: 5, amount_poa: '1.000000', target_bps: 4950, direction: 'under', client_seed: 'live-5', max_total_spend_poa: '5.000000', privkey: player.privkey });
      assert.equal(five.isError, false);
      assert.equal(five.data.rolls.length, 5);
      await page.waitForFunction((b) => Number(document.getElementById('statTotalBets').textContent) === b + 6, before, { timeout: 5000 });
      latency.batch5StatsMs = Date.now() - t0;
      await page.waitForFunction(() => /Batch finished: 5\/5/.test(document.getElementById('batchProgress').textContent), null, { timeout: 5000 });
      for (const r of five.data.rolls) assert.ok(await page.$(`#liveBetsTableBody [data-bet-txid="${r.betTxid}"]`), 'bet in live table');
      await page.waitForFunction((s) => document.getElementById('chainBalanceText').textContent !== s, spendBefore, { timeout: 5000 });
      assert.equal(await page.evaluate(() => window.__noReload), 'still-here', 'page was not reloaded');
      if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'after-batch.png'), fullPage: false });
    });

    await t.test('every bank/action button builds the right prompt; MCP bank tools work locally; page updates live', async () => {
      // Stake (deposit + lock-up + referral)
      await page.click('[data-bank-tab="deposit"]');
      await setInput(page, '#depositAmountInput', '1000.000000');
      await page.fill('#lockEpochsInput', '3');
      await page.dispatchEvent('#lockEpochsInput', 'change');
      await setInput(page, '#referrerInput', staker.address);
      await page.waitForFunction(() => !document.getElementById('btnSubmitDeposit').disabled);
      // Lock-up warning: nothing is copied until the user confirms; Esc, Cancel and the backdrop close it
      await page.evaluate(() => navigator.clipboard.writeText('untouched'));
      for (const how of ['escape', 'cancel', 'backdrop']) {
        await page.click('#btnSubmitDeposit');
        await page.waitForSelector('#stakeConfirm:not(.hidden)');
        if (how === 'escape') await page.keyboard.press('Escape');
        if (how === 'cancel') await page.click('#stakeConfirmCancel');
        if (how === 'backdrop') await page.mouse.click(5, 5);
        await page.waitForSelector('#stakeConfirm.hidden', { state: 'attached' });
        assert.equal(await clipboard(page), 'untouched', `${how} must not copy the prompt`);
      }
      await page.click('#btnSubmitDeposit');
      await page.waitForSelector('#stakeConfirm:not(.hidden)');
      const dialog = await page.$eval('#stakeConfirm [role="dialog"]', (d) => ({ modal: d.getAttribute('aria-modal'), label: document.getElementById(d.getAttribute('aria-labelledby')).textContent }));
      assert.deepEqual(dialog, { modal: 'true', label: 'Your POA will be locked' });
      const modalText = await page.textContent('#stakeConfirm');
      assert.match(modalText, /Staking 1,000\.000000 POA/);
      assert.match(modalText, /3 epochs · about 18 hours/);
      assert.match(modalText, /Epoch 4 · about /);
      assert.match(modalText, /No early exit\. Until epoch 4 the vault refuses every withdrawal/);
      assert.match(modalText, /From epoch 4 you can withdraw your tokens again/);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'stakeConfirmOk', 'focus moves into the dialog');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.getElementById('stakeConfirm').contains(document.activeElement)), true, 'focus is trapped');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.getElementById('stakeConfirm').contains(document.activeElement)), true, 'focus is trapped');
      if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'stake-lock-modal.png'), fullPage: false });
      await page.click('#stakeConfirmOk');
      await page.waitForSelector('#stakeConfirm.hidden', { state: 'attached' });
      await page.waitForFunction(() => navigator.clipboard.readText().then((t) => t !== 'untouched'));
      let text = await clipboard(page);
      assert.match(text, /bank_quote_deposit/);
      assert.match(text, /bank_stake/);
      assert.ok(text.includes(`My PoA address: ${player.address}`), 'address in the prompt');
      assert.ok(text.includes(`"address": "${player.address}"`), 'quote uses the address (VIP edge)');
      assert.match(text, /- amount: 1000\.000000 POA/);
      assert.ok(text.includes(`- memo (exact, byte for byte): DICE1:LP_ADD:epochs=3:ref=${staker.address}`), text);
      assert.match(text, /plus "signed_tx"/);
      assert.match(text, /tx_status[\s\S]*CONFIRMED/);
      assert.match(text, /"amount_poa": "1000\.000000"/);
      assert.match(text, /"lock_epochs": 3/);
      assert.match(text, new RegExp(`"referrer": "${staker.address}"`));
      // self-referral is rejected inline
      await setInput(page, '#referrerInput', player.address);
      await page.waitForFunction(() => document.getElementById('btnSubmitDeposit').disabled);
      assert.match(await page.textContent('#stakeReason'), /refer/i);
      await setInput(page, '#referrerInput', '');
      await page.waitForFunction(() => !document.getElementById('btnSubmitDeposit').disabled);

      // Withdraw / claim are off without a position
      await page.click('[data-bank-tab="withdraw"]');
      await page.waitForFunction(() => document.getElementById('btnSubmitWithdraw').disabled && document.getElementById('btnCopyClaim').disabled);
      assert.match(await page.textContent('#withdrawReason'), /position|shares/i);

      const navBefore = await page.textContent('#topBankNav');
      let t0 = Date.now();
      const stake = await mcp(srv.url, 'bank_stake', { amount_poa: '1000.000000', lock_epochs: 0, max_total_spend_poa: '1000.000000', privkey: player.privkey });
      assert.equal(stake.isError, false, JSON.stringify(stake.data).slice(0, 300));
      await page.waitForFunction((n) => document.getElementById('topBankNav').textContent !== n, navBefore, { timeout: 5000 });
      latency.stakeNavMs = Date.now() - t0;
      await page.waitForFunction(() => !document.getElementById('btnSubmitWithdraw').disabled, null, { timeout: 5000 });
      assert.notEqual(await page.textContent('#userRedeemablePoa'), '0.000000 POA');

      // With a position, a locked stake warns that the existing shares get locked too
      await page.click('[data-bank-tab="deposit"]');
      await page.waitForFunction(() => !document.getElementById('btnSubmitDeposit').disabled);
      await page.click('#btnSubmitDeposit');
      await page.waitForSelector('#stakeConfirm:not(.hidden)');
      assert.match(await page.textContent('#stakeConfirmBody'), /This also locks your existing [\d,.]+ POA in the vault until epoch 4\. A lock covers your whole position/);
      await page.keyboard.press('Escape');
      // Lock 0 into an unlocked position: lighter confirmation
      await page.fill('#lockEpochsInput', '0');
      await page.dispatchEvent('#lockEpochsInput', 'change');
      await page.waitForFunction(() => !document.getElementById('btnSubmitDeposit').disabled);
      await page.click('#btnSubmitDeposit');
      await page.waitForSelector('#stakeConfirm:not(.hidden)');
      assert.equal(await page.textContent('#stakeConfirmTitle'), 'Confirm your stake');
      assert.match(await page.textContent('#stakeConfirmBody'), /No lock: you can withdraw whenever you like/);
      await page.click('#stakeConfirmCancel');
      await page.click('[data-bank-tab="withdraw"]');

      await page.click('[data-withdraw-bps="5000"]');
      await page.waitForFunction(() => !document.getElementById('btnSubmitWithdraw').disabled);
      await page.click('#btnSubmitWithdraw');
      text = await clipboard(page);
      assert.match(text, /bank_quote_withdraw/);
      assert.match(text, /bank_withdraw/);
      assert.match(text, /"mode": "BPS"/);
      assert.match(text, /"bps": 5000/);
      assert.match(text, /- amount: 0\.000001 POA/);
      assert.match(text, /- memo \(exact, byte for byte\): DICE1:LP_WITHDRAW:BPS=5000/);

      // Generate yield deterministically: rolls pay incentive fees; the (admin) epoch advance compounds them.
      await mcp(srv.url, 'dice_batch_roll', { count: 100, amount_poa: '5.000000', target_bps: 4950, direction: 'under', client_seed: 'yield', max_total_spend_poa: '500.000000', privkey: staker.privkey });
      const adv = await fetch(`${srv.url}/api/epoch/advance`, { method: 'POST', headers: { Authorization: `Bearer ${ADMIN}` } });
      assert.equal(adv.status, 200);
      const claimQ = await mcp(srv.url, 'bank_claim_yield', { dry_run: true, address: player.address });
      if (claimQ.data.valid) {
        await page.waitForFunction(() => !document.getElementById('btnCopyClaim').disabled, null, { timeout: 6000 });
        await page.click('#btnCopyClaim');
        text = await clipboard(page);
        assert.match(text, /bank_claim_yield/);
        const redeemBefore = await page.textContent('#userRedeemablePoa');
        t0 = Date.now();
        const claim = await mcp(srv.url, 'bank_claim_yield', { privkey: player.privkey });
        assert.equal(claim.isError, false, JSON.stringify(claim.data).slice(0, 300));
        await page.waitForFunction((v) => document.getElementById('userRedeemablePoa').textContent !== v, redeemBefore, { timeout: 6000 });
        latency.claimPositionMs = Date.now() - t0;
      } else {
        assert.match(claimQ.data.code || claimQ.data.reason || '', /yield/i, 'claim is rejected only for no yield');
      }

      t0 = Date.now();
      const wd = await mcp(srv.url, 'bank_withdraw', { mode: 'ALL', privkey: player.privkey });
      assert.equal(wd.isError, false, JSON.stringify(wd.data).slice(0, 300));
      await page.waitForFunction(() => document.getElementById('btnSubmitWithdraw').disabled, null, { timeout: 6000 });
      latency.withdrawButtonMs = Date.now() - t0;

      // Auto-bet
      await page.evaluate(() => document.querySelector('details.auto-step')?.setAttribute('open', ''));
      await page.selectOption('#autoStrategySelect', 'martingale_capped');
      await page.fill('#autoRollsInput', '4');
      await page.dispatchEvent('#autoRollsInput', 'change');
      await page.waitForFunction(() => !document.getElementById('btnCopyAutoPrompt').disabled);
      await page.click('#btnCopyAutoPrompt');
      text = await clipboard(page);
      assert.match(text, /dice_auto_strategy/);
      assert.match(text, /"strategy": "martingale_capped"/);
      assert.match(text, /"rolls": 4/);
      assert.match(text, /"max_total_spend_poa": "\d+\.\d{6}"/);
      assert.match(text, /only works with "privkey"[\s\S]*ONLY if I explicitly confirm/);
      await page.fill('#autoRollsInput', '99');
      await page.dispatchEvent('#autoRollsInput', 'change');
      await page.waitForFunction(() => document.getElementById('btnCopyAutoPrompt').disabled);
      await page.fill('#autoRollsInput', '4');
      await page.dispatchEvent('#autoRollsInput', 'change');
      const before = Number(await page.textContent('#statTotalBets'));
      const auto = await mcp(srv.url, 'dice_auto_strategy', { strategy: 'flat', base_wager_poa: '1.000000', target_bps: 4950, direction: 'under', rolls: 3, client_seed: 'auto', max_total_spend_poa: '3.000000', privkey: player.privkey });
      assert.equal(auto.isError, false, JSON.stringify(auto.data).slice(0, 300));
      await page.waitForFunction((b) => Number(document.getElementById('statTotalBets').textContent) >= b + 3, before, { timeout: 5000 });

      // Chat
      await page.click('[data-feed-tab="chat"]');
      await page.waitForFunction(() => document.getElementById('btnCopyChatPrompt').disabled);
      await setInput(page, '#chatTextInput', 'gm from the e2e agent');
      await page.waitForFunction(() => !document.getElementById('btnCopyChatPrompt').disabled);
      await page.click('#btnCopyChatPrompt');
      const chatText = await clipboard(page);
      assert.match(chatText, /chat_send[\s\S]*gm from the e2e agent/);
      assert.match(chatText, /no transfer, no POA spent[\s\S]*"signature"/);
      t0 = Date.now();
      const chat = await mcp(srv.url, 'chat_send', { text: 'signed hello', sender_name: 'E2E', privkey: player.privkey });
      assert.equal(chat.isError, false);
      await page.waitForFunction(() => /signed hello/.test(document.getElementById('chatMessagesList').textContent), null, { timeout: 5000 });
      latency.chatMs = Date.now() - t0;
      assert.equal(await page.evaluate(() => window.__noReload), 'still-here');
    });

    await t.test('your PoA address is saved on this device and restored after a reload; clearing it removes it', async () => {
      assert.equal(await page.evaluate(() => localStorage.getItem('poaDice.playerAddress')), player.address);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction((a) => document.getElementById('playerAddressInput').value === a, player.address, { timeout: 5000 });
      await page.waitForFunction(() => !document.getElementById('btnCopyPrompt').disabled, null, { timeout: 10000 });
      await page.waitForFunction((a) => document.getElementById('promptPreview').textContent.includes(`My PoA address: ${a}`), player.address, { timeout: 5000 });
      const preview = await page.textContent('#promptPreview');
      assert.ok(preview.includes(`"address": "${player.address}"`), 'roll quote args carry the saved address');
      await setInput(page, '#playerAddressInput', '');
      assert.equal(await page.evaluate(() => localStorage.getItem('poaDice.playerAddress')), null);
      await page.waitForFunction(() => /My PoA address: not given/.test(document.getElementById('promptPreview').textContent));
    });

    assert.deepEqual(errors, [], 'no page errors');
  } finally {
    await browser.close();
    await srv.close();
    console.log(`# live-update latency (MCP call -> DOM updated, ms): ${JSON.stringify(latency)}`);
  }
});

test('browser e2e: bankroll 0 disables every roll and auto-bet with a reason', { skip, timeout: 60000 }, async () => {
  const srv = await startServer({ bootstrap: null });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  try {
    const { page } = await openPage(browser, srv.url);
    await page.waitForFunction(() => /0 available/.test(document.getElementById('promptBlockReason').textContent), null, { timeout: 8000 });
    assert.deepEqual(await countStates(page), { 1: false, 5: false, 100: false, 1000: false });
    assert.ok(await page.$eval('#btnCopyPrompt', (b) => b.disabled));
    await page.waitForFunction(() => document.getElementById('btnCopyAutoPrompt').disabled);
    // Staking is still possible (that is how the bank gets funded)
    assert.equal(await page.$eval('#btnSubmitDeposit', (b) => b.disabled), false);
  } finally {
    await browser.close();
    await srv.close();
  }
});

test('browser e2e: polling fallback keeps the page live when /api/stream is blocked', { skip, timeout: 60000 }, async () => {
  const p = genKeypair();
  const srv = await startServer({ balances: { [p.address]: '1000.000000' } });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext();
    await context.route('**/api/stream', (r) => r.abort());
    const page = await context.newPage();
    await page.goto(srv.url);
    await page.waitForFunction(() => document.getElementById('statTotalBets').textContent === '0');
    const t0 = Date.now();
    const r = await mcp(srv.url, 'dice_batch_roll', { count: 1, amount_poa: '1.000000', target_bps: 4950, direction: 'under', client_seed: 'poll', max_total_spend_poa: '1.000000', privkey: p.privkey });
    assert.equal(r.isError, false);
    await page.waitForFunction(() => document.getElementById('statTotalBets').textContent === '1', null, { timeout: 8000 });
    latency.pollingFallbackMs = Date.now() - t0;
    console.log(`# polling-fallback latency (ms): ${latency.pollingFallbackMs}`);
  } finally {
    await browser.close();
    await srv.close();
  }
});

test('engine: concurrent batch reservations cannot oversubscribe the bank', async () => {
  const engine = new BankrollEngine({ dataDir: null, initialBootstrapPoa: '1000.000000', bootstrapAddress: DEV_RESERVE_ADDRESS });
  const avail = engine.availableBankrollMicros;
  engine.reserveExposure('A', (avail * 3n) / 4n);
  assert.throws(() => engine.reserveExposure('B', avail / 2n), (e) => e.status === 409);
  engine.releaseExposure('A', null);
  engine.reserveExposure('B', avail / 2n);
  engine.releaseExposure('B', null);
  assert.equal(engine.availableBankrollMicros, avail);
});
