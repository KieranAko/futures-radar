#!/usr/bin/env python3
# collector/cfmmc_daily.py — CFMMC（中国期货市场监控中心）官方日线拉取（P0 交叉验证层）
# 用法: python collector/cfmmc_daily.py --date 20260827
# 输出: stdout JSON { date, fetchedAt, markets: {...}, rows: [...] }
# 策略（按已批准 P0 方案）:
#   - SHFE/INE/GFEX 首轮尝试
#   - DCE 重试 2 次（2s/5s 退避；该接口历史上有 JSONDecodeError）
#   - CZCE 单次尝试（发布更晚，失败标记 pending 延后比对，不阻塞）
# v0.1.3: 5 个市场并发拉取（互不依赖；rows/markets 内容不变，仅完成顺序可能不同，
# 验证层按 variety 过滤不受行序影响），实测整层 ~11s → ~4s。
import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

try:
    import akshare as ak
except ImportError:
    print(json.dumps({"error": "akshare_not_installed"}), file=sys.stderr)
    sys.exit(1)

MARKETS_FIRST = ['SHFE', 'INE', 'GFEX']
MARKETS_RETRY = ['DCE']          # 重试 2 次
MARKETS_LATER = ['CZCE']         # 延后比对：单次尝试，失败标 pending
# (market, attempts) 计划；并发执行（每日 5 次请求，量级很小）
MARKET_JOBS = [(m, 1) for m in MARKETS_FIRST] + [(m, 3) for m in MARKETS_RETRY] + [(m, 1) for m in MARKETS_LATER]


def fetch_market(ak, market, date, attempts):
    last_err = None
    for i in range(attempts):
        try:
            df = ak.get_futures_daily(start_date=date, end_date=date, market=market)
            rows = df.to_dict('records') if df is not None and len(df) > 0 else []
            return {'status': 'ok', 'rows': len(rows)}, rows
        except Exception as e:  # noqa: BLE001 - 来源不可控，统一分类
            last_err = f'{type(e).__name__}: {str(e)[:120]}'
            if i < attempts - 1:
                time.sleep(2 * (i + 1) + 1)  # 2s / 5s
    return {'status': 'failed', 'rows': 0, 'error': last_err}, []


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--date', required=True, help='YYYYMMDD')
    args = parser.parse_args()
    date = args.date.strip()
    if not (len(date) == 8 and date.isdigit()):
        print(json.dumps({'error': 'bad_date'}), file=sys.stderr)
        sys.exit(1)

    markets = {}
    rows_all = []

    def fetch_job(m, attempts):
        st, rows = fetch_market(ak, m, date, attempts=attempts)
        return m, st, rows

    with ThreadPoolExecutor(max_workers=len(MARKET_JOBS)) as ex:
        futures = [ex.submit(fetch_job, m, a) for m, a in MARKET_JOBS]
        for f in futures:
            m, st, rows = f.result()
            markets[m] = st
            rows_all.extend(rows)

    out = {
        'date': date,
        'fetchedAt': datetime.now().isoformat(),
        'markets': markets,
        'rows': [
            {
                'symbol': r.get('symbol'),
                'variety': r.get('variety'),
                'date': str(r.get('date')),
                'open': r.get('open'), 'high': r.get('high'), 'low': r.get('low'),
                'close': r.get('close'), 'settle': r.get('settle'), 'pre_settle': r.get('pre_settle'),
                'volume': r.get('volume'), 'open_interest': r.get('open_interest'),
                'turnover': r.get('turnover'),
            }
            for r in rows_all
            if r.get('symbol') is not None
        ],
    }
    print(json.dumps(out, ensure_ascii=False))


if __name__ == '__main__':
    main()
