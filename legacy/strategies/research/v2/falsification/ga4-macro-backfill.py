#!/usr/bin/env python3
"""ga4-macro-backfill.py — GA-4 宏观锚点历史回填（falsification 数据前置）

用法:
    python ga4-macro-backfill.py fetch    # 拉取 US10Y 全量 + DR007 按年分批（落 falsification/data/ PIT 证据）
    python ga4-macro-backfill.py verify   # 机器校验（覆盖/无未来日期/升序/重叠对拍）
    python ga4-macro-backfill.py write    # 写回 recordings/v4、v5 macro-history.json + 拼接留档

数据源（仓库允许源，不伪造）:
    US10Y: akshare bond_zh_us_rate 列「美国国债收益率10年」（同表 9330 行，1990-12-19 起）
    DR007: akshare repo_rate_hist（chinamoney）按年分批 2015..<执行日当年>；
           FDR007 自 2017-05-31 起为主口径，2015-01..2017-05-30 用 FR007 代理段。
拼接纪律: FDR007/FR007 拼接点 ±20 交易日剔除留档（ga4-splice-notes.json）;
          walk-forward 只用 FDR007 段，FR007 段仅 2015-2017 粗标定。
PIT 纪律: 全部拉取携带 fetchedAt；不伪造、不回填未来数据。
"""
import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]          # futures-radar/
FALS = ROOT / "strategies" / "research" / "v2" / "falsification"
DATA = FALS / "data"
REC_V4 = ROOT / "strategies" / "signal-backtest" / "recordings" / "v4" / "macro-history.json"
REC_V5 = ROOT / "strategies" / "signal-backtest" / "recordings" / "v5" / "macro-history.json"
US10Y_RAW = DATA / "ga4-fetch-us10y.json"
DR007_RAW = DATA / "ga4-fetch-dr007.json"
SPLICE_NOTES = DATA / "ga4-splice-notes.json"
SUMMARY = DATA / "ga4-backfill-summary.json"

US10Y_FIELD = "美国国债收益率10年"
SPLICE_DATE = "2017-05-31"      # FDR007 首个交易日（2017 实测）
SPLICE_EXCLUDE_DAYS = 20        # 拼接点 ±20 交易日剔除留档

# 重叠对拍锚（旧 recordings 尾部，验证同源重取一致性）
US10Y_OVERLAP_START = "2026-02-01"
DR007_OVERLAP_START = "2026-02-01"


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def today():
    return datetime.now(timezone.utc).date()


def _load_json(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def _save_json(p, obj):
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")


def fetch_us10y():
    import akshare as ak
    fetched_at = now_iso()
    df = ak.bond_zh_us_rate()
    if US10Y_FIELD not in df.columns:
        raise RuntimeError("bond_zh_us_rate: column not found: %s" % US10Y_FIELD)
    rows = []
    for _, r in df.iterrows():
        d, v = r["日期"], r[US10Y_FIELD]
        if d is None or v is None:
            continue
        try:
            fv = float(v)
        except (TypeError, ValueError):
            continue
        if fv != fv:  # NaN
            continue
        rows.append([d.isoformat() if hasattr(d, "isoformat") else str(d), fv])
    return {
        "kind": "akshare_bond_zh_us_rate",
        "field": US10Y_FIELD,
        "fetchedAt": fetched_at,
        "rows": len(rows),
        "series": rows,
    }


def fetch_dr007_year(year):
    import akshare as ak
    end = min(date(year, 12, 31), today())
    df = ak.repo_rate_hist(start_date="%d0101" % year, end_date=end.strftime("%Y%m%d"))
    out = []
    for _, r in df.iterrows():
        d, fr, fd = r["date"], r.get("FR007"), r.get("FDR007")
        if d is None:
            continue
        ds = str(d)
        row = {"date": ds}
        for key, val in (("FR007", fr), ("FDR007", fd)):
            if val is None:
                row[key] = None
                continue
            try:
                fv = float(val)
            except (TypeError, ValueError):
                row[key] = None
                continue
            row[key] = None if fv != fv else fv
        out.append(row)
    return out


def fetch_dr007():
    fetched_at = now_iso()
    batches = {}
    first = 2015
    last = today().year
    for y in range(first, last + 1):
        batches[str(y)] = fetch_dr007_year(y)
    return {
        "kind": "akshare_repo_rate",
        "fetchedAt": fetched_at,
        "firstYear": first,
        "lastYear": last,
        "batches": batches,
    }


def build_dr007_series(fetched):
    """FR007(<splice) + FDR007(>=splice) 拼接；返回 (series, segments, splice_excl_window)。

    PIT 纪律：只保留已完成日线（date < 抓取日）；同日盘中 fixing 行剔除。
    """
    fetch_day = fetched["fetchedAt"][:10]
    rows_by_date = {}
    for y, rows in fetched["batches"].items():
        for r in rows:
            d = r["date"]
            if d >= fetch_day:
                continue
            if r.get("FDR007") is not None:
                rows_by_date[d] = r["FDR007"]
            elif r.get("FR007") is not None:
                rows_by_date[d] = r["FR007"]
    proxy = [[d, v] for d, v in sorted(rows_by_date.items()) if d < SPLICE_DATE and d >= "2015-01-01"]
    primary = [[d, v] for d, v in sorted(rows_by_date.items()) if d >= SPLICE_DATE]
    # 拼接点 ±20 交易日剔除窗口（实际交易日序）
    excl_dates = sorted([d for d, _ in primary])[:SPLICE_EXCLUDE_DAYS] + sorted([d for d, _ in proxy])[-SPLICE_EXCLUDE_DAYS:]
    excl_dates = sorted(set(excl_dates))
    segments = [
        {"field": "FR007", "start": proxy[0][0] if proxy else None, "end": proxy[-1][0] if proxy else None,
         "role": "proxy", "note": "FR007 代理段（2015-2017-05-30），仅用于 2015-2017 粗标定"},
        {"field": "FDR007", "start": primary[0][0] if primary else None, "end": primary[-1][0] if primary else None,
         "role": "primary", "note": "FDR007 官方定盘口径（2017-05-31 起），walk-forward 只使用本段"},
    ]
    return proxy + primary, segments, excl_dates


def overlap_check(new_series, old_series, start):
    """与旧 recordings 重合段对拍：返回 (max_abs_diff, mismatched_dates)。"""
    old = {str(r[0]): float(r[1]) for r in old_series if str(r[0]) >= start}
    new = {str(r[0]): float(r[1]) for r in new_series if str(r[0]) >= start}
    common = sorted(set(old) & set(new))
    diffs = {d: abs(new[d] - old[d]) for d in common}
    max_diff = max(diffs.values()) if diffs else 0.0
    mismatched = [d for d, v in diffs.items() if v > 1e-9]
    return max_diff, mismatched


def verify_mode():
    us = _load_json(US10Y_RAW)
    dr = _load_json(DR007_RAW)
    rec = _load_json(REC_V5)
    errors = []
    checks = []

    def chk(name, ok, detail):
        checks.append({"check": name, "passed": bool(ok), "detail": detail})
        if not ok:
            errors.append(name + ": " + str(detail))

    us_series = us["series"]
    chk("US10Y rows >= 6000", len(us_series) >= 6000, "rows=%d" % len(us_series))
    chk("US10Y earliest <= 2002-06-30", us_series[0][0] <= "2002-06-30", "earliest=%s" % us_series[0][0])
    dr_series, segments, excl = build_dr007_series(dr)
    chk("DR007 earliest <= 2015-01-31", dr_series[0][0] <= "2015-01-31", "earliest=%s" % dr_series[0][0])
    chk("DR007 FDR007 segment starts 2017-05-31", segments[1]["start"] == "2017-05-31", "start=%s" % segments[1]["start"])
    chk("DR007 splice exclusion window computed", len(excl) == SPLICE_EXCLUDE_DAYS * 2, "excl=%d dates %s..%s" % (len(excl), excl[0], excl[-1]))

    t = today().isoformat()
    for name, series in (("US10Y", us_series), ("DR007", dr_series)):
        future = [d for d, _ in series if d > t]
        asc_ok = all(series[i][0] < series[i + 1][0] for i in range(len(series) - 1))
        chk("%s no future dates" % name, not future, "future=%s" % future[:3])
        chk("%s strictly ascending" % name, asc_ok, "rows=%d" % len(series))

    old_us = rec["indicators"]["US10Y"]["series"]
    old_dr = rec["indicators"]["DR007"]["series"]
    us_diff, us_mis = overlap_check(us_series, old_us, US10Y_OVERLAP_START)
    dr_diff, dr_mis = overlap_check(dr_series, old_dr, DR007_OVERLAP_START)
    chk("US10Y overlap identical with old tail", us_diff <= 1e-9 and not us_mis,
        "max_abs_diff=%.6g mismatched=%d" % (us_diff, len(us_mis)))
    chk("DR007 overlap identical with old tail", dr_diff <= 1e-9 and not dr_mis,
        "max_abs_diff=%.6g mismatched=%d" % (dr_diff, len(dr_mis)))

    print(json.dumps(checks, ensure_ascii=False, indent=2))
    return 0 if not errors else 1


def write_mode():
    us = _load_json(US10Y_RAW)
    dr = _load_json(DR007_RAW)
    dr_series, segments, excl = build_dr007_series(dr)
    written_at = now_iso()

    splice_notes = {
        "schema": "futures-radar-ga4-splice-notes/1",
        "spliceDate": SPLICE_DATE,
        "discipline": "FDR007/FR007 拼接点 ±%d 交易日剔除；walk-forward 只用 FDR007 段，FR007 段仅用于 2015-2017 粗标定" % SPLICE_EXCLUDE_DAYS,
        "segments": segments,
        "excludedDates": excl,
        "excludedCount": len(excl),
        "writtenAt": written_at,
    }
    _save_json(SPLICE_NOTES, splice_notes)

    summary = {
        "schema": "futures-radar-ga4-summary/1",
        "writtenAt": written_at,
        "US10Y": {"source": "akshare bond_zh_us_rate", "fetchedAt": us["fetchedAt"], "rows": len(us["series"]),
                  "range": [us["series"][0][0], us["series"][-1][0]]},
        "DR007": {"source": "akshare repo_rate_hist (FDR007 2017-05-31+/FR007 proxy 2015+)", "fetchedAt": dr["fetchedAt"],
                  "rows": len(dr_series), "range": [dr_series[0][0], dr_series[-1][0]], "segments": segments},
    }

    for rec_path in (REC_V4, REC_V5):
        rec = _load_json(rec_path)
        rec["originalFetchedAt"] = rec.get("originalFetchedAt") or rec.get("fetchedAt")
        rec["fetchedAt"] = written_at

        ind_us = rec["indicators"]["US10Y"]
        ind_us["series"] = us["series"]
        ind_us["ok"] = True
        ind_us["error"] = None
        ind_us["seriesExtendNote"] = "GA-4 backfill: full series %s..%s (%d rows)" % (
            us["series"][0][0], us["series"][-1][0], len(us["series"]))
        ind_us["asOf"] = us["series"][-1][0]
        ind_us["source"] = "akshare_bond_zh_us_rate"
        ind_us["status"] = "complete"

        ind_dr = rec["indicators"]["DR007"]
        ind_dr["series"] = dr_series
        ind_dr["ok"] = True
        ind_dr["error"] = None
        ind_dr["seriesExtendNote"] = ("GA-4 backfill: FR007 proxy 2015-01..2017-05-30 + FDR007 2017-05-31..%s "
                                      "(%d rows; splice ±%d trading days excluded, see falsification/data/ga4-splice-notes.json)") % (
                                          dr_series[-1][0], len(dr_series), SPLICE_EXCLUDE_DAYS)
        ind_dr["asOf"] = dr_series[-1][0]
        ind_dr["source"] = "akshare_repo_rate"
        ind_dr["status"] = "complete"
        ind_dr["segments"] = segments

        for name in ("DXY", "USDCNH"):
            ind = rec["indicators"][name]
            ind["asOf"] = ind["series"][-1][0]
            ind["source"] = "sina_fx"
            ind["status"] = "complete"

        rec["backfill"] = {
            "performedAt": written_at,
            "operator": "GA-4 macro backfill (data-engineer-2)",
            "US10Y": {"source": "akshare bond_zh_us_rate", "status": "complete",
                      "asOf": us["series"][-1][0], "rows": len(us["series"])},
            "DR007": {"source": "akshare repo_rate_hist FDR007/FR007 splice", "status": "complete",
                      "asOf": dr_series[-1][0], "rows": len(dr_series),
                      "spliceDate": SPLICE_DATE, "spliceExcludedDates": len(excl)},
            "DXY": {"source": "sina_fx DINIW", "status": "complete", "asOf": rec["indicators"]["DXY"]["series"][-1][0],
                    "rows": len(rec["indicators"]["DXY"]["series"])},
            "USDCNH": {"source": "sina_fx USDCNH", "status": "complete",
                       "asOf": rec["indicators"]["USDCNH"]["series"][-1][0],
                       "rows": len(rec["indicators"]["USDCNH"]["series"])},
        }
        _save_json(rec_path, rec)

    summary["recordingsWritten"] = [str(REC_V4.relative_to(ROOT)), str(REC_V5.relative_to(ROOT))]
    _save_json(SUMMARY, summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "verify"
    if mode == "fetch":
        us = fetch_us10y()
        dr = fetch_dr007()
        _save_json(US10Y_RAW, us)
        _save_json(DR007_RAW, dr)
        print(json.dumps({"ok": True, "US10Y": us["rows"], "DR007BatchYears": list(dr["batches"].keys())},
                         ensure_ascii=False, indent=2))
        return 0
    if mode == "verify":
        return verify_mode()
    if mode == "write":
        return write_mode()
    print("unknown mode:", mode)
    return 1


if __name__ == "__main__":
    sys.exit(main())
