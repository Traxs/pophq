#!/usr/bin/env python3
"""Minimal standard-library client for POP HQ's scoped result agent API."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def request(method: str, path: str, body: object | None = None, idempotency_key: str | None = None) -> object:
    base = os.environ.get("POPHQ_URL", "").rstrip("/")
    # POPHQ_AGENT_TOKEN remains a compatibility fallback for credentials configured
    # before the UI adopted the clearer "Bot token" name.
    token = os.environ.get("POPHQ_BOT_TOKEN", "") or os.environ.get("POPHQ_AGENT_TOKEN", "")
    if not base or not token:
        raise SystemExit("Set POPHQ_URL and POPHQ_BOT_TOKEN.")
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    req = urllib.request.Request(f"{base}/v1{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try:
            problem = json.load(error)
            message = problem.get("title", str(problem))
        except (json.JSONDecodeError, UnicodeDecodeError):
            message = f"HTTP {error.code}"
        raise SystemExit(f"POP HQ refused the request: {message}") from None


def load_payload(path: str) -> dict[str, object]:
    value = json.load(sys.stdin) if path == "-" else json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise SystemExit("Result payload must be one JSON object.")
    return value


def main() -> None:
    parser = argparse.ArgumentParser(prog="s26", description="POP HQ result agent")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("doctor")
    context = sub.add_parser("result-context")
    context.add_argument("event_id")
    context.add_argument("session_id")
    put = sub.add_parser("put-result")
    put.add_argument("event_id")
    put.add_argument("session_id")
    put.add_argument("json_file", help="JSON file, or - for stdin")
    put.add_argument("--apply", action="store_true")
    put.add_argument("--reason")
    put.add_argument("--idempotency-key")
    args = parser.parse_args()

    if args.command == "doctor":
        result = request("GET", "/agent/doctor")
    elif args.command == "result-context":
        event = urllib.parse.quote(args.event_id, safe="")
        session = urllib.parse.quote(args.session_id, safe="")
        result = request("GET", f"/agent/events/{event}/sessions/{session}/result-context")
    else:
        if args.apply and (not args.reason or not args.idempotency_key):
            raise SystemExit("--apply requires --reason and --idempotency-key.")
        payload = load_payload(args.json_file)
        if args.apply:
            payload["reason"] = args.reason
        event = urllib.parse.quote(args.event_id, safe="")
        session = urllib.parse.quote(args.session_id, safe="")
        suffix = "?apply=true" if args.apply else ""
        result = request("PUT", f"/agent/events/{event}/sessions/{session}/result{suffix}", payload, args.idempotency_key)
    json.dump(result, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
