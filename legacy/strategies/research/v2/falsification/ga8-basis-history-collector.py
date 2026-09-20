#!/usr/bin/env python3
"""ga8-basis-history-collector.py — GA-8 FS-02 PIT 基差历史采集器（falsification 数据前置）

用途:
    为 FS-02（基差分位回归）建立 2011+ 主力基差比率历史库。
    数据源: akshare futures_spot_price_daily（生意社现货挂牌价 + 主力基差）。
    按周切片拉取（全量年份调用实测 >120s 超时，周切片稳定），落本地 JSONL + 原始拉取证据。

口径（与 strategy-library-v2 FS-02 / t8 F-1 对齐）:
    API dom_basis_rate = (F - S) / S（主力基差率，F=dominant_contract_price, S=spot_price）
    库内 br = (S - F) / S → br = -dom_basis_rate（2026-08-27 RB0 实测验证）
    同时保留 near_* 近月口径（FS-03 月差扩展备用）与 dom_basis 绝对差（审计用）。

PIT 纪律（F7 / 24 协议数据校验）:
    - 每次拉取携带 fetchedAt；原始周切片落 fetches/ 留档，可复现。
    - 历史接口只能得到“查询日可见”的序列（现货修订风险实测 0.03–0.33）；
      本库为 PIT 回填 v0：所有行带 asOf=fetchedAt，重复 (symbol,date) 时记录 revision
      并保留最新值，修订事件单独落 revisions.jsonl，FS-02 正式口径启用前必须
      用 GA-6 现货粘性质量门过滤（ga6-tradable-set.json）。
    - 禁止用今日数据标注历史日期为“当时值”；标注口径见 manifest.note。

用法:
    python ga8-basis-history-collector.py init
    python ga8-basis-history-collector.py fetch-week --start 20210104 --end 20210110
    python ga8-basis-history-collector.py backfill --from 20210101 [--to 20260827] [--symbols AG,AL,RB]
    python ga8-basis-history-collector.py verify
    python ga8-basis-history-collector.py inspect --symbol RB

输出（strategies/research/v2/falsification/data/basis-history/）:
    manifest.json           采集清单（universe/分片/覆盖/revision 统计）
    <SYMBOL>.jsonl          按 symbol 排序的基差历史（每行一个交易日）
    fetches/<start>_<end>.json   原始周切片证据
    revisions.jsonl         (symbol,date) 修订事件（同键重取不一致）
    summary.json            覆盖与质量汇总（verify 后）
"""
import argparse
import json
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]          # futures-radar/
FALS = ROOT / "strategies" / "research" / "v2" / "falsification"
DATA = FALS / "data"
STORE = DATA / "basis-history"
FETCH_DIR = STORE / "fetches"
MANIFEST = STORE / "manifest.json"
SUMMARY = STORE / "summary.json"
REVISIONS = STORE / "revisions.jsonl"
TRADABLE_FILE = DATA / "ga6-tradable-set.json"

SLICE_DAYS = 7
SLEEP_BETWEEN_CALLS = 0.5
MAX_ATTEMPTS = 3

API_COLUMNS = [
    "date", "symbol", "spot_price",
    "near_contract", "near_contract_price", "near_basis", "near_basis_rate",
    "dominant_contract", "dominant_contract_price", "dom_basis", "dom_basis_rate",
]
STRING_COLUMNS = {"symbol", "near_contract", "dominant_contract"}
NUMERIC_COLUMNS = ["spot_price", "near_contract_price", "near_basis", "near_basis_rate",
                   "dominant_contract_price", "dom_basis", "dom_basis_rate"]


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def d2s(d):
    return d.strftime("%Y%m%d")


def s2d(s):
    return datetime.strptime(s, "%Y%m%d").date()


def parse_date(s):
    return datetime.strptime(s, "%Y-%m-%d").date()


def load_json(p, default=None):
    if not p.exists():
        return default
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def load_revisions():
    if not REVISIONS.exists():
        return []
    out = []
    with open(REVISIONS, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def save_revisions(revision_log):
    with open(REVISIONS, "w", encoding="utf-8", newline="\n") as f:
        for r in revision_log:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def save_json(p, obj):
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")


def default_universe():
    ts = load_json(TRADABLE_FILE)
    if not ts:
        return []
    return [str(s) for s in ts.get("tradableSymbols", [])]


def num(v):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f:  # NaN
        return None
    return f


# ---------------- fetch ----------------
def fetch_slice(start: date, end: date, symbols=None):
    import akshare as ak
    fetched_at = now_iso()
    kwargs = {"start_day": d2s(start), "end_day": d2s(end)}
    if symbols:
        kwargs["vars_list"] = list(symbols)
    df = ak.futures_spot_price_daily(**kwargs)
    rows = []
    if df is None or len(df) == 0:
        return {"kind": "akshare_futures_spot_price_daily", "fetchedAt": fetched_at,
                "startDay": d2s(start), "endDay": d2s(end), "varsList": list(symbols or []),
                "rows": 0, "rowsData": rows}
    for _, r in df.iterrows():
        row = {"date": str(r["date"])}
        for col in API_COLUMNS[1:]:
            if col not in r:
                continue
            if col in STRING_COLUMNS:
                v = r[col]
                row[col] = None if (v is None or (isinstance(v, float) and v != v)) else str(v)
            else:
                row[col] = num(r[col])
        rows.append(row)
    return {"kind": "akshare_futures_spot_price_daily", "fetchedAt": fetched_at,
            "startDay": d2s(start), "endDay": d2s(end), "varsList": list(symbols or []),
            "rows": len(rows), "rowsData": rows}


def fetch_slice_retry(start: date, end: date, symbols=None, verbose=False):
    last = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return fetch_slice(start, end, symbols=symbols)
        except Exception as exc:  # noqa: BLE001
            last = exc
            if verbose:
                print(f"  retry {attempt}: {exc}", file=sys.stderr)
            time.sleep(2 * attempt)
    raise RuntimeError(f"slice {d2s(start)}..{d2s(end)} failed after {MAX_ATTEMPTS} attempts: {last}")


def save_fetch_evidence(ev):
    FETCH_DIR.mkdir(parents=True, exist_ok=True)
    p = FETCH_DIR / f"{ev['startDay']}_{ev['endDay']}.json"
    save_json(p, ev)
    return p.relative_to(STORE).as_posix()


# ---------------- row transform ----------------
def transform_row(row, fetched_at):
    s = num(row.get("spot_price"))
    f = num(row.get("dominant_contract_price"))
    nf = num(row.get("near_contract_price"))
    dom_basis_rate = num(row.get("dom_basis_rate"))
    near_basis_rate = num(row.get("near_basis_rate"))
    sym = str(row.get("symbol", ""))
    out = {
        "date": row.get("date"),
        "symbol": sym,
        "libSymbol": f"{sym}0" if sym else None,   # 库内品种口径（RB0/M0/...，与 data/daily 对齐）
        "spot": s,
        "domContract": row.get("dominant_contract"),
        "domPrice": f,
        "nearContract": row.get("near_contract"),
        "nearPrice": nf,
        "domBasis": num(row.get("dom_basis")),          # F - S（源端口径）
        "domBasisRate": dom_basis_rate,                 # (F - S) / S（源端口径）
        "nearBasis": num(row.get("near_basis")),
        "nearBasisRate": near_basis_rate,               # (F_near - S) / S（源端口径）
        "br": None if (s is None or s == 0 or dom_basis_rate is None) else round(-dom_basis_rate, 12),
        "nearBr": None if (s is None or s == 0 or near_basis_rate is None) else round(-near_basis_rate, 12),
        "asOf": fetched_at,
    }
    return out


def rows_equal(a, b):
    keys = ["spot", "domPrice", "nearPrice", "domBasis", "domBasisRate", "nearBasis", "nearBasisRate"]
    return all(a.get(k) == b.get(k) for k in keys)


# ---------------- store merge ----------------
def load_store_rows(symbols):
    rows = {}
    for sym in symbols:
        p = STORE / f"{sym}.jsonl"
        if not p.exists():
            continue
        with open(p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                r = json.loads(line)
                rows[(r["symbol"], r["date"])] = r
    return rows


def write_store_rows(rows):
    by_symbol = {}
    for key, r in rows.items():
        by_symbol.setdefault(r["symbol"], []).append(r)
    for sym, arr in by_symbol.items():
        arr.sort(key=lambda r: r["date"])
        p = STORE / f"{sym}.jsonl"
        with open(p, "w", encoding="utf-8", newline="\n") as f:
            for r in arr:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")


def merge_slice(store_rows, ev, universe, revision_log):
    inserted = 0
    revised = 0
    skipped = 0
    for raw in ev.get("rowsData", []):
        sym = str(raw.get("symbol", ""))
        if universe and sym not in universe:
            continue
        if not raw.get("date"):
            skipped += 1
            continue
        row = transform_row(raw, ev["fetchedAt"])
        key = (row["symbol"], row["date"])
        old = store_rows.get(key)
        if old is None:
            store_rows[key] = row
            inserted += 1
        elif not rows_equal(old, row):
            revision_log.append({
                "symbol": row["symbol"], "date": row["date"],
                "oldAsOf": old.get("asOf"), "newAsOf": row.get("asOf"),
                "old": {k: old.get(k) for k in ["spot", "domPrice", "domBasisRate", "br"]},
                "new": {k: row.get(k) for k in ["spot", "domPrice", "domBasisRate", "br"]},
                "revisionKind": "api_visible_value_changed",
            })
            store_rows[key] = row
            revised += 1
        else:
            skipped += 1
    return inserted, revised, skipped


# ---------------- commands ----------------
def cmd_init(args):
    STORE.mkdir(parents=True, exist_ok=True)
    FETCH_DIR.mkdir(parents=True, exist_ok=True)
    universe = default_universe()
    manifest = {
        "schema": "futures-radar-basis-history-manifest/1",
        "createdAt": now_iso(),
        "store": STORE.relative_to(ROOT).as_posix(),
        "api": "akshare_futures_spot_price_daily",
        "universe": universe,
        "universeSource": TRADABLE_FILE.relative_to(ROOT).as_posix(),
        "universeNote": "GA-6 现货粘性可交易集（42/12，零变动占比 ≤40%）",
        "rateConvention": "br = (S - F) / S = -dom_basis_rate；nearBr = -near_basis_rate（源端 dom=(F-S)/S）",
        "pitDiscipline": (
            "每次拉取携带 fetchedAt 并留档 fetches/；历史接口为查询日可见序列，"
            "重复 (symbol,date) 记 revisions.jsonl；FS-02 正式启用前须过 GA-6 质量门。"
        ),
        "completedChunks": [],
        "lastDatePerSymbol": {},
        "revisionCount": 0,
    }
    save_json(MANIFEST, manifest)
    for p in [REVISIONS]:
        if not p.exists():
            p.write_text("", encoding="utf-8")
    print(f"initialized {STORE.relative_to(ROOT)} universe={len(universe)}")


def cmd_fetch_week(args):
    start = s2d(args.start)
    end = s2d(args.end)
    universe = [s.strip() for s in args.symbols.split(",")] if args.symbols else default_universe()
    ev = fetch_slice_retry(start, end, symbols=universe, verbose=True)
    rel = save_fetch_evidence(ev)
    print(f"fetched {ev['rows']} rows -> {rel}")
    if args.merge:
        store_rows = load_store_rows(universe)
        revision_log = load_revisions()
        inserted, revised, skipped = merge_slice(store_rows, ev, set(universe), revision_log)
        write_store_rows(store_rows)
        manifest = load_json(MANIFEST)
        manifest["completedChunks"].append({"startDay": ev["startDay"], "endDay": ev["endDay"],
                                            "universe": universe,
                                            "fetchedAt": ev["fetchedAt"], "rows": ev["rows"],
                                            "inserted": inserted, "revised": revised, "skipped": skipped})
        manifest["revisionCount"] = len(revision_log)
        save_json(MANIFEST, manifest)
        save_revisions(revision_log)
        print(f"merged: inserted={inserted} revised={revised} skipped={skipped}")


def cmd_backfill(args):
    start = parse_date(args.frm)
    end = parse_date(args.to) if args.to else date.today()
    universe = [s.strip() for s in args.symbols.split(",")] if args.symbols else default_universe()
    if start > end:
        raise SystemExit("--from must be <= --to")
    manifest = load_json(MANIFEST)
    if not manifest:
        raise SystemExit("run init first")
    covered = set()
    for c in manifest.get("completedChunks", []):
        if c.get("universe") == universe:
            covered.add((c["startDay"], c["endDay"]))
    store_rows = load_store_rows(universe)
    revision_log = load_revisions()
    cursor = start
    while cursor <= end:
        chunk_end = min(cursor + timedelta(days=SLICE_DAYS - 1), end)
        key = (d2s(cursor), d2s(chunk_end))
        if key in covered:
            print(f"skip {key[0]}..{key[1]} (covered)")
            cursor = chunk_end + timedelta(days=1)
            continue
        ev = fetch_slice_retry(cursor, chunk_end, symbols=universe, verbose=True)
        rel = save_fetch_evidence(ev)
        inserted, revised, skipped = merge_slice(store_rows, ev, set(universe), revision_log)
        write_store_rows(store_rows)
        manifest["completedChunks"].append({"startDay": key[0], "endDay": key[1],
                                            "universe": universe,
                                            "fetchedAt": ev["fetchedAt"], "rows": ev["rows"],
                                            "inserted": inserted, "revised": revised, "skipped": skipped})
        manifest["revisionCount"] = len(revision_log)
        save_json(MANIFEST, manifest)
        save_revisions(revision_log)
        print(f"{key[0]}..{key[1]} rows={ev['rows']} inserted={inserted} revised={revised} -> {rel}")
        cursor = chunk_end + timedelta(days=1)
        time.sleep(SLEEP_BETWEEN_CALLS)
    print("backfill done")


def cmd_verify(args):
    universe = [s.strip() for s in args.symbols.split(",")] if args.symbols else default_universe()
    issues = []
    per_symbol = {}
    total = 0
    revisions = 0
    if REVISIONS.exists():
        with open(REVISIONS, encoding="utf-8") as f:
            revisions = sum(1 for line in f if line.strip())
    for sym in universe:
        p = STORE / f"{sym}.jsonl"
        if not p.exists():
            per_symbol[sym] = {"rows": 0, "first": None, "last": None}
            continue
        rows = []
        with open(p, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                r = json.loads(line)
                rows.append(r)
        rows.sort(key=lambda r: r["date"])
        seen = set()
        for i, r in enumerate(rows):
            total += 1
            if r["date"] in seen:
                issues.append(f"{sym} duplicate date {r['date']}")
            seen.add(r["date"])
            if i > 0 and rows[i - 1]["date"] >= r["date"]:
                issues.append(f"{sym} unsorted at {r['date']}")
            if r["br"] is not None and r["domBasisRate"] is not None:
                expect = round(-r["domBasisRate"], 12)
                if abs(r["br"] - expect) > 1e-9:
                    issues.append(f"{sym} {r['date']} br mismatch {r['br']} vs {-r['domBasisRate']}")
        per_symbol[sym] = {"rows": len(rows), "first": rows[0]["date"] if rows else None,
                           "last": rows[-1]["date"] if rows else None}
    covered = [s for s, v in per_symbol.items() if v["rows"] > 0]
    summary = {
        "schema": "futures-radar-basis-history-summary/1",
        "verifiedAt": now_iso(),
        "universeSize": len(universe),
        "symbolsCovered": len(covered),
        "totalRows": total,
        "revisionEvents": revisions,
        "perSymbol": per_symbol,
        "issues": issues,
        "ok": len(issues) == 0,
    }
    save_json(SUMMARY, summary)
    print(f"verify ok={summary['ok']} symbols={summary['symbolsCovered']}/{summary['universeSize']} "
          f"rows={summary['totalRows']} revisions={revisions} issues={len(issues)}")
    for issue in issues[:20]:
        print("  ISSUE", issue)
    if args.strict and issues:
        raise SystemExit(1)


def cmd_inspect(args):
    p = STORE / f"{args.symbol}.jsonl"
    if not p.exists():
        raise SystemExit(f"no store for {args.symbol}")
    rows = [json.loads(line) for line in p.read_text(encoding="utf-8").splitlines() if line.strip()]
    print(f"{args.symbol}: {len(rows)} rows, {rows[0]['date'] if rows else '-'} .. {rows[-1]['date'] if rows else '-'}")
    for r in rows[:5]:
        print(json.dumps(r, ensure_ascii=False))
    if len(rows) > 5:
        print("...")
        for r in rows[-3:]:
            print(json.dumps(r, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser(description="GA-8 FS-02 PIT 基差历史采集器")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_init = sub.add_parser("init")
    p_init.set_defaults(fn=cmd_init)

    p_week = sub.add_parser("fetch-week")
    p_week.add_argument("--start", required=True)
    p_week.add_argument("--end", required=True)
    p_week.add_argument("--symbols", default=None)
    p_week.add_argument("--merge", action="store_true")
    p_week.set_defaults(fn=cmd_fetch_week)

    p_bf = sub.add_parser("backfill")
    p_bf.add_argument("--from", dest="frm", required=True)
    p_bf.add_argument("--to", default=None)
    p_bf.add_argument("--symbols", default=None)
    p_bf.set_defaults(fn=cmd_backfill)

    p_v = sub.add_parser("verify")
    p_v.add_argument("--symbols", default=None)
    p_v.add_argument("--strict", action="store_true")
    p_v.set_defaults(fn=cmd_verify)

    p_i = sub.add_parser("inspect")
    p_i.add_argument("--symbol", required=True)
    p_i.set_defaults(fn=cmd_inspect)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
