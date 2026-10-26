// @ts-nocheck
/**
 * Signed agent chat + dismissible legal notice.
 *
 * - MCP chat_read works; chat_send accepts a locally signed post and rejects unsigned,
 *   bad-signature, wrong-address, privkey and replayed posts. POST /api/chat follows the same rules.
 * - The "Join the chat with your agent" prompt names the real MCP URL, tools and argument
 *   names, and its embedded local signer produces signatures the server accepts.
 * - The legal notice dismissal persists in storage.
 * Every key here is a throwaway generated inside the test; nothing touches the real chain.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDiceServer } from '../src/server.mjs';
import { genKeypair, signRaw, verifyRaw } from '../src/crypto-poa.mjs';
import { validateSignedChat } from '../src/chat.mjs';
import { MCP_TOOLS } from '../src/mcp-server.mjs';
import { buildChatJoinPrompt, CHAT_SIGNER_SCRIPT } from '../public/chat/chat-join-prompt.js';
import { createChatFeed } from '../public/chat/chat-feed.js';
import { LEGAL_NOTICE_KEY, dismissNotice, initDismissibleNotice, isNoticeDismissed } from '../public/notice-dismiss.js';

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-chat-${tag}-`));

function memoryStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

function fakeEl() {
  const handlers = {};
  return { hidden: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener: (t, fn) => { handlers[t] = fn; }, click: () => handlers.click?.() };
}

let rpcId = 0;
async function mcp(url, name, args = {}) {
  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } })
  });
  const body = await res.json();
  return { isError: Boolean(body.result?.isError), data: JSON.parse(body.result?.content?.[0]?.text || '{}') };
}

test('legal notice: dismissal is stored and survives a reload', () => {
  const storage = memoryStorage();
  assert.equal(isNoticeDismissed(storage), false);
  const notice = fakeEl();
  const close = fakeEl();
  const root = fakeEl();
  initDismissibleNotice({ noticeEl: notice, closeEl: close, storage, rootEl: root });
  assert.equal(notice.hidden, false, 'visible until closed');
  close.click();
  assert.equal(notice.hidden, true);
  assert.equal(storage.getItem(LEGAL_NOTICE_KEY), '1');
  assert.ok('data-legal-dismissed' in root.attrs);
  // "reload": a fresh element with the same storage starts hidden
  const again = fakeEl();
  initDismissibleNotice({ noticeEl: again, closeEl: fakeEl(), storage });
  assert.equal(again.hidden, true);
});

test('legal notice: blocked storage never throws (hidden for this view only)', () => {
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(isNoticeDismissed(blocked), false);
  assert.equal(dismissNotice(blocked), false);
  const notice = fakeEl();
  const close = fakeEl();
  initDismissibleNotice({ noticeEl: notice, closeEl: close, storage: blocked });
  close.click();
  assert.equal(notice.hidden, true);
  assert.equal(isNoticeDismissed(null), false);
});

test('index.html: the notice has a close button and the head script uses the same storage key', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="legalNotice"[\s\S]*Governance token utility only[\s\S]*id="legalNoticeClose"/);
  assert.ok(html.includes(`localStorage.getItem('${LEGAL_NOTICE_KEY}') === '1'`));
  for (const id of ['chatForm', 'chatTextInput', 'chatSenderInput', 'chatIsAgentCheck', 'btnCopyChatPrompt']) {
    assert.ok(!html.includes(`id="${id}"`), `${id} removed`);
  }
});

test('validateSignedChat: accepts a valid signature and rejects everything else', () => {
  const a = genKeypair();
  const b = genKeypair();
  const text = 'gm from a signed agent';
  const sig = signRaw(text, a.privRaw);
  assert.equal(validateSignedChat({ text, address: a.address, signature: sig }).valid, true);
  const cases = [
    [{ text, address: a.address }, 'missing_signature'],
    [{ text, signature: sig }, 'missing_address'],
    [{ text, address: 'poa1nope', signature: sig }, 'bad_address'],
    [{ text, address: b.address, signature: sig }, 'bad_signature'],
    [{ text: text + '!', address: a.address, signature: sig }, 'bad_signature'],
    [{ text, address: a.address, signature: 'abc' }, 'bad_signature'],
    [{ text, address: a.address, signature: sig, privkey: a.privkey }, 'privkey_refused'],
    [{ text: '   ', address: a.address, signature: sig }, 'empty'],
    [{ text: 'x'.repeat(241), address: a.address, signature: sig }, 'too_long']
  ];
  for (const [args, code] of cases) assert.equal(validateSignedChat(args).code, code, JSON.stringify(Object.keys(args)));
  const html = '<b>hi</b>';
  const r = validateSignedChat({ text: html, address: a.address, signature: signRaw(html, a.privRaw) });
  assert.equal(r.code, 'text_not_plain');
  assert.equal(r.cleaned_text, 'bhi/b');
  assert.equal(validateSignedChat({ text, address: a.address, signature: sig }, { recentMessages: [{ signature: sig }] }).code, 'replayed_signature');
});

test('MCP chat tools: schema documents signed posts; read works; signed accepted; unsigned/bad/privkey/replay rejected', async () => {
  const send = MCP_TOOLS.find((t) => t.name === 'chat_send');
  assert.deepEqual(send.inputSchema.required, ['text', 'address', 'signature']);
  assert.equal(send.inputSchema.properties.privkey, undefined, 'chat_send has no privkey argument');
  assert.match(send.description, /LOCALLY[\s\S]*Ed25519[\s\S]*Base58/);
  assert.ok(MCP_TOOLS.find((t) => t.name === 'chat_read'));

  const app = createDiceServer({ dataDir: tmp('mcp'), initialBootstrapPoa: '1000.000000' });
  const info = await app.listen(0, '127.0.0.1');
  try {
    const agent = genKeypair();
    const text = 'hello from the MCP chat test';
    const signature = signRaw(text, agent.privRaw);

    const read0 = await mcp(info.url, 'chat_read', { limit: 5 });
    assert.equal(read0.isError, false);
    assert.match(read0.data.securityNotice, /UNTRUSTED_CHAT_DATA/);
    const before = read0.data.messages.length;

    const ok = await mcp(info.url, 'chat_send', { text, address: agent.address, signature, sender_name: 'Test<Agent>' });
    assert.equal(ok.isError, false, JSON.stringify(ok.data));
    assert.equal(ok.data.verified, true);
    assert.equal(ok.data.address, agent.address);
    assert.equal(ok.data.senderName, 'TestAgent');
    assert.equal(ok.data.isAgent, true);

    const unsigned = await mcp(info.url, 'chat_send', { text: 'no signature here' });
    assert.equal(unsigned.isError, true);
    assert.equal(unsigned.data.code, 'missing_address');
    const unsignedWithAddr = await mcp(info.url, 'chat_send', { text: 'no signature here', address: agent.address });
    assert.equal(unsignedWithAddr.data.code, 'missing_signature');
    const forged = await mcp(info.url, 'chat_send', { text: 'forged', address: genKeypair().address, signature: signRaw('forged', agent.privRaw) });
    assert.equal(forged.isError, true);
    assert.equal(forged.data.code, 'bad_signature');
    const withKey = await mcp(info.url, 'chat_send', { text: 'with key', privkey: agent.privkey });
    assert.equal(withKey.data.code, 'privkey_refused');
    const replay = await mcp(info.url, 'chat_send', { text, address: agent.address, signature });
    assert.equal(replay.data.code, 'replayed_signature');

    const read1 = await mcp(info.url, 'chat_read', { limit: 50 });
    assert.equal(read1.data.messages.length, before + 1, 'only the signed post was stored');
    assert.equal(read1.data.messages[0].text, text);
    assert.equal(read1.data.messages[0].verified, true);
    assert.ok(verifyRaw(read1.data.messages[0].text, read1.data.messages[0].signature, read1.data.messages[0].address), 'stored signature verifies against the stored text');
  } finally {
    await info.close?.();
    app.server.close();
  }
});

test('POST /api/chat: unsigned web-form posts are refused (400); signed posts work', async () => {
  const app = createDiceServer({ dataDir: tmp('http'), initialBootstrapPoa: '1000.000000' });
  const info = await app.listen(0, '127.0.0.1');
  try {
    const post = (body) => fetch(`${info.url}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const human = await post({ senderName: 'Guest', text: 'hey wrold', isAgent: false });
    assert.equal(human.status, 400);
    assert.equal((await human.json()).code, 'missing_address');
    const k = genKeypair();
    const keyed = await post({ text: 'did i win', privkey: k.privkey });
    assert.equal(keyed.status, 400);
    assert.equal((await keyed.json()).code, 'privkey_refused');
    const good = await post({ text: 'did i win', address: k.address, signature: signRaw('did i win', k.privRaw), sender_name: 'CLI' });
    assert.equal(good.status, 200);
    const j = await good.json();
    assert.equal(j.message.verified, true);
    const list = await fetch(`${info.url}/api/chat?limit=10`).then((r) => r.json());
    assert.deepEqual(list.messages.map((m) => m.text), ['did i win']);
  } finally {
    await info.close?.();
    app.server.close();
  }
});

test('join prompt: real MCP URL, tool names and args; its local signer makes signatures the server accepts', async () => {
  const k = genKeypair();
  const prompt = buildChatJoinPrompt({ mcpUrl: 'https://poadice.grok.me/mcp', address: k.address, pageUrl: 'https://poadice.grok.me/' });
  assert.ok(prompt.includes('MCP server: https://poadice.grok.me/mcp'));
  assert.ok(prompt.includes(`My PoA address: ${k.address}`));
  assert.match(prompt, /call `chat_read` with \{"limit": 25\}/);
  assert.match(prompt, /Call `chat_send` with exactly:/);
  for (const field of ['"text"', '"address"', '"signature"', '"sender_name"']) assert.ok(prompt.includes(field), field);
  assert.ok(prompt.includes(`"address": "${k.address}"`));
  assert.match(prompt, /never send my private key/);
  assert.ok(!/coming soon|roadmap/i.test(prompt));
  const anon = buildChatJoinPrompt({ mcpUrl: 'https://poadice.grok.me/mcp' });
  assert.match(anon, /use the poa1 address of my own PoA wallet/);
  assert.ok(anon.includes('"address": "<my poa1 address>"'));

  // Run the embedded signer exactly as an agent would.
  const dir = tmp('signer');
  const script = path.join(dir, 'sign-chat.mjs');
  const wallet = path.join(dir, 'poa');
  fs.writeFileSync(script, CHAT_SIGNER_SCRIPT);
  fs.writeFileSync(wallet, JSON.stringify({ address: k.address, privkey: k.privkey }), { mode: 0o600 });
  const text = 'gm from the copied prompt ✓';
  const sig = execFileSync(process.execPath, [script, wallet, text], { encoding: 'utf8' }).trim();
  assert.equal(sig, signRaw(text, k.privRaw), 'same Base58 signature as the server-side reference');
  assert.ok(!sig.includes(k.privkey), 'signer prints only the signature');

  const app = createDiceServer({ dataDir: tmp('signer-srv'), initialBootstrapPoa: '1000.000000' });
  const info = await app.listen(0, '127.0.0.1');
  try {
    const r = await mcp(info.url, 'chat_send', { text, address: k.address, signature: sig, sender_name: 'Prompt' });
    assert.equal(r.isError, false, JSON.stringify(r.data));
    assert.equal(r.data.verified, true);
  } finally {
    await info.close?.();
    app.server.close();
  }
});

test('chat feed: snapshot + live add, no duplicates, escapes HTML, badges', () => {
  const listEl = { innerHTML: '', scrollTop: 0, scrollHeight: 10 };
  const countEl = { textContent: '' };
  const feed = createChatFeed({ listEl, countEl });
  feed.render();
  assert.match(listEl.innerHTML, /No messages yet/);
  feed.setSnapshot([
    { id: 'b', text: 'second', senderName: 'B', verified: true, signature: 's', ts: 2 },
    { id: 'a', text: '<img src=x>', senderName: 'A', ts: 1, onChainTxid: 'tx' }
  ]);
  assert.equal(countEl.textContent, '2');
  assert.deepEqual(feed.messages.map((m) => m.id), ['a', 'b']);
  assert.ok(listEl.innerHTML.includes('&lt;img src=x&gt;'));
  assert.match(listEl.innerHTML, /ON-CHAIN[\s\S]*✓ SIG/);
  feed.add({ id: 'b', text: 'dup' });
  feed.add({ id: 'c', text: 'old unsigned', ts: 3 });
  assert.equal(countEl.textContent, '3');
  assert.match(listEl.innerHTML, /UNVERIFIED/);
});
