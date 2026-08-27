#!/usr/bin/env python3
# futures-term-structure.py — fetch specific-contract closes as of a target date
# Used by the Analyze stage to build the term_structure evidence field.
#
# Usage:
#   python collector/futures-term-structure.py --contracts RB2610,RB2701 --date 2026-08-04
#   python collector/futures-term-structure.py --contracts RB2610,RB2701 --date 2026-08-04 --output out.json

import sys
import json
import time
import argparse
from datetime import datetime

try:
    import akshare as ak
    import pandas as pd
except ImportError:
    print(json.dumps({"error": "akshare_not_installed", "detail": "pip install akshare pandas"}), file=sys.stderr)
    sys.exit(1)

# sina 限流退避：HTTP 456 约 80 请求/小时触发，自愈约 1 小时。
# 单合约失败最多重试 MAX_RETRIES 次，退避阶梯 BACKOFF_SLEEPS。
TRANSIENT_ERR_TYPES = {
    "ConnectionError", "Timeout", "ReadTimeout", "ConnectTimeout",
    "ProxyError", "HTTPError", "ChunkedEncodingError", "SSLError",
    "RemoteDisconnected",
}
MAX_RETRIES = 2
BACKOFF_SLEEPS = [20, 60]


def _is_transient(exc):
    if type(exc).__name__ in TRANSIENT_ERR_TYPES:
        return True
    msg = str(exc)
    return "456" in msg or "429" in msg or "Too Many" in msg


def fetch_df(code):
    """Fetch full daily history for a specific contract (with retry/backoff).

    Returns (ok, df) where df is the akshare DataFrame, or (False, err_msg).
    Transient failures (rate limit / network) retry with backoff.
    """
    last_err = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            df = ak.futures_zh_daily_sina(symbol=code)
            if df is None or len(df) == 0:
                return False, "no_data_returned"
            return True, df
        except Exception as e:
            last_err = e
            if attempt < MAX_RETRIES and _is_transient(e):
                time.sleep(BACKOFF_SLEEPS[attempt])
                continue
            break
    return False, f"{type(last_err).__name__}: {str(last_err)[:120]}"


def fetch_one(code, target_date):
    """Fetch the last bar on or before target_date for a specific contract.

    Returns (ok, result_dict). A contract counts as available only when it
    has a positive close AND positive volume on or before the target date
    (filters out dead/illiquid delivery-month contracts).
    """
    ok, df_or_err = fetch_df(code)
    if not ok:
        return False, {"contract": code, "available": False, "reason": df_or_err}

    df = df_or_err.copy()
    df["date"] = pd.to_datetime(df["date"])
    target = pd.Timestamp(target_date)
    recent = df[df["date"] <= target]
    if len(recent) == 0:
        return False, {"contract": code, "available": False, "reason": "no_bar_on_or_before_date"}

    row = recent.iloc[-1]
    close = float(row["close"])
    volume = int(row["volume"])
    if close <= 0 or volume <= 0:
        return False, {
            "contract": code,
            "available": False,
            "reason": "illiquid",
            "dataDate": str(row["date"].date()),
            "close": close,
            "volume": volume,
        }

    return True, {
        "contract": code,
        "available": True,
        "dataDate": str(row["date"].date()),
        "close": close,
        "volume": volume,
        "hold": int(row["hold"]),
    }


def fetch_history(code, target_date, max_bars):
    """Fetch up to max_bars daily bars on or before target_date for a contract.

    Returns (ok, result). Bars include open/high/low/close/volume/hold/settle
    (P0: deep-dig clean series for MA/HV/ATR on the dominant contract).
    """
    ok, df_or_err = fetch_df(code)
    if not ok:
        return False, {"contract": code, "available": False, "reason": df_or_err}

    df = df_or_err.copy()
    df["date"] = pd.to_datetime(df["date"])
    target = pd.Timestamp(target_date)
    recent = df[df["date"] <= target].tail(max_bars)
    if len(recent) == 0:
        return False, {"contract": code, "available": False, "reason": "no_bar_on_or_before_date"}

    bars = []
    for _, row in recent.iterrows():
        bars.append({
            "date": str(row["date"].date()),
            "open": float(row["open"]),
            "high": float(row["high"]),
            "low": float(row["low"]),
            "close": float(row["close"]),
            "volume": int(row["volume"]),
            "hold": int(row["hold"]),
            "settle": float(row["settle"]),
        })
    return True, {"contract": code, "available": True, "bars": bars}




def main():
    parser = argparse.ArgumentParser(description="futures-radar term-structure fetcher")
    parser.add_argument("--contracts", help="Comma-separated contract codes (e.g. RB2610,RB2701)")
    parser.add_argument("--date", help="Target date YYYY-MM-DD (last bar <= date)")
    parser.add_argument("--delay", type=float, default=0.5, help="Seconds between contract requests (pacing, default 0.5)")
    parser.add_argument("--output", help="Output JSON file path (default: stdout)")
    parser.add_argument("--history", help="Mode: contract code to fetch full OHLCV history for")
    parser.add_argument("--bars", type=int, default=80, help="Max bars for --history mode (default 80)")
    args = parser.parse_args()

    # Mode 1: single-contract OHLCV history (P0 clean series for deep-dig)
    if args.history:
        if not args.date:
            print(json.dumps({"error": "date_required", "detail": "--history requires --date"}), file=sys.stderr)
            sys.exit(1)
        ok, result = fetch_history(args.history, args.date, args.bars)
        output = {
            "meta": {
                "fetchedAt": datetime.now().isoformat(),
                "source": "akshare",
                "sourceVersion": getattr(ak, "__version__", "unknown"),
                "mode": "history",
                "contract": args.history,
                "targetDate": args.date,
                "maxBars": args.bars,
            },
        }
        if ok:
            output["bars"] = result["bars"]
            output["available"] = True
        else:
            output["available"] = False
            output["error"] = "history_failed"
            output["detail"] = result
        _emit(output, args.output)
        sys.exit(0 if ok else 1)

    # Mode 2 (default): near/far closes for term_structure
    if not args.contracts or not args.date:
        print(json.dumps({"error": "contracts_and_date_required",
                          "detail": "--contracts and --date required (or use --history)"}), file=sys.stderr)
        sys.exit(1)

    codes = [c.strip() for c in args.contracts.split(",") if c.strip()]
    if not codes:
        print(json.dumps({"error": "no_contracts", "detail": "Empty contract list"}), file=sys.stderr)
        sys.exit(1)

    contracts = {}
    ok_count = 0
    for i, code in enumerate(codes):
        if i > 0 and args.delay > 0:
            time.sleep(args.delay)
        is_ok, result = fetch_one(code, args.date)
        contracts[code] = result
        if is_ok:
            ok_count += 1

    output = {
        "meta": {
            "fetchedAt": datetime.now().isoformat(),
            "source": "akshare",
            "sourceVersion": getattr(ak, "__version__", "unknown"),
            "targetDate": args.date,
            "requested": len(codes),
            "available": ok_count,
        },
        "contracts": contracts,
    }
    _emit(output, args.output)


def _emit(output, output_path):
    if output_path:
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False, indent=2)
        print(f"Wrote {output_path}")
    else:
        print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
