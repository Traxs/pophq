#!/usr/bin/env python3
"""Minimal standard-library client for POP HQ's scoped bot API."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def request(
    method: str,
    path: str,
    body: object | None = None,
    idempotency_key: str | None = None,
    account_id: str | None = None,
) -> object:
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
    if account_id:
        headers["X-Account-Id"] = account_id
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
        raise SystemExit("Payload must be one JSON object.")
    return value


def main() -> None:
    parser = argparse.ArgumentParser(prog="s26", description="POP HQ bot client")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("doctor")
    get = sub.add_parser("get", help="Read any POP HQ API path allowed to the token issuer")
    get.add_argument("path", help="Path below /v1, for example /events or /roster")
    get.add_argument("--account-id", help="Act as one of the issuer's linked Player IDs")
    events = sub.add_parser("list-events")
    events.add_argument(
        "--kind",
        choices=["foundry", "svs", "koi", "fdt", "canyon", "tundra", "bear", "other"],
    )
    events.add_argument("--from", dest="from_value", help="ISO date or timestamp; defaults to seven days ago")
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
    create_event = sub.add_parser("create-event")
    create_event.add_argument("json_file", help="JSON file, or - for stdin")
    create_event.add_argument("--apply", action="store_true")
    create_event.add_argument("--reason")
    create_event.add_argument("--idempotency-key")
    edit_event = sub.add_parser("edit-event")
    edit_event.add_argument("event_id")
    edit_event.add_argument("json_file", help="JSON file, or - for stdin")
    edit_event.add_argument("--apply", action="store_true")
    edit_event.add_argument("--reason")
    edit_event.add_argument("--idempotency-key")
    edit_event.add_argument("--expected-hash", help="expectedHash returned by the reviewed preview")
    rewards = sub.add_parser("put-rewards", help="Preview or apply one Fortress/Stronghold reward haul")
    rewards.add_argument("json_file", help="JSON file, or - for stdin")
    rewards.add_argument("--apply", action="store_true")
    rewards.add_argument("--reason")
    rewards.add_argument("--idempotency-key")
    rewards.add_argument("--expected-hash", help="expectedHash returned by the reviewed preview")
    history = sub.add_parser("put-history", help="Preview or apply one guarded historical record")
    history.add_argument("path", help="Path below /v1/agent/history, beginning with /agent/history/")
    history.add_argument("json_file", help="JSON file, or - for stdin")
    history.add_argument("--apply", action="store_true")
    history.add_argument("--reason")
    history.add_argument("--idempotency-key")
    history.add_argument("--expected-hash", help="expectedHash returned by the reviewed preview")
    list_history = sub.add_parser("list-history", help="Read preserved historical records by category")
    list_history.add_argument("category", choices=["alias", "relationship", "membership", "registration", "selection", "assignment", "performance", "evidence"])
    args = parser.parse_args()

    if args.command == "doctor":
        result = request("GET", "/agent/doctor")
    elif args.command == "get":
        if not args.path.startswith("/") or args.path.startswith("//"):
            raise SystemExit("Path must start with one / and is resolved below /v1.")
        result = request("GET", args.path, account_id=args.account_id)
    elif args.command == "list-events":
        query = urllib.parse.urlencode({key: value for key, value in {"kind": args.kind, "from": args.from_value}.items() if value})
        result = request("GET", f"/agent/events{f'?{query}' if query else ''}")
    elif args.command == "result-context":
        event = urllib.parse.quote(args.event_id, safe="")
        session = urllib.parse.quote(args.session_id, safe="")
        result = request("GET", f"/agent/events/{event}/sessions/{session}/result-context")
    elif args.command == "put-result":
        if args.apply and (not args.reason or not args.idempotency_key):
            raise SystemExit("--apply requires --reason and --idempotency-key.")
        payload = load_payload(args.json_file)
        if args.apply:
            payload["reason"] = args.reason
        event = urllib.parse.quote(args.event_id, safe="")
        session = urllib.parse.quote(args.session_id, safe="")
        suffix = "?apply=true" if args.apply else ""
        result = request("PUT", f"/agent/events/{event}/sessions/{session}/result{suffix}", payload, args.idempotency_key)
    elif args.command == "create-event":
        if args.apply and (not args.reason or not args.idempotency_key):
            raise SystemExit("--apply requires --reason and --idempotency-key.")
        payload = load_payload(args.json_file)
        if args.apply:
            payload["reason"] = args.reason
        suffix = "?apply=true" if args.apply else ""
        result = request("POST", f"/agent/events{suffix}", payload, args.idempotency_key)
    elif args.command == "edit-event":
        if args.apply and (not args.reason or not args.idempotency_key or not args.expected_hash):
            raise SystemExit("--apply requires --reason, --idempotency-key and --expected-hash.")
        payload = load_payload(args.json_file)
        if args.apply:
            payload["reason"] = args.reason
            payload["expectedHash"] = args.expected_hash
        event = urllib.parse.quote(args.event_id, safe="")
        suffix = "?apply=true" if args.apply else ""
        result = request("PATCH", f"/agent/events/{event}{suffix}", payload, args.idempotency_key)
    elif args.command == "put-rewards":
        if args.apply and (not args.reason or not args.idempotency_key or not args.expected_hash):
            raise SystemExit("--apply requires --reason, --idempotency-key and --expected-hash.")
        payload = load_payload(args.json_file)
        if args.apply:
            payload["reason"] = args.reason
            payload["expectedHash"] = args.expected_hash
        suffix = "?apply=true" if args.apply else ""
        result = request("POST", f"/agent/rewards{suffix}", payload, args.idempotency_key)
    elif args.command == "put-history":
        if not args.path.startswith("/agent/history/") or args.path.startswith("//"):
            raise SystemExit("History path must begin with /agent/history/.")
        if args.apply and (not args.reason or not args.idempotency_key or not args.expected_hash):
            raise SystemExit("--apply requires --reason, --idempotency-key and --expected-hash.")
        payload = load_payload(args.json_file)
        if args.apply:
            payload["reason"] = args.reason
            payload["expectedHash"] = args.expected_hash
        suffix = "?apply=true" if args.apply else ""
        result = request("PUT", f"{args.path}{suffix}", payload, args.idempotency_key)
    else:
        result = request("GET", f"/agent/history?{urllib.parse.urlencode({'category': args.category})}")
    json.dump(result, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
