#!/usr/bin/env python3
"""
bin/poa-dice-cli.py — Cross-Platform Zero-Leak Python 3.7+ CLI for POA Dice

Security Invariant:
  - Never prints, logs, or echoes ~/.poa/key, pk_*, psk_*, or raw private keys.
  - Works with the poa-dice HTTP API, or delegates to bin/poa-dice-cli.mjs --offline
    when the website is unreachable, or builds pure DICE1:* on-chain memos.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

DEV_RESERVE_ADDRESS = "poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U"
DEV_FEE_BPS = 10  # 0.1% (10 bps)

SECRET_PATTERNS = [
    re.compile(r"\bpk_[A-Za-z0-9]{16,}\b"),
    re.compile(r"\bpsk_[A-Za-z0-9]{16,}\b"),
]


def redact_secrets(text: str) -> str:
    if not text:
        return ""
    out = str(text)
    for pat in SECRET_PATTERNS:
        out = pat.sub("[REDACTED_SECRET]", out)
    # Redact ~/.poa/key if loaded
    key_path = Path.home() / ".poa" / "key"
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
    """Standalone Python implementation of POA Dice HMAC-SHA256 unbiased roll."""
    unbiased_max = 18446744073709550000
    attempt = 0
    while True:
        suffix = "" if attempt == 0 else f":{attempt}"
        msg = f"{client_seed}:{nonce}:{bet_txid}{suffix}".encode("utf-8")
        digest = hmac.new(server_seed.encode("utf-8"), msg, hashlib.sha256).digest()
        val = int.from_bytes(digest[:8], byteorder="big", signed=False)
        if val < unbiased_max:
            roll_bps = val % 10000
            return {
                "rollBps": roll_bps,
                "rollDisplay": f"{roll_bps / 100:.2f}",
                "serverSeedHash": hashlib.sha256(server_seed.encode("utf-8")).hexdigest(),
                "hmacHex": digest.hex(),
            }
        attempt += 1


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
        return json.loads(raw)
    except Exception:
        return {"ok": proc.returncode == 0, "output": raw}


def run_self_test() -> int:
    # 1. Verify secret redaction
    sample = "secret pk_1234567890abcdefghijklmnop and psk_abcdef1234567890abcdef"
    redacted = redact_secrets(sample)
    assert "pk_1234567890" not in redacted, "pk_ secret leaked"
    assert "psk_abcdef123456" not in redacted, "psk_ secret leaked"

    # 2. Verify deterministic HMAC-SHA256 roll math
    r1 = verify_roll_local("server-seed-alpha", "client-seed-beta", 1, "a" * 64)
    r2 = verify_roll_local("server-seed-alpha", "client-seed-beta", 1, "a" * 64)
    assert r1["rollBps"] == r2["rollBps"], "Roll must be deterministic"
    assert 0 <= r1["rollBps"] <= 9999, "Roll out of bounds"

    # 3. Verify 0.1% dev reserve constant
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
    parser.add_argument("command", nargs="?", default="status", help="Command: status, quote-bet, bet, stake, withdraw, chat, memo")
    parser.add_argument("--amount", default="10.000000", help="Amount in POA")
    parser.add_argument("--under", type=float, default=49.50, help="Roll Under target")
    parser.add_argument("--over", type=float, default=None, help="Roll Over target")
    parser.add_argument("--epochs", type=int, default=4, help="Conviction lock epochs")
    parser.add_argument("--bps", type=int, default=10000, help="Withdraw share basis points (1..10000)")
    parser.add_argument("--seed", default="py-agent-seed-01", help="Client seed")
    parser.add_argument("--message", default="GM from Python agent", help="Chat message")
    parser.add_argument("--offline", action="store_true", help="Force website-independent offline execution")

    args = parser.parse_args()
    if args.self_test:
        return run_self_test()

    node_args = [args.command, "--amount", str(args.amount)]
    if args.over is not None:
        node_args += ["--over", str(args.over)]
    else:
        node_args += ["--under", str(args.under)]
    node_args += [
        "--epochs",
        str(args.epochs),
        "--bps",
        str(args.bps),
        "--seed",
        str(args.seed),
        "--message",
        str(args.message),
    ]
    if args.offline:
        node_args.append("--offline")

    res = run_node_cli(node_args)
    print(redact_secrets(json.dumps(res, indent=2)))
    return 0 if res.get("ok", True) else 1


if __name__ == "__main__":
    sys.exit(main())
