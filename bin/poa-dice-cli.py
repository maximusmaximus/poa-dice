#!/usr/bin/env python3
"""
bin/poa-dice-cli.py — Cross-Platform Zero-Leak Python 3.7+ CLI for POA Dice

Security Invariant:
  - Never prints, logs, or echoes ~/.poa/key, ~/.poa-dice-wallet/key, pk_*, psk_*, or raw private keys.
  - Works with the poa-dice HTTP/MCP API, delegates to bin/poa-dice-cli.mjs with local Ed25519 signing,
    or runs 100% offline (--offline).
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

DEV_RESERVE_ADDRESS = "poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U"
DEV_FEE_BPS = 10  # 0.1% (10 bps)
UNBIASED_UINT64_MAX = 18446744073709550000

SECRET_PATTERNS = [
    re.compile(r"\bpk_[A-Za-z0-9_-]{8,}\b"),
    re.compile(r"\bpsk_[A-Za-z0-9_-]{8,}\b"),
]


def redact_secrets(text: str) -> str:
    if not text:
        return ""
    out = str(text)
    for pat in SECRET_PATTERNS:
        out = pat.sub("[REDACTED_SECRET]", out)
    for rel in ((".poa", "key"), (".poa-dice-wallet", "key")):
        key_path = Path.home().joinpath(*rel)
        if key_path.is_file():
            try:
                raw_key = key_path.read_text(encoding="utf-8").strip()
                if len(raw_key) >= 16 and raw_key in out:
                    out = out.replace(raw_key, "[REDACTED_WALLET_KEY]")
            except Exception:
                pass
    return out


def verify_roll_local(
    server_seed: str,
    client_seed: str,
    nonce: int,
    bet_txid: str,
) -> Dict[str, Any]:
    """
    Standalone Python implementation of POA Dice HMAC-SHA256 unbiased roll.
    Matches src/provably-fair.mjs computeRoll() byte-for-byte.
    """
    msg = f"{client_seed}:{nonce}:{bet_txid}".encode("utf-8")
    digest = hmac.new(server_seed.encode("utf-8"), msg, hashlib.sha256).digest()
    selected_val = None
    for offset in (0, 8, 16, 24):
        candidate = int.from_bytes(digest[offset : offset + 8], byteorder="big", signed=False)
        if candidate < UNBIASED_UINT64_MAX:
            selected_val = candidate
            break
    if selected_val is None:
        selected_val = int.from_bytes(digest[:8], byteorder="big", signed=False)
    roll_bps = selected_val % 10000
    return {
        "rollBps": roll_bps,
        "rollDisplay": f"{roll_bps // 100:02d}.{roll_bps % 100:02d}",
        "serverSeedHash": hashlib.sha256(server_seed.encode("utf-8")).hexdigest(),
        "hmacHex": digest.hex(),
    }


def run_node_cli(args_list: List[str]) -> Dict[str, Any]:
    repo_root = Path(__file__).resolve().parent.parent
    cli_mjs = repo_root / "bin" / "poa-dice-cli.mjs"
    proc = subprocess.run(
        ["node", str(cli_mjs)] + args_list,
        cwd=str(repo_root),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
    )
    raw = redact_secrets(proc.stdout.strip() or proc.stderr.strip())
    try:
        parsed = json.loads(raw)
        if proc.returncode != 0 and "ok" not in parsed:
            parsed["ok"] = False
        return parsed
    except Exception:
        return {"ok": proc.returncode == 0, "output": raw}


def run_self_test() -> int:
    fake_pk = "pk_" + "1234567890abcdefghijklmnop"
    fake_psk = "psk_" + "abcdef1234567890abcdef"
    sample = f"secret {fake_pk} and {fake_psk}"
    redacted = redact_secrets(sample)
    assert fake_pk[:13] not in redacted, "pk_ secret leaked"
    assert fake_psk[:16] not in redacted, "psk_ secret leaked"

    r1 = verify_roll_local("server-seed-alpha", "client-seed-beta", 1, "a" * 64)
    r2 = verify_roll_local("server-seed-alpha", "client-seed-beta", 1, "a" * 64)
    assert r1["rollBps"] == r2["rollBps"], "Roll must be deterministic"
    assert 0 <= r1["rollBps"] <= 9999, "Roll out of bounds"

    assert DEV_RESERVE_ADDRESS == "poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U"
    assert DEV_FEE_BPS == 10

    print(
        json.dumps(
            {
                "ok": True,
                "selfTest": "PASSED",
                "devReserveAddress": DEV_RESERVE_ADDRESS,
                "devFeeBps": DEV_FEE_BPS,
                "sampleRoll": r1,
            },
            indent=2,
        )
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="POA Dice Zero-Leak Python CLI")
    parser.add_argument("--self-test", action="store_true", help="Run built-in security & math self-test")
    parser.add_argument(
        "command",
        nargs="?",
        default="status",
        help=(
            "Command: status, quote-bet, bet, quote-batch, batch-roll, auto-bet, verify-roll, audit, "
            "quote-deposit, stake, quote-withdraw, withdraw, claim-yield, position, incentives, "
            "chat, chat-read, feed, tx-templates, tx-status, wallet-balance, sweep-dev, offline-tx"
        ),
    )
    parser.add_argument("--server", default=None, help="POA Dice server URL")
    parser.add_argument("--node", default=None, help="Minepoa node URL")
    parser.add_argument("--wallet", default=None, help="Wallet key file or directory path")
    parser.add_argument("--dataDir", dest="data_dir", default=None, help="Local offline data directory")
    parser.add_argument("--admin-token", dest="admin_token", default=None, help="Admin Bearer token")
    parser.add_argument("--to", default=None, help="Bank vault address for offline-tx")
    parser.add_argument("--address", default=None, help="Target POA address")
    parser.add_argument("--txid", default=None, help="Transaction ID (64 hex)")
    parser.add_argument("--tool", default=None, help="Tool name for tx-templates")
    parser.add_argument("--action", default=None, help="Memo action for offline-tx (BET, LP_ADD, LP_WITHDRAW, CLAIM, CHAT)")
    parser.add_argument("--amount", default=None, help="Amount in POA")
    parser.add_argument("--under", type=float, default=None, help="Roll Under target")
    parser.add_argument("--over", type=float, default=None, help="Roll Over target")
    parser.add_argument("--epochs", type=int, default=None, help="Conviction lock epochs")
    parser.add_argument("--ref", default=None, help="Referrer poa1 address for LP stake")
    parser.add_argument("--bps", type=int, default=None, help="Withdraw share basis points (1..10000)")
    parser.add_argument("--shares", default=None, help="Exact share units to withdraw")
    parser.add_argument("--count", type=int, default=None, help="Batch roll count")
    parser.add_argument("--wait", type=int, default=None, help="Wait timeout seconds for chain confirmation")
    parser.add_argument("--limit", type=int, default=None, help="Max items returned (chat-read / feed)")
    parser.add_argument("--name", default=None, help="Sender display name for signed chat")
    parser.add_argument("--seed", default=None, help="Client seed")
    parser.add_argument("--server-seed", dest="server_seed", default=None, help="Revealed server seed")
    parser.add_argument("--seed-hash", dest="seed_hash", default=None, help="Expected server seed SHA-256")
    parser.add_argument("--nonce", type=int, default=None, help="Nonce")
    parser.add_argument("--parents", default=None, help="Comma-separated parent txids for offline-tx")
    parser.add_argument("--strategy", default=None, help="Auto-bet strategy")
    parser.add_argument("--rolls", type=int, default=None, help="Auto-bet roll count")
    parser.add_argument("--stop-on-profit", dest="stop_on_profit", default=None, help="Take-profit in POA")
    parser.add_argument("--stop-on-loss", dest="stop_on_loss", default=None, help="Stop-loss in POA")
    parser.add_argument("--max-spend", dest="max_spend", default=None, help="Max total spend in POA")
    parser.add_argument("--sequential", action="store_true", help="Confirm-per-roll sequential batch")
    parser.add_argument("--compound", action="store_true", help="Trigger epoch incentive compounding (admin)")
    parser.add_argument("--dry-run", dest="dry_run", action="store_true", help="Dry run (claim-yield)")
    parser.add_argument("--message", default=None, help="Chat message")
    parser.add_argument("--offline", action="store_true", help="Force website-independent offline execution")

    args = parser.parse_args()
    if args.self_test:
        return run_self_test()

    node_args = [args.command]
    optional_pairs = [
        ("--server", args.server),
        ("--node", args.node),
        ("--wallet", args.wallet),
        ("--dataDir", args.data_dir),
        ("--admin-token", args.admin_token),
        ("--to", args.to),
        ("--address", args.address),
        ("--txid", args.txid),
        ("--tool", args.tool),
        ("--action", args.action),
        ("--amount", args.amount),
        ("--over", args.over),
        ("--under", args.under if args.over is None else None),
        ("--epochs", args.epochs),
        ("--ref", args.ref),
        ("--bps", args.bps),
        ("--shares", args.shares),
        ("--count", args.count),
        ("--wait", args.wait),
        ("--limit", args.limit),
        ("--name", args.name),
        ("--seed", args.seed),
        ("--server-seed", args.server_seed),
        ("--seed-hash", args.seed_hash),
        ("--nonce", args.nonce),
        ("--parents", args.parents),
        ("--strategy", args.strategy),
        ("--rolls", args.rolls),
        ("--stop-on-profit", args.stop_on_profit),
        ("--stop-on-loss", args.stop_on_loss),
        ("--max-spend", args.max_spend),
        ("--message", args.message),
    ]
    for flag, val in optional_pairs:
        if val is not None:
            node_args += [flag, str(val)]
    if args.sequential:
        node_args.append("--sequential")
    if args.compound:
        node_args.append("--compound")
    if args.dry_run:
        node_args.append("--dry-run")
    if args.offline:
        node_args.append("--offline")

    res = run_node_cli(node_args)
    print(redact_secrets(json.dumps(res, indent=2)))
    return 0 if res.get("ok", True) else 1


if __name__ == "__main__":
    sys.exit(main())
