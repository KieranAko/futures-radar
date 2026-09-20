#!/usr/bin/env python3
"""ga6-spot-stickiness.py — GA-6 生意社现货粘性质量门 v0 逐品种审计（falsification 数据前置）

用法:
    python ga6-spot-stickiness.py audit [--start 20260710] [--end 20260828] [--anchor-date 20260827]

数据源（仓库允许源）:
    akshare futures_spot_price_daily（生意社现货挂牌价日线 + 主力基差，2011+）
    akshare futures_spot_price_previous（180 日主力基差分布锚）

质量门（t2 §FS-02 + GA-6 契约）:
    30 日零变动占比 > 40% 的品种剔除出 FS-02 可交易集。
    （现货挂牌价连续两个交易日不变的观测计数 / 窗口内可观测变动次数）

PIT 纪律（F7）:
    每次拉取记录 fetchedAt；本审计为"采集日快照"样例审计（v0），
    历史回填必须逐日 PIT 拉取，禁止用今日数据回填历史（清单落 ga6-pit-checklist）。

输出（falsification/data/）:
    ga6-fetch-spot-daily.json      PIT 抓取证据（窗口全量）
    ga6-fetch-spot-previous.json   PIT 抓取证据（180 日锚）
    ga6-spot-stickiness.json       逐品种审计（零变动占比/剔除判定/修订风险标注）
    ga6-tradable-set.json          FS-02 可交易集名单（剔除清单 + 口径说明）
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
FALS = ROOT / "strategies" / "research" / "v2" / "falsification"
DATA = FALS / "data"

FETCH_DAILY = DATA / "ga6-fetch-spot-daily.json"
FETCH_PREV = DATA / "ga6-fetch-spot-previous.json"
OUT_STICKY = DATA / "ga6-spot-stickiness.json"
OUT_TRADABLE = DATA / "ga6-tradable-set.json"

ZERO_CHANGE_THRESHOLD = 0.40   # >40% 剔除（契约）
WINDOW_ROWS = 30               # 30 日窗口（最近 N 行）


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def save_json(p, obj):
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")


def fetch_spot_daily(start, end):
    import akshare as ak
    fetched_at = now_iso()
    df = ak.futures_spot_price_daily(start_day=start, end_day=end)
    rows = []
    for _, r in df.iterrows():
        rows.append({
            "date": str(r["date"]),
            "symbol": str(r["symbol"]),
            "spot_price": None if r["spot_price"] != r["spot_price"] else float(r["spot_price"]),
            "dominant_contract": str(r["dominant_contract"]),
            "dominant_contract_price": None if r["dominant_contract_price"] != r["dominant_contract_price"] else float(r["dominant_contract_price"]),
            "dom_basis": None if r["dom_basis"] != r["dom_basis"] else float(r["dom_basis"]),
            "dom_basis_rate": None if r["dom_basis_rate"] != r["dom_basis_rate"] else float(r["dom_basis_rate"]),
        })
    return {"kind": "akshare_futures_spot_price_daily", "fetchedAt": fetched_at,
            "startDay": start, "endDay": end, "rows": len(rows), "rowsData": rows}


def fetch_spot_previous(anchor_date):
    import akshare as ak
    fetched_at = now_iso()
    df = ak.futures_spot_price_previous(date=anchor_date)
    rows = []
    for _, r in df.iterrows():
        rows.append({
            "name": str(r["商品"]),
            "spot_price": None if r["现货价格"] != r["现货价格"] else float(r["现货价格"]),
            "dominant_contract": str(r["主力合约代码"]),
            "dominant_contract_price": None if r["主力合约价格"] != r["主力合约价格"] else float(r["主力合约价格"]),
            "dominant_basis": None if r["主力合约基差"] != r["主力合约基差"] else float(r["主力合约基差"]),
            "basis_hi_180d": None if r["180日内主力基差最高"] != r["180日内主力基差最高"] else float(r["180日内主力基差最高"]),
            "basis_lo_180d": None if r["180日内主力基差最低"] != r["180日内主力基差最低"] else float(r["180日内主力基差最低"]),
            "basis_mean_180d": None if r["180日内主力基差平均"] != r["180日内主力基差平均"] else float(r["180日内主力基差平均"]),
        })
    return {"kind": "akshare_futures_spot_price_previous", "fetchedAt": fetched_at,
            "anchorDate": anchor_date, "rows": len(rows), "rowsData": rows}


def audit_symbol(rows):
    """rows: 该品种按日期升序的观测列表（spot_price 可能 None）。
    零变动占比 = 最近 WINDOW_ROWS 行内 与前一行相等的观测数 / (行数-1)。"""
    valid = [r for r in rows if r["spot_price"] is not None]
    if not valid:
        return None
    window = valid[-WINDOW_ROWS:]
    distinct = len({r["spot_price"] for r in window})
    if len(window) >= 2:
        unchanged = sum(1 for i in range(1, len(window)) if window[i]["spot_price"] == window[i - 1]["spot_price"])
        ratio = unchanged / (len(window) - 1)
    else:
        ratio = None
    return {
        "rows": len(window),
        "distinct_values": distinct,
        "zero_change_ratio": ratio,
        "excluded": (ratio is not None and ratio > ZERO_CHANGE_THRESHOLD),
        "last_spot": window[-1]["spot_price"],
        "last_date": window[-1]["date"],
        "sticky_5d": (len(window) >= 6 and len({r["spot_price"] for r in window[-6:]}) == 1),
    }


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "audit"
    args = sys.argv[2:]
    start = "20260710"
    end = "20260828"
    anchor = "20260827"
    for i, a in enumerate(args):
        if a == "--start":
            start = args[i + 1]
        elif a == "--end":
            end = args[i + 1]
        elif a == "--anchor-date":
            anchor = args[i + 1]

    if mode == "fetch":
        daily = fetch_spot_daily(start, end)
        prev = fetch_spot_previous(anchor)
        save_json(FETCH_DAILY, daily)
        save_json(FETCH_PREV, prev)
        print(json.dumps({"ok": True, "dailyRows": daily["rows"], "prevRows": prev["rows"],
                          "fetchedAt": daily["fetchedAt"]}, ensure_ascii=False, indent=2))
        return 0

    if mode == "audit":
        daily = json.load(open(FETCH_DAILY, encoding="utf-8"))
        prev = json.load(open(FETCH_PREV, encoding="utf-8"))
        by_symbol = {}
        for r in daily["rowsData"]:
            by_symbol.setdefault(r["symbol"], []).append(r)
        for rows in by_symbol.values():
            rows.sort(key=lambda x: x["date"])

        per_symbol = {}
        no_spot = []
        for sym, rows in sorted(by_symbol.items()):
            a = audit_symbol(rows)
            if a is None:
                no_spot.append(sym)
                continue
            per_symbol[sym] = a

        excluded = [s for s, a in per_symbol.items() if a["excluded"]]
        tradable = [s for s, a in per_symbol.items() if not a["excluded"]]

        # 修订风险样例审计 A：同日（prev anchorDate）daily 接口 vs previous 接口对拍（同一生意社源）
        # previous 用商品中文名，daily 用字母 symbol → 经 config/symbols.json 名称映射 + 少量别名
        cfg = json.load(open(ROOT / "config" / "symbols.json", encoding="utf-8"))
        sym_list = cfg["symbols"] if isinstance(cfg["symbols"], list) else list(cfg["symbols"].values())
        def norm_sym(s):
            return s[:-1] if s.endswith("0") else s
        name_to_sym = {v.get("name"): norm_sym(v.get("symbol")) for v in sym_list if v.get("name")}
        aliases = {
            "线材": "WR", "石油沥青": "BU", "菜籽油OI": "OI", "菜籽粕": "RM",
            "甲醇MA": "MA", "涤纶短纤": "PF", "PX": "PX", "聚氯乙烯": "V", "聚乙烯": "L",
        }
        prev_by_sym = {}
        for r in prev["rowsData"]:
            sym = name_to_sym.get(r["name"]) or aliases.get(r["name"])
            if sym:
                prev_by_sym[sym] = r
        anchor = prev["anchorDate"]
        rev_checks = []
        for sym, rows in sorted(by_symbol.items()):
            row = next((r for r in rows if r["date"] == anchor), None)
            if row is None:
                continue
            p = prev_by_sym.get(sym)
            if p is None:
                rev_checks.append({"symbol": sym, "date": anchor,
                                   "issue": "previous 接口无该品种锚（名称映射缺失）",
                                   "contract": row["dominant_contract"]})
                continue
            spot_diff = abs(row["spot_price"] - p["spot_price"]) if (row["spot_price"] is not None and p["spot_price"] is not None) else None
            basis_diff = abs(row["dom_basis"] - p["dominant_basis"]) if (row["dom_basis"] is not None and p["dominant_basis"] is not None) else None
            if spot_diff is None or spot_diff > 0.01 or (basis_diff is not None and basis_diff > 0.01):
                issue = "同源数值不一致（修订/口径差异）"
                sign_flip = False
                if basis_diff is not None and p["dominant_basis"] is not None:
                    # 符号相反判定：|daily − prev| ≈ 2×|prev| → 两个接口基差符号口径相反（F−S vs S−F）
                    tol = max(0.5, 0.01 * abs(p["dominant_basis"]))
                    if abs(basis_diff - 2 * abs(p["dominant_basis"])) <= tol:
                        issue = "基差符号口径相反（daily dom_basis=F−S vs previous=S−F；FS-02 采集器须统一符号）"
                        sign_flip = True
                rev_checks.append({"symbol": sym, "date": anchor, "spot_diff": round(spot_diff, 4) if spot_diff is not None else None,
                                   "basis_diff": round(basis_diff, 4) if basis_diff is not None else None,
                                   "signFlip": sign_flip,
                                   "issue": issue,
                                   "contract": row["dominant_contract"], "prevContract": p["dominant_contract"]})
        revision = {
            "anchorDate": anchor,
            "crossCheckedSymbols": len([1 for rows in by_symbol.values() if any(r["date"] == anchor for r in rows)]),
            "mismatches": rev_checks,
        }

        sticky_out = {
            "schema": "futures-radar-ga6-stickiness/1",
            "auditedAt": now_iso(),
            "qualityGate": "30 日零变动占比 > 40% 剔除出 FS-02 可交易集（t2 §FS-02 / GA-6）",
            "pitDiscipline": "F7：逐日 PIT 快照留档（fetch 文件含 fetchedAt）；历史回填禁止用今日数据",
            "window": {"startDay": daily["startDay"], "endDay": daily["endDay"],
                       "rowsPerSymbol": WINDOW_ROWS},
            "dailyFetch": {"fetchedAt": daily["fetchedAt"], "rows": daily["rows"]},
            "previousFetch": {"fetchedAt": prev["fetchedAt"], "rows": prev["rows"],
                              "anchorDate": prev["anchorDate"]},
            "symbolsAudited": len(per_symbol),
            "symbolsWithoutSpotQuote": no_spot,
            "excludedCount": len(excluded),
            "tradableCount": len(tradable),
            "revisionRiskSample": revision,
            "pitChecklist": {
                "F7-1": "每次拉取记录 fetchedAt（本审计 fetch 文件含 fetchedAt，auditedAt 为审计时刻）",
                "F7-2": "历史回填必须逐日 PIT 拉取（start=end=T 日），禁止用今日数据回填历史",
                "F7-3": "审计窗口为采集日快照（v0 样例）；GA-6 全量历史审计按逐日 PIT 重跑后冻结名单",
                "F7-4": "修订风险：生意社挂牌价为参考价，可能修订；回测引用值以当日快照文件为准，不追后修",
                "F7-5": "dominant_contract 换月导致 dom_basis 跳变与现货粘性无关，审计只统计 spot_price 序列",
            },
            "perSymbol": per_symbol,
        }
        save_json(OUT_STICKY, sticky_out)

        tradable_out = {
            "schema": "futures-radar-ga6-tradable-set/1",
            "generatedAt": now_iso(),
            "rule": "30 日零变动占比 ≤ 40% 才可进入 FS-02 可交易集（比率域 z 基差策略，现货挂牌价作为 S_t 输入）",
            "tradableSymbols": tradable,
            "excludedSymbols": [{s: {"zero_change_ratio": per_symbol[s]["zero_change_ratio"],
                                     "distinct_values": per_symbol[s]["distinct_values"],
                                     "last_date": per_symbol[s]["last_date"]}} for s in excluded],
            "noSpotQuoteSymbols": no_spot,
            "revisionRiskNotes": [
                "生意社现货价为挂牌/参考价，与真实成交价存在偏离；通过质量门的品种仍按 t2 口径降权观察（部分化工品挂牌价长期不动）",
                "回填历史必须 PIT 逐日拉取；本审计仅为采集日样例快照（v0），非历史回填",
                "dominant_contract 换月导致 dom_basis 跳变与现货粘性无关，审计只统计 spot_price 序列",
            ],
            "usage": "FS-02 基差历史批量采集器（第二批）按本名单过滤品种；名单在 GA-6 全量历史审计完成后冻结",
        }
        save_json(OUT_TRADABLE, tradable_out)
        print(json.dumps({
            "symbolsAudited": len(per_symbol), "excluded": len(excluded), "tradable": len(tradable),
            "noSpotQuote": no_spot, "excludedList": excluded,
        }, ensure_ascii=False, indent=2))
        return 0

    if mode == "recheck":
        # 修订风险样例审计 B：同日窗口重复拉取对拍（PIT 修订探针）
        import akshare as ak
        fetched_at = now_iso()
        df = ak.futures_spot_price_daily(start_day=anchor, end_day=anchor)
        rows = []
        for _, r in df.iterrows():
            rows.append({"symbol": str(r["symbol"]),
                         "spot_price": None if r["spot_price"] != r["spot_price"] else float(r["spot_price"])})
        daily = json.load(open(FETCH_DAILY, encoding="utf-8"))
        window_by_sym = {}
        for r in daily["rowsData"]:
            if r["date"] == anchor:
                window_by_sym[r["symbol"]] = r["spot_price"]
        diffs = []
        compared = 0
        for r in rows:
            w = window_by_sym.get(r["symbol"])
            if w is None:
                continue
            compared += 1
            if r["spot_price"] is None or w is None:
                diffs.append({"symbol": r["symbol"], "issue": "一侧缺值"})
            elif abs(r["spot_price"] - w) > 0.01:
                diffs.append({"symbol": r["symbol"], "window": w, "recheck": r["spot_price"],
                              "diff": round(r["spot_price"] - w, 4)})
        out = {"kind": "akshare_futures_spot_price_daily_recheck", "fetchedAt": fetched_at,
               "anchorDate": anchor, "rows": len(rows), "comparedSymbols": compared,
               "diffCount": len(diffs), "diffs": diffs}
        save_json(DATA / f"ga6-fetch-recheck-{anchor}.json", out)
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0

    print("unknown mode:", mode)
    return 1


if __name__ == "__main__":
    sys.exit(main())
