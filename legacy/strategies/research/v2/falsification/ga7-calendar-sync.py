#!/usr/bin/env python3
"""ga7-calendar-sync.py — GA-7 政策日历 YAML 结构校验 + 机器形态 JSON 同步

用法: python ga7-calendar-sync.py
读  : ga7-policy-calendar-v0.yaml（人工维护源）
写  : data/ga7-policy-calendar-v0.json（含 yamlSha256，供 ga7-f9-check.cjs 校验同源性）
"""
import hashlib
import json
import sys
from datetime import date
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[4]
FALS = ROOT / "strategies" / "research" / "v2" / "falsification"
YAML_PATH = FALS / "ga7-policy-calendar-v0.yaml"
JSON_PATH = FALS / "data" / "ga7-policy-calendar-v0.json"

ALLOWED_TYPES = {"policy_window", "structural_event", "reserve_window"}
SECTORS = {"black", "agriculture", "energy_chemical"}
DATE_RE = r"^\d{4}-\d{2}-\d{2}$"


def fail(msg):
    print("FAIL:", msg)
    sys.exit(1)


def check_dates(doc):
    import re
    for e in doc.get("events", []):
        if not re.match(DATE_RE, e.get("date", "")):
            fail("event %s: bad date %r" % (e.get("id"), e.get("date")))
        if e.get("end") and not re.match(DATE_RE, e["end"]):
            fail("event %s: bad end %r" % (e.get("id"), e.get("end")))
        if e.get("end") and e["end"] < e["date"]:
            fail("event %s: end < date" % e.get("id"))


def main():
    raw = YAML_PATH.read_bytes()
    doc = yaml.safe_load(raw.decode("utf-8"))
    if doc.get("schema") != "futures-radar-ga7-policy-calendar/1":
        fail("schema mismatch: %r" % doc.get("schema"))

    events = doc.get("events") or []
    if len(events) < 9:
        fail("need >= 9 event windows, got %d" % len(events))
    check_dates(doc)
    today = date.today().isoformat()
    future = [e["id"] for e in events if e["date"] > today]
    if future:
        fail("events dated in the future: %s" % future)

    by_sector = {}
    for e in events:
        sec = e.get("sector")
        if sec not in SECTORS:
            fail("event %s: sector %r not in %s" % (e.get("id"), sec, sorted(SECTORS)))
        if e.get("type") not in ALLOWED_TYPES:
            fail("event %s: type %r not allowed" % (e.get("id"), e.get("type")))
        if not isinstance(e.get("scope"), list) or not e["scope"]:
            fail("event %s: scope must be non-empty list" % e.get("id"))
        if not e.get("source") or not str(e["source"]).startswith("http"):
            fail("event %s: source must be http(s) URL (F9 反价格推演：事件必须留档来源)" % e.get("id"))
        if not isinstance(e.get("verified"), bool):
            fail("event %s: verified must be boolean" % e.get("id"))
        by_sector.setdefault(sec, []).append(e["id"])

    for sec in SECTORS:
        if len(by_sector.get(sec, [])) < 2:
            fail("sector %s needs >= 2 events, got %s" % (sec, by_sector.get(sec, [])))

    # FS-04(d)/FS-05(c)/EC-01(c) 所需窗口覆盖断言
    def covers_year(sec, year):
        for e in events:
            if e["sector"] != sec:
                continue
            d = e["date"][:4]
            en = (e.get("end") or e["date"])[:4]
            if d <= str(year) <= en:
                return e["id"]
        return None

    for sec, years in (("black", [2016, 2017, 2021, 2025]), ("agriculture", [2019, 2024]),
                       ("energy_chemical", [2020, 2022])):
        for y in years:
            if not covers_year(sec, y):
                fail("sector %s missing window covering year %d" % (sec, y))

    scheds = doc.get("schedules") or []
    for s in scheds:
        for k in ("type", "title", "rule", "scope", "source"):
            if not s.get(k):
                fail("schedule %s: missing %s" % (s.get("type"), k))
        if not str(s["source"]).startswith("http"):
            fail("schedule %s: source must be http(s) URL" % s.get("type"))

    sha = hashlib.sha256(raw).hexdigest()
    doc["yamlSha256"] = sha
    JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(JSON_PATH, "w", encoding="utf-8", newline="\n") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(json.dumps({
        "ok": True, "events": len(events), "schedules": len(scheds),
        "sectors": {k: len(v) for k, v in by_sector.items()},
        "yamlSha256": sha[:16] + "...", "json": str(JSON_PATH.relative_to(ROOT)),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
