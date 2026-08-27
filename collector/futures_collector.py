#!/usr/bin/env python3
# futures_collector.py — futures-radar collector (Phase 3)
# Calls akshare futures_main_sina() for each symbol, extracts last N days OHLCV.
#
# Usage:
#   python collector/futures_collector.py --symbols RB0,M0,SC0 --days 90
#   python collector/futures_collector.py --symbols RB0,M0,SC0 --days 90 --output raw.json

import sys
import json
import time
import argparse
from datetime import datetime

try:
    import akshare as ak
except ImportError:
    print(json.dumps({"error": "akshare_not_installed", "detail": "pip install akshare"}), file=sys.stderr)
    sys.exit(1)

def collect_one(symbol, days):
    """Collect OHLCV for one symbol. Returns (ok, result_dict)."""
    try:
        df = ak.futures_main_sina(symbol=symbol)
        if df is None or len(df) == 0:
            return False, {"symbol": symbol, "status": "gap", "reason": "no_data_returned"}

        # Take last N rows (or all if days=-1)
        if days == -1:
            recent = df  # Full history
        else:
            recent = df.tail(days)
        n = len(recent)

        return True, {
            "symbol": symbol,
            "status": "ok",
            "fetchedAt": datetime.now().isoformat(),
            "totalBars": len(df),
            "usedBars": n,
            "dataStart": str(recent.iloc[0]["日期"]),
            "dataEnd": str(recent.iloc[-1]["日期"]),
            "ohlcv": {
                "dates": [str(d) for d in recent["日期"].tolist()],
                "open": [float(x) for x in recent["开盘价"].tolist()],
                "high": [float(x) for x in recent["最高价"].tolist()],
                "low": [float(x) for x in recent["最低价"].tolist()],
                "close": [float(x) for x in recent["收盘价"].tolist()],
                "volume": [int(x) for x in recent["成交量"].tolist()],
                "open_interest": [int(x) for x in recent["持仓量"].tolist()],
                "settle": [float(x) for x in recent["动态结算价"].tolist()],
            }
        }
    except Exception as e:
        return False, {"symbol": symbol, "status": "gap", "reason": f"{type(e).__name__}: {str(e)[:200]}"}


def main():
    parser = argparse.ArgumentParser(description="futures-radar akshare collector")
    parser.add_argument("--symbols", required=True, help="Comma-separated symbol list (e.g. RB0,M0,SC0)")
    parser.add_argument("--days", type=int, default=90, help="Days of history to pull (default: 90, -1 for full history)")
    parser.add_argument("--output", help="Output JSON file path (default: stdout)")
    args = parser.parse_args()

    symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]
    if not symbols:
        print(json.dumps({"error": "no_symbols", "detail": "Empty symbol list"}), file=sys.stderr)
        sys.exit(1)

    t0 = time.time()
    contracts = {}
    gaps = {}
    ok_count = 0
    fail_count = 0

    for sym in symbols:
        ok, result = collect_one(sym, args.days)
        if ok:
            contracts[sym] = result
            ok_count += 1
        else:
            gaps[sym] = result
            fail_count += 1

    elapsed = time.time() - t0

    output = {
        "meta": {
            "collectedAt": datetime.now().isoformat(),
            "source": "akshare",
            "sourceVersion": getattr(ak, "__version__", "unknown"),
            "totalSymbols": len(symbols),
            "succeeded": ok_count,
            "failed": fail_count,
            "daysPerSymbol": args.days,
            "elapsedSeconds": round(elapsed, 2)
        },
        "contracts": contracts,
        "gaps": gaps
    }

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False, indent=2)
        print(f"Wrote {args.output}: {ok_count} OK, {fail_count} gaps, {elapsed:.1f}s")
    else:
        print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
