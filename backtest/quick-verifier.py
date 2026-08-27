#!/usr/bin/env python3
"""
quick-verifier.py — 快速验证器

功能：
- 从缓存读取T到T+K的真实价格数据
- 验证预测的方向准确性和价格区间覆盖率
- 输出验证结果JSON

Usage:
    python quick-verifier.py --cache-path PATH --prediction-path PATH --verify-days N --output PATH
"""

import sys
import json
import argparse


def verify_prediction(prediction, cache, verify_days=3):
    """
    验证单个预测

    Args:
        prediction: 预测对象 {symbol, direction, confidence, close, hvCone3d, hvCone5d}
        cache: 缓存数据
        verify_days: 验证天数

    Returns:
        验证结果字典
    """
    symbol = prediction['symbol']
    as_of_date = prediction.get('asOfDate') or prediction.get('t_date')

    # 从缓存中获取合约数据
    if symbol not in cache['contracts']:
        return {
            'symbol': symbol,
            'status': 'error',
            'reason': f'Symbol {symbol} not found in cache'
        }

    contract = cache['contracts'][symbol]
    dates = contract['ohlcv']['dates']
    closes = contract['ohlcv']['close']

    # 找到T点索引
    try:
        t_idx = dates.index(as_of_date)
    except ValueError:
        return {
            'symbol': symbol,
            'status': 'error',
            'reason': f'Date {as_of_date} not found for {symbol}'
        }

    t_close = closes[t_idx]

    # 找到T+K点
    tk_idx = t_idx + verify_days
    if tk_idx >= len(dates):
        return {
            'symbol': symbol,
            'status': 'insufficient_data',
            'reason': f'Verify window extends beyond cache range'
        }

    tk_date = dates[tk_idx]
    tk_close = closes[tk_idx]
    change_pct = (tk_close - t_close) / t_close * 100

    # 验证方向
    actual_up = tk_close > t_close
    predict_up = prediction['direction'] == 'bullish'
    direction_correct = actual_up == predict_up

    # 验证价格区间覆盖
    cone3d = prediction.get('hvCone3d')
    cone5d = prediction.get('hvCone5d')

    in_cone68_3d = False
    in_cone95_3d = False
    in_cone68_5d = False
    in_cone95_5d = False

    # 根据验证天数选择合适的概率锥
    if verify_days <= 3 and cone3d:
        if cone3d.get('p68'):
            in_cone68_3d = cone3d['p68'][0] <= tk_close <= cone3d['p68'][1]
        if cone3d.get('p95'):
            in_cone95_3d = cone3d['p95'][0] <= tk_close <= cone3d['p95'][1]

    if verify_days >= 4 and cone5d:
        if cone5d.get('p68'):
            in_cone68_5d = cone5d['p68'][0] <= tk_close <= cone5d['p68'][1]
        if cone5d.get('p95'):
            in_cone95_5d = cone5d['p95'][0] <= tk_close <= cone5d['p95'][1]

    return {
        'symbol': symbol,
        'status': 'ok',
        'prediction': {
            'direction': prediction['direction'],
            'confidence': prediction['confidence'],
            't_close': t_close
        },
        'actual': {
            't_date': as_of_date,
            'tk_date': tk_date,
            'tk_close': tk_close,
            'change_pct': round(change_pct, 2),
            'price_path': closes[t_idx:tk_idx+1]
        },
        'correct': {
            'direction': direction_correct,
            'cone68_3d': in_cone68_3d if cone3d else None,
            'cone95_3d': in_cone95_3d if cone3d else None,
            'cone68_5d': in_cone68_5d if cone5d else None,
            'cone95_5d': in_cone95_5d if cone5d else None
        }
    }


def main():
    parser = argparse.ArgumentParser(description='Quick verifier for backtest predictions')
    parser.add_argument('--cache-path', required=True, help='Path to historical-cache.json')
    parser.add_argument('--prediction-path', required=True, help='Path to backtest-prediction.json')
    parser.add_argument('--verify-days', type=int, default=3, help='Verification days (default: 3)')
    parser.add_argument('--output', help='Output verification JSON file')
    args = parser.parse_args()

    # 读取缓存
    try:
        with open(args.cache_path, 'r', encoding='utf-8') as f:
            cache = json.load(f)
    except Exception as e:
        print(json.dumps({'error': 'cache_load_failed', 'detail': str(e)}), file=sys.stderr)
        sys.exit(1)

    # 读取预测
    try:
        with open(args.prediction_path, 'r', encoding='utf-8') as f:
            prediction_data = json.load(f)
    except Exception as e:
        print(json.dumps({'error': 'prediction_load_failed', 'detail': str(e)}), file=sys.stderr)
        sys.exit(1)

    # 验证所有预测
    predictions = prediction_data.get('predictions', [])
    as_of_date = prediction_data.get('asOfDate')

    verifications = []
    for pred in predictions:
        # 确保预测中有asOfDate
        if 'asOfDate' not in pred and as_of_date:
            pred['asOfDate'] = as_of_date

        result = verify_prediction(pred, cache, args.verify_days)
        verifications.append(result)

    # 构建输出
    output = {
        'meta': {
            'asOfDate': as_of_date,
            'verifyDays': args.verify_days,
            'totalPredictions': len(predictions),
            'verifiedAt': prediction_data.get('runId', 'unknown')
        },
        'verifications': verifications
    }

    # 输出
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            json.dump(output, f, indent=2, ensure_ascii=False)
        print(f'Verification written to {args.output}', file=sys.stderr)
    else:
        print(json.dumps(output, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
