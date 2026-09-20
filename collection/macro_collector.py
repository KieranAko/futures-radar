#!/usr/bin/env python3
"""macro_collector.py — futures-radar Phase 3 阶段一宏观锚点采集（单指标/次调用）

用法:
    python macro_collector.py --spec '<json>'

spec 字段:
    kind:   sina_fx | akshare_bond_zh_us_rate | akshare_repo_rate
    symbol: sina_fx 的品种代码（DINIW 美元指数 / USDCNH 美元兑离岸人民币）
    field:  akshare 数据框中的目标列名
    signalDate: YYYY-MM-DD（仅用于 akshare 源的起始日期推算）

输出（stdout 单行 JSON, ensure_ascii 纯 ASCII，规避 Windows 控制台编码）:
    {"ok": true, "kind": ..., "series": [["YYYY-MM-DD", value], ...], "fetchedAt": ...}
    {"ok": false, "kind": ..., "error": "...", "fetchedAt": ...}

series 为升序日期序列；bar 选择（<= signalDate 最后一根）与 change5d 计算在 Node 侧完成。
"""

import json
import re
import sys
from datetime import date, datetime, timedelta, timezone


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_sina_fx_kline(text):
    """解析 sina NewForexService.getDayKLine 响应。

    响应形如: var t=("2014-11-07,o,l,h,c,|...|2026-08-26,o,l,h,c")
    字段序为 [date, open, low, high, close]（sina 外汇日线口径）。
    """
    m = re.search(r"\(([^)]*)\)", text, re.S)
    if not m:
        raise RuntimeError("sina fx: no payload found")
    inner = m.group(1).strip().strip('"')
    if not inner or inner.startswith('{"msg"'):
        raise RuntimeError("sina fx: empty data")
    rows = []
    for row in inner.split("|"):
        parts = row.split(",")
        if len(parts) < 5:
            continue
        d = parts[0].strip('"')
        close_raw = parts[4].strip('"')
        try:
            value = float(close_raw)
        except ValueError:
            continue
        rows.append((d, value))
    if not rows:
        raise RuntimeError("sina fx: no rows parsed")
    return rows


def fetch_sina_fx(symbol):
    import requests

    url = (
        "https://vip.stock.finance.sina.com.cn/forex/api/jsonp.php/"
        "var%20t=/NewForexService.getDayKLine?symbol=" + symbol
    )
    r = requests.get(
        url, timeout=30,
        headers={"Referer": "https://finance.sina.com.cn/"},
    )
    r.raise_for_status()
    return _parse_sina_fx_kline(r.text)


def fetch_akshare_bond_zh_us_rate(signal_date, field):
    import akshare as ak

    start = (date.fromisoformat(signal_date) - timedelta(days=45)).strftime("%Y%m%d")
    df = ak.bond_zh_us_rate(start_date=start)
    if field not in df.columns:
        raise RuntimeError("bond_zh_us_rate: column not found: %s" % field)
    date_col = "日期"
    if date_col not in df.columns:
        raise RuntimeError("bond_zh_us_rate: date column not found")
    rows = []
    for _, r in df.iterrows():
        d = r[date_col]
        v = r[field]
        if d is None or v is None:
            continue
        if isinstance(v, float) and v != v:  # NaN
            continue
        rows.append((d.isoformat() if hasattr(d, "isoformat") else str(d), float(v)))
    return rows


def fetch_akshare_repo_rate(signal_date, field):
    import akshare as ak

    end = date.fromisoformat(signal_date)
    start = end - timedelta(days=28)  # chinamoney 接口要求起止在一个月内
    df = ak.repo_rate_hist(
        start_date=start.strftime("%Y%m%d"),
        end_date=end.strftime("%Y%m%d"),
    )
    if field not in df.columns:
        raise RuntimeError("repo_rate_hist: column not found: %s" % field)
    rows = []
    for _, r in df.iterrows():
        d = r["date"]
        v = r[field]
        if d is None or v is None:
            continue
        try:
            rows.append((str(d), float(v)))
        except ValueError:
            continue
    return rows


FETCHERS = {
    "sina_fx": lambda spec: fetch_sina_fx(spec["symbol"]),
    "akshare_bond_zh_us_rate": lambda spec: fetch_akshare_bond_zh_us_rate(
        spec["signalDate"], spec["field"]
    ),
    "akshare_repo_rate": lambda spec: fetch_akshare_repo_rate(
        spec["signalDate"], spec["field"]
    ),
}


def main():
    args = sys.argv[1:]
    if "--spec" not in args:
        print(json.dumps({"ok": False, "error": "--spec required"}, ensure_ascii=True))
        return 1
    spec = json.loads(args[args.index("--spec") + 1])
    kind = spec.get("kind")
    fetched_at = now_iso()
    try:
        if kind not in FETCHERS:
            raise RuntimeError("unknown fetch kind: %s" % kind)
        series = FETCHERS[kind](spec)
        print(json.dumps(
            {"ok": True, "kind": kind, "series": series, "fetchedAt": fetched_at},
            ensure_ascii=True,
        ))
        return 0
    except Exception as e:  # 单指标失败不阻断：错误透传给 Node 标 missing
        print(json.dumps(
            {"ok": False, "kind": kind, "error": str(e)[:300], "fetchedAt": fetched_at},
            ensure_ascii=True,
        ))
        return 0


if __name__ == "__main__":
    sys.exit(main())
