/**
 * train-scan — 开发池（train）网格扫描
 *
 * 在 train 区间上扫描 ER 阈值 × D0 slope 阈值网格，聚合机会层与方向层指标。
 * train 是历史调参池（样本内 29 日期 ⊂ 此区间），扫描结果只用于选参；
 * 最终验证在冻结的 valid 清单上一次完成，选参不得查看 valid 结果。
 */
import { runDirectionMatrixDate, evaluateDirectionMatrix } from './direction-matrix-runner.js';
import { buildReplayRaw } from './historical-holdout.js';

export const ER_GRID = [0.16, 0.18, 0.2, 0.22, 0.25, 0.3];
export const SLOPE_GRID = [0.2, 0.25, 0.3, 0.35, 0.4, 0.5];
export const TRAIN_FIRST = '2024-01-02';
export const TRAIN_LAST = '2026-06-16';

export function filterTrainDates(allDates, first, last) {
  return allDates.filter(d => d >= first && d <= last);
}

export function expandGrid(erGrid, slopeGrid) {
  const pairs = [];
  for (const erThreshold of erGrid) {
    for (const slopeThreshold of slopeGrid) pairs.push({ erThreshold, slopeThreshold });
  }
  return pairs;
}

export function scan(cache, options = {}) {
  const trainFirst = options.trainFirst ?? TRAIN_FIRST;
  const trainLast = options.trainLast ?? TRAIN_LAST;
  const erGrid = options.erGrid ?? ER_GRID;
  const slopeGrid = options.slopeGrid ?? SLOPE_GRID;
  const raw = buildReplayRaw(cache);
  const firstSymbol = Object.keys(cache.contracts)[0];
  const allDates = cache.contracts[firstSymbol].ohlcv.dates;
  const trainDates = filterTrainDates(allDates, trainFirst, trainLast);

  const grid = [];
  for (const { erThreshold, slopeThreshold } of expandGrid(erGrid, slopeGrid)) {
    const config = { erThreshold, topN: null, holdPeriod: 10, slopeThreshold };
    const dateResults = trainDates.map(d => runDirectionMatrixDate(d, raw, config));
    const ev = evaluateDirectionMatrix(dateResults);
    const d0 = ev.perLayer.d0;
    const opportunityHitRate = ev.totalWithOutcome > 0
      ? ev.strongOpportunities / ev.totalWithOutcome
      : null;
    grid.push({
      erThreshold,
      slopeThreshold,
      trainDates: trainDates.length,
      totalCandidates: ev.totalCandidates,
      totalWithOutcome: ev.totalWithOutcome,
      strongOpportunities: ev.strongOpportunities,
      opportunityHitRate,
      d0: {
        directionalWithOutcome: d0.directionalWithOutcome,
        directionHitRate: d0.directionHitRate,
        strongHitRate: d0.strongHitRate,
        avgNetReturn: d0.avgNetReturn,
        trades: d0.trades
      },
      d4: {
        directionalWithOutcome: ev.perLayer.d4.directionalWithOutcome,
        directionHitRate: ev.perLayer.d4.directionHitRate,
        strongHitRate: ev.perLayer.d4.strongHitRate,
        avgNetReturn: ev.perLayer.d4.avgNetReturn
      }
    });
  }
  return { trainFirst, trainLast, trainDates: trainDates.length, grid };
}
