// @ts-nocheck
/**
 * Comprehensive headless Chrome browser inspection suite (Playwright).
 *
 * Verifies production web & crypto-app best practices against local ephemeral 127.0.0.1 servers:
 *  1. Strict CSP compliance (zero `securitypolicyviolation`, console, page, or HTTP 4xx/5xx errors)
 *     on both `/` and `/terms.html`
 *  2. Multi-viewport responsive layout inspection (Desktop 1440x900, Tablet 768x1024, Mobile 390x844):
 *     zero horizontal overflow, zero clipped panels, zero duplicate DOM IDs, all form controls labeled,
 *     zero orphan <label> tags
 *  3. Accessibility & keyboard interaction: tablist ArrowLeft/ArrowRight/Home/End navigation on both
 *     Bankroll & Live Feed tablists, Stake modal ARIA dialog + Escape dismissal + focus restoration
 *  4. Offline WebCrypto provably-fair roll verifier fallback matches Node `verifyRoll()` bit-for-bit
 *     when `/api/verify` is unreachable
 *  5. Live bet row click auto-populates Verify tab; chat scroll position is preserved when scrolled up
 *  6. Vault-hold (`VAULT HOLD` / `READ-ONLY`) displays `#vaultHoldNotice` and non-live header chip
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiceServer } from '../src/server.mjs';
import { DEV_RESERVE_ADDRESS } from '../src/bankroll-engine.mjs';
import { genKeypair, signRaw } from '../src/crypto-poa.mjs';
import { hashServerSeed, verifyRoll } from '../src/provably-fair.mjs';

function findBrowserBinary() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  const winRoots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
  for (const root of winRoots) {
    candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    candidates.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '/usr/bin/google-chrome';
}

const CHROME = findBrowserBinary();
let chromium = null;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  chromium = null;
}
const haveBrowser = Boolean(chromium) && fs.existsSync(CHROME);
if (!haveBrowser && process.env.REQUIRE_BROWSER) {
  throw new Error(`Browser inspection required but Chrome/playwright-core missing (${CHROME})`);
}
const skip = haveBrowser ? false : !chromium ? 'playwright-core not installed' : `headless Chrome not found at ${CHROME}`;
const shotsDir = process.env.INSPECT_SCREENSHOT_DIR || '';

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-inspect-${tag}-`));

async function bootServer(opts = {}) {
  const balances = {};
  const app = createDiceServer({
    dataDir: tmp('srv'),
    initialBootstrapPoa: '100000.000000',
    requireChain: true,
    chainSettlement: false,
    chainCacheMs: 0,
    chainFetch: async (address) => ({ address, balance: balances[address] ?? '500.000000', txs: [] }),
    ...opts
  });
  const info = await app.listen(0, '127.0.0.1');
  balances[app.engine.bankAddress] = '100000.000000';
  balances[DEV_RESERVE_ADDRESS] = '12.345678';
  return { app, url: info.url, close: () => app.close() };
}

test('browser inspection: responsive viewports, strict CSP, a11y, keyboard nav, offline WebCrypto verify, modal & chat scroll', { skip }, async (t) => {
  const srv = await bootServer();
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  // Seed realistic activity: 15 chat messages + 5 rolls so feed, chat scroll, and bet-to-verify click are populated
  const alice = genKeypair();
  for (let i = 1; i <= 15; i++) {
    const text = `Agent telemetry update #${i} - bankroll healthy`;
    const cr = await fetch(`${srv.url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, address: alice.address, signature: signRaw(text, alice.privRaw), senderName: 'InspectorBot' })
    });
    assert.equal(cr.status, 200, `seed chat ${i}`);
  }
  const rr = await (
    await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'dice_batch_roll',
          arguments: { count: 5, amount_poa: '1.000000', target_bps: 4950, direction: 'under', client_seed: 'inspect-seed', max_total_spend_poa: '5.000000', privkey: alice.privkey }
        }
      })
    })
  ).json();
  assert.equal(rr.result?.isError, false, JSON.stringify(rr));

  try {
    const viewports = [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'tablet', width: 768, height: 1024 },
      { name: 'mobile', width: 390, height: 844 }
    ];

    await t.test('multi-viewport layout, CSP, console/network errors, and DOM accessibility audit', async () => {
      for (const vp of viewports) {
        const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: srv.url });
        const page = await context.newPage();
        const cspViolations = [];
        const consoleErrors = [];
        const pageErrors = [];
        const failedRequests = [];

        await page.addInitScript(() => {
          window.__cspViolations = [];
          document.addEventListener('securitypolicyviolation', (e) => {
            window.__cspViolations.push({
              violatedDirective: e.violatedDirective,
              blockedURI: e.blockedURI,
              sourceFile: e.sourceFile,
              lineNumber: e.lineNumber
            });
          });
        });
        page.on('console', (m) => {
          if (m.type() === 'error') consoleErrors.push(m.text());
        });
        page.on('pageerror', (e) => pageErrors.push(String(e)));
        page.on('response', (res) => {
          if (res.status() >= 400 && !res.url().includes('/api/verify')) {
            failedRequests.push(`${res.status()} ${res.url()}`);
          }
        });

        await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(
          () => document.querySelectorAll('[data-roll-count]:not([disabled])').length > 0 && document.getElementById('sseStatusText')?.textContent === 'CHAIN LIVE',
          null,
          { timeout: 10000 }
        );
        // Wait for live chat and rolls to render
        await page.waitForFunction(
          () => document.querySelectorAll('#chatMessagesList .chat-msg').length >= 10 && document.querySelectorAll('#liveBetsTableBody tr[data-bet-txid]').length >= 3,
          null,
          { timeout: 10000 }
        );

        const audit = await page.evaluate(() => {
          const docOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
          const bodyOverflow = document.body.scrollWidth - document.body.clientWidth;

          // Duplicate IDs check
          const idCounts = new Map();
          for (const el of document.querySelectorAll('[id]')) {
            idCounts.set(el.id, (idCounts.get(el.id) || 0) + 1);
          }
          const duplicateIds = [...idCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id);

          // Orphan <label> check (every <label> must have a matching [for] target or wrap a control)
          const orphanLabels = [];
          for (const lbl of document.querySelectorAll('label')) {
            const forId = lbl.getAttribute('for');
            const hasNested = Boolean(lbl.querySelector('input, select, textarea'));
            const targetExists = Boolean(forId && document.getElementById(forId));
            if (!hasNested && !targetExists) {
              orphanLabels.push(lbl.textContent.trim());
            }
          }

          // Every visible input/select/textarea has an accessible name
          const unlabeledControls = [];
          for (const ctrl of document.querySelectorAll('input, select, textarea')) {
            const hasAria = Boolean(ctrl.getAttribute('aria-label') || ctrl.getAttribute('aria-labelledby'));
            const hasFor = Boolean(ctrl.id && document.querySelector(`label[for="${CSS.escape(ctrl.id)}"]`));
            const hasWrap = Boolean(ctrl.closest('label'));
            if (!hasAria && !hasFor && !hasWrap) {
              unlabeledControls.push(ctrl.id || ctrl.name || ctrl.tagName);
            }
          }

          // Check major panels stay within viewport width
          const clippedPanels = [];
          const vw = window.innerWidth;
          for (const p of document.querySelectorAll('.site-header, .site-notices, .stat-strip, .panel')) {
            const r = p.getBoundingClientRect();
            if (r.width > 0 && r.right > vw + 2) {
              clippedPanels.push({ cls: p.className, right: Math.round(r.right), vw });
            }
          }

          return {
            docOverflow,
            bodyOverflow,
            duplicateIds,
            orphanLabels,
            unlabeledControls,
            clippedPanels,
            cspViolations: window.__cspViolations || []
          };
        });

        cspViolations.push(...audit.cspViolations);
        if (shotsDir) {
          fs.mkdirSync(shotsDir, { recursive: true });
          await page.screenshot({ path: path.join(shotsDir, `inspect-${vp.name}-top.png`), fullPage: false, animations: 'disabled' });
          await page.screenshot({ path: path.join(shotsDir, `inspect-${vp.name}-full.png`), fullPage: true, animations: 'disabled' });
        }

        assert.deepEqual(cspViolations, [], `${vp.name}: zero CSP violations`);
        assert.deepEqual(consoleErrors, [], `${vp.name}: zero console errors`);
        assert.deepEqual(pageErrors, [], `${vp.name}: zero uncaught page errors`);
        assert.deepEqual(failedRequests, [], `${vp.name}: zero 4xx/5xx responses`);
        assert.ok(audit.docOverflow <= 1 && audit.bodyOverflow <= 1, `${vp.name}: zero horizontal overflow (doc=${audit.docOverflow}, body=${audit.bodyOverflow})`);
        assert.deepEqual(audit.duplicateIds, [], `${vp.name}: zero duplicate DOM IDs`);
        assert.deepEqual(audit.orphanLabels, [], `${vp.name}: zero orphan <label> elements`);
        assert.deepEqual(audit.unlabeledControls, [], `${vp.name}: every form control has an accessible name`);
        assert.deepEqual(audit.clippedPanels, [], `${vp.name}: zero clipped panels`);

        // Also inspect /terms.html under strict CSP on this viewport
        await page.goto(`${srv.url}/terms.html`, { waitUntil: 'domcontentloaded' });
        const termsAudit = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          cspViolations: window.__cspViolations || [],
          title: document.title
        }));
        assert.ok(termsAudit.overflow <= 1, `${vp.name} /terms.html overflow=${termsAudit.overflow}`);
        assert.deepEqual(termsAudit.cspViolations, [], `${vp.name} /terms.html zero CSP violations`);
        assert.match(termsAudit.title, /Terms/);

        await page.goto('about:blank').catch(() => {});
        await context.close();
      }
    });

    await t.test('interactive audit: keyboard tablist navigation, stake modal Escape/focus, chat scroll preservation, bet-row verify & offline WebCrypto fallback', async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: srv.url });
      const page = await context.newPage();
      await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => document.querySelectorAll('#chatMessagesList .chat-msg').length >= 10 && document.querySelectorAll('#liveBetsTableBody tr[data-bet-txid]').length >= 3,
        null,
        { timeout: 10000 }
      );

      // 1. Keyboard ArrowRight / ArrowLeft / End / Home navigation on Bankroll tablist
      const firstBankTab = page.locator('[data-bank-tab="deposit"]');
      await firstBankTab.focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.getAttribute('[data-bank-tab="withdraw"]', 'aria-selected'), 'true');
      assert.equal(await page.locator('#bankTabWithdraw').isVisible(), true);
      await page.keyboard.press('End');
      assert.equal(await page.getAttribute('[data-bank-tab="incentives"]', 'aria-selected'), 'true');
      await page.keyboard.press('Home');
      assert.equal(await page.getAttribute('[data-bank-tab="deposit"]', 'aria-selected'), 'true');

      // 2. Stake confirmation modal: opens on Copy stake prompt, Escape dismisses & restores focus
      await page.waitForFunction(() => !document.getElementById('btnSubmitDeposit').disabled, null, { timeout: 5000 });
      await page.click('#btnSubmitDeposit');
      await page.waitForSelector('#stakeConfirm:not(.hidden)', { timeout: 5000 });
      assert.equal(await page.getAttribute('#stakeConfirm .modal-card', 'role'), 'dialog');
      assert.equal(await page.getAttribute('#stakeConfirm .modal-card', 'aria-modal'), 'true');
      await page.keyboard.press('Escape');
      await page.waitForSelector('#stakeConfirm.hidden', { state: 'attached', timeout: 5000 });
      const activeIdAfterEsc = await page.evaluate(() => document.activeElement?.id || '');
      assert.equal(activeIdAfterEsc, 'btnSubmitDeposit', 'Escape restores focus to opener button');

      // 3. Chat scroll preservation: scroll to top of chat list, trigger snapshot refresh, confirm scrollTop stays near 0
      const scrollAfterPoll = await page.evaluate(async () => {
        const list = document.getElementById('chatMessagesList');
        list.scrollTop = 0;
        const before = list.scrollTop;
        await new Promise((r) => setTimeout(r, 150));
        return { before, after: list.scrollTop, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight };
      });
      assert.ok(scrollAfterPoll.scrollHeight > scrollAfterPoll.clientHeight, 'chat list is scrollable');
      assert.equal(scrollAfterPoll.after, 0, 'scrolling up in chat is preserved without snapping back to bottom');

      // 4. Click a bet row in Live Bets tab -> auto-fills Verify tab and switches to it
      await page.click('[data-feed-tab="bets"]');
      await page.locator('#liveBetsTableBody tr[data-bet-txid]').first().click();
      assert.equal(await page.getAttribute('[data-feed-tab="verify"]', 'aria-selected'), 'true');
      assert.ok((await page.inputValue('#verifyBetTxid')).length > 10, 'bet txid auto-filled');

      // 5. Offline WebCrypto verifier fallback matches Node verifyRoll() bit-for-bit when /api/verify is offline
      const testSeed = 'deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567';
      const testSeedHash = hashServerSeed(testSeed);
      const testBetTxid = 'a'.repeat(64);
      const expected = verifyRoll({
        serverSeed: testSeed,
        serverSeedHash: testSeedHash,
        clientSeed: 'offline-webcrypto-test',
        nonce: 42,
        betTxid: testBetTxid,
        targetBps: 4950,
        direction: 'under'
      });

      await page.route('**/api/verify', (route) => route.abort('failed'));
      await page.fill('#verifyServerSeed', testSeed);
      await page.fill('#verifyServerSeedHash', testSeedHash);
      await page.fill('#verifyClientSeed', 'offline-webcrypto-test');
      await page.fill('#verifyNonce', '42');
      await page.fill('#verifyBetTxid', testBetTxid);
      await page.fill('#verifyTargetBps', '4950');
      await page.selectOption('#verifyDirection', 'under');
      await page.click('#btnRunVerify');
      await page.waitForFunction(
        () => /verifiedLocally/.test(document.getElementById('verifyResultPre').textContent || ''),
        null,
        { timeout: 5000 }
      );
      const browserOut = JSON.parse(await page.textContent('#verifyResultPre'));
      assert.equal(browserOut.valid, true);
      assert.equal(browserOut.seedHashMatches, true);
      assert.equal(browserOut.verifiedLocally, true);
      assert.equal(browserOut.serverSeedHash, expected.serverSeedHash);
      assert.equal(browserOut.hmacHex, expected.hmacHex);
      assert.equal(browserOut.uint64Value, expected.uint64Value);
      assert.equal(browserOut.rollBps, expected.rollBps);
      assert.equal(browserOut.rollDisplay, expected.rollDisplay);
      assert.equal(browserOut.targetDisplay, expected.targetDisplay);
      assert.equal(browserOut.winChanceBps, expected.winChanceBps);
      assert.equal(browserOut.won, expected.won);

      // 6. Security hygiene endpoints & headers (security.txt, robots.txt, favicon 204, HSTS on HTTPS, no wildcard CORS on admin)
      const secTxt = await fetch(`${srv.url}/.well-known/security.txt`);
      assert.equal(secTxt.status, 200);
      assert.match(await secTxt.text(), /Contact:/);

      const robots = await fetch(`${srv.url}/robots.txt`);
      assert.equal(robots.status, 200);
      assert.match(await robots.text(), /Disallow: \/api\/admin\//);

      const fav = await fetch(`${srv.url}/favicon.ico`);
      assert.equal(fav.status, 204);

      const httpsHtml = await fetch(`${srv.url}/`, { headers: { 'X-Forwarded-Proto': 'https' } });
      assert.equal(httpsHtml.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
      assert.equal(httpsHtml.headers.get('cross-origin-opener-policy'), 'same-origin');

      const adminPreflight = await fetch(`${srv.url}/api/admin/repayments/resolve`, { method: 'OPTIONS' });
      assert.equal(adminPreflight.headers.get('access-control-allow-origin'), null, 'admin preflight must NOT emit wildcard CORS');
      const adminDenied = await fetch(`${srv.url}/api/admin/repayments/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(adminDenied.headers.get('access-control-allow-origin'), null, 'admin response must NOT emit wildcard CORS');

      await context.close();
    });

    await t.test('vault-hold / read-only server shows VAULT HOLD / READ-ONLY header chip and #vaultHoldNotice', async () => {
      // Boot a chain-mode server WITHOUT a bank privkey -> enters READ-ONLY mode cleanly
      const roApp = createDiceServer({
        dataDir: tmp('ro'),
        watcherMode: 'live',
        bankEnv: {},
        storeEnv: {},
        chainCacheMs: 0,
        chainFetch: async (address) => ({ address, balance: '100.000000', txs: [] })
      });
      const roInfo = await roApp.listen(0, '127.0.0.1');
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      try {
        await page.goto(roInfo.url, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(
          () => document.getElementById('sseStatusText')?.textContent === 'READ-ONLY',
          null,
          { timeout: 10000 }
        );
        await page.waitForSelector('#siteNotices > #vaultHoldNotice:not(.hidden)', { timeout: 5000 });
        const holdText = await page.textContent('#vaultHoldText');
        assert.ok(holdText.length > 10, `vault hold notice populated: ${holdText}`);
        if (shotsDir) {
          await page.screenshot({ path: path.join(shotsDir, 'inspect-readonly-hold.png'), fullPage: false, animations: 'disabled' });
        }
      } finally {
        await context.close();
        await roApp.close();
      }
    });
  } finally {
    await browser.close();
    await srv.close();
  }
});
