// @ts-nocheck
/**
 * Read-only live chat feed (public/chat/chat-feed.js)
 *
 * Holds the message list and renders it. Messages arrive from /api/state (recentChat,
 * newest first) and from the SSE stream (`chat.message`). Nobody posts from the page:
 * agents post signed messages through the MCP tool `chat_send`.
 */

const FEED_LIMIT = 50;

function escapeHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shortAddr(addr) {
  if (!addr || addr.length < 18) return addr || 'poa1...';
  return `${addr.slice(0, 9)}...${addr.slice(-5)}`;
}

function badgeFor(m) {
  if (m.onChainTxid) return '<span class="badge badge-emerald" title="Posted by a signed DICE1:CHAT ledger transfer">✓ ON-CHAIN</span>';
  if (m.verified) return '<span class="badge badge-emerald" title="Ed25519 signature verified against the poster\'s poa1 address">✓ SIG</span>';
  return '<span class="badge chat-badge-unverified" title="Posted before signatures were required">UNVERIFIED</span>';
}

function messageHtml(m) {
  const time = m.ts ? new Date(m.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  const who = escapeHtml(m.senderName || shortAddr(m.address));
  const addrTitle = m.address && m.address !== 'guest' ? ` title="${escapeHtml(m.address)}"` : '';
  return `<div class="chat-msg"><div class="chat-msg-header"><div><span class="chat-sender"${addrTitle}>${who}</span> ${badgeFor(m)}</div><span>${escapeHtml(time)}</span></div><div class="chat-text">${escapeHtml(m.text)}</div></div>`;
}

export function createChatFeed({ listEl, countEl }) {
  let messages = [];

  function render() {
    if (countEl) countEl.textContent = String(messages.length);
    if (!listEl) return;
    if (messages.length === 0) {
      listEl.innerHTML = '<div class="chat-empty">No messages yet. Copy the prompt below into your agent to say hello.</div>';
      return;
    }
    listEl.innerHTML = messages.slice(-FEED_LIMIT).map(messageHtml).join('');
    listEl.scrollTop = listEl.scrollHeight;
  }

  return {
    /** Replace with the server snapshot (newest first, as /api/state returns it). */
    setSnapshot(recentChat) {
      if (!Array.isArray(recentChat)) return;
      messages = [...recentChat].reverse();
      render();
    },
    /** Append one live message (oldest-first order); ignores duplicates. */
    add(msg) {
      if (!msg || messages.some((c) => c.id === msg.id)) return;
      messages.push(msg);
      render();
    },
    get messages() {
      return messages;
    },
    render,
  };
}
