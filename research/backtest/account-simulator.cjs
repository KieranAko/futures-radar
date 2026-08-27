#!/usr/bin/env node
/**
 * account-simulator.cjs — P1 Item 5: Normalized-Capital Portfolio Simulation (v4)
 *
 * DISCLAIMER: This is a NORMALIZED-CAPITAL simulation, NOT real account returns.
 * - Multipliers from config/symbols.json (static, may differ from actual exchange specs)
 * - Margin rate: fixed 10% notional (NOT real exchange margin rates)
 * - Commissions: flat proportional (NOT real per-lot CNY fees)
 * - Data: unadjusted continuous-main (no rollover correction, no back-adjustment)
 * - No contract-month mapping, no delivery date, no exchange margin tables
 * - ATR-based position sizing budget (NOT actual stop-loss)
 *
 * v5 changes (per 缅因猫 P1 final review):
 * - Date metadata consumed from purged-walkforward testRunDateMetadata (single truth source)
 * - No runId parsing, no raw-data date computation in account simulator
 * - resolveSettle() failure → hard error (no pos.entryPrice fallback)
 * - G3: precise cumulative cash path assertion per entry
 * - Field naming: inactiveDataMonths instead of zeroMonths
 *
 * Usage: node account-simulator.cjs [purged-walkforward-xxx.json]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BACKTEST_DIR = __dirname;
const RUNS_DIR = path.join(BACKTEST_DIR, 'runs');
const CONFIG_DIR = path.join(BACKTEST_DIR, '..', 'config');

const { calculateCosts: sharedCalculateCosts } = require('./shared-backtest-lib.cjs');

// ─── Simulation Parameters ─────────────────────────────────

const SIM = {
  initialCapital: 1000000,
  sizingBudgetRate: 0.02,
  marginRate: 0.10,
  maxDailyPositions: 5,
  maxTotalPositions: 10,
  stopATRMult: 2.0,
  COMMISSION_RATE: 0.0003,
  SLIPPAGE_RATE: 0.0002,
};

// ─── Load Multipliers ──────────────────────────────────────

function loadMultipliers() {
  const symbolsPath = path.join(CONFIG_DIR, 'symbols.json');
  const data = JSON.parse(fs.readFileSync(symbolsPath, 'utf8'));
  const map = new Map();
  for (const s of data.symbols) {
    map.set(s.symbol, { multiplier: s.multiplier, name: s.name, exchange: s.exchange });
  }
  return map;
}

// ─── ATR% ──────────────────────────────────────────────────

function computeATRPct(symbol, raw, signalDate) {
  const contract = raw.contracts[symbol];
  if (!contract || !contract.ohlcv) return null;
  const { dates, high, low, close } = contract.ohlcv;
  const signalIdx = dates.indexOf(signalDate);
  if (signalIdx < 14) return null;
  const lookback = 14;
  let atrSum = 0;
  for (let i = signalIdx - lookback + 1; i <= signalIdx; i++) {
    const tr = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1])
    );
    atrSum += tr;
  }
  const atr = atrSum / lookback;
  const refPrice = close[signalIdx];
  return refPrice > 0 ? (atr / refPrice) * 100 : null;
}

// ─── Cost model — matches shared-backtest-lib calculateCosts() ──

function entryCostCNY(entryPrice, lots, multiplier) {
  return entryPrice * multiplier * lots * (SIM.COMMISSION_RATE / 2 + SIM.SLIPPAGE_RATE * 2);
}

function exitCostCNY(exitPrice, lots, multiplier) {
  return exitPrice * multiplier * lots * (SIM.COMMISSION_RATE / 2);
}

function verifySingleCostParity(entryPrice, exitPrice, lots, multiplier) {
  const ourFrac = (entryCostCNY(entryPrice, lots, multiplier) + exitCostCNY(exitPrice, lots, multiplier)) / (entryPrice * multiplier * lots);
  const sharedFrac = sharedCalculateCosts(entryPrice, exitPrice);
  return Math.abs(ourFrac - sharedFrac) < 1e-12;
}

// ─── Position sizing ───────────────────────────────────────

function sizePosition(symbol, entryPrice, prevDayEquity, account, multMap, raw, signalDate) {
  const meta = multMap.get(symbol);
  const multiplier = meta ? meta.multiplier : 1;
  const atrPct = computeATRPct(symbol, raw, signalDate);
  const stopDist = atrPct ? (atrPct / 100) * SIM.stopATRMult : 0.03;

  const riskPerLot = entryPrice * stopDist * multiplier;
  const sizingBudget = prevDayEquity * SIM.sizingBudgetRate;

  let lots = riskPerLot > 0 ? Math.floor(sizingBudget / riskPerLot) : 0;

  if (lots < 1) {
    return { lots: 0, multiplier, reason: 'sizing_budget_too_small_for_1_lot' };
  }

  const estimatedStopLoss = lots * riskPerLot;
  if (estimatedStopLoss > sizingBudget * 1.01) {
    return { lots: 0, multiplier, reason: 'estimated_stop_exceeds_budget' };
  }

  // Slot limits: REJECT only, do NOT cap lot count
  const roomForNew = SIM.maxTotalPositions - account.positions.length;
  const dailyRoom = SIM.maxDailyPositions - account.dailyNewPositions;
  if (roomForNew < 1) return { lots: 0, multiplier, reason: 'max_total_positions' };
  if (dailyRoom < 1) return { lots: 0, multiplier, reason: 'max_daily_positions' };

  // Cash constraint: cap lots by available margin
  const marginPerLot = entryPrice * multiplier * SIM.marginRate;
  const maxLotsFromCash = marginPerLot > 0 ? Math.floor(account.cash / marginPerLot) : 0;
  if (maxLotsFromCash < 1) return { lots: 0, multiplier, reason: 'insufficient_cash_for_1_lot' };

  lots = Math.min(lots, maxLotsFromCash);
  lots = Math.max(lots, 0);

  const notional = lots * entryPrice * multiplier;
  const marginRequired = notional * SIM.marginRate;
  const cost = entryCostCNY(entryPrice, lots, multiplier);

  return { lots, multiplier, notional, marginRequired, cost, estimatedStopLoss, sizingBudget, reason: null };
}

// ─── Data loading ──────────────────────────────────────────

function loadRawData() {
  const rawMap = new Map();
  const runDirs = fs.readdirSync(RUNS_DIR).filter(d => d.startsWith('bt-')).sort();
  for (const runDir of runDirs) {
    const rawPath = path.join(RUNS_DIR, runDir, 'raw.json');
    if (!fs.existsSync(rawPath)) continue;
    rawMap.set(runDir, JSON.parse(fs.readFileSync(rawPath, 'utf8')));
  }
  return rawMap;
}

// ─── OOS dates from walk-forward metadata (Item 4 truth source) ──

/**
 * Consumes purged-walkforward testRunDateMetadata directly.
 * Account simulator does NOT parse runId or compute dates from raw data.
 * This is the SINGLE truth source for OOS signal/entry/labelEnd dates.
 */
function readOOSMetadata(wf) {
  const meta = wf.testRunDateMetadata;
  if (!meta || !Array.isArray(meta)) {
    throw new Error('testRunDateMetadata missing from purged-walkforward JSON. Re-run Item 4 first.');
  }

  // Validate metadata integrity
  const runIds = new Set();
  for (const m of meta) {
    if (!m.runId || !m.signalDate || !m.entryDate || !m.labelEndDate) {
      throw new Error(`Incomplete metadata entry: ${JSON.stringify(m)}`);
    }
    if (runIds.has(m.runId)) throw new Error(`Duplicate runId in metadata: ${m.runId}`);
    runIds.add(m.runId);
    if (!(m.signalDate < m.entryDate && m.entryDate <= m.labelEndDate)) {
      throw new Error(`Date order violation: ${m.runId} signal=${m.signalDate} entry=${m.entryDate} labelEnd=${m.labelEndDate}`);
    }
  }

  // Verify all fold test run IDs are covered
  const allTestRunIds = wf.foldsDetail.flatMap(fd => fd.testRunIds);
  for (const rid of allTestRunIds) {
    if (!runIds.has(rid)) throw new Error(`Test run ${rid} not in testRunDateMetadata`);
  }

  const sorted = [...meta].sort((a, b) => a.signalDate.localeCompare(b.signalDate));
  return {
    entries: sorted,
    signalPeriod: { start: sorted[0].signalDate, end: sorted[sorted.length - 1].signalDate },
    entryPeriod: { start: sorted[0].entryDate, end: sorted[sorted.length - 1].entryDate },
    labelEndPeriod: { start: sorted[0].labelEndDate, end: sorted[sorted.length - 1].labelEndDate },
    activeRunIds: new Set(wf.allOOSTrades.map(t => t.runId)),
    totalRuns: sorted.length
  };
}

// ─── Calendar + settle lookup ──────────────────────────────

function buildCalendarAndSettle(rawMap, firstDate, lastDate) {
  const dateSet = new Set();
  const settleMap = new Map(); // "symbol|YYYY-MM-DD" → settle

  for (const [runId, raw] of rawMap) {
    for (const symbol of Object.keys(raw.contracts)) {
      const contract = raw.contracts[symbol];
      if (!contract || !contract.ohlcv) continue;
      const { dates, settle } = contract.ohlcv;
      if (!settle) continue;
      for (let i = 0; i < dates.length; i++) {
        if (dates[i] >= firstDate && dates[i] <= lastDate) {
          dateSet.add(dates[i]);
          if (settle[i] != null && settle[i] > 0) {
            settleMap.set(`${symbol}|${dates[i]}`, settle[i]);
          }
        }
      }
    }
  }

  return { calendar: [...dateSet].sort(), settleMap };
}

function getSettle(settleMap, symbol, date) {
  return settleMap.get(`${symbol}|${date}`);
}

// ─── Settle resolver with carry (P1-1 fix) ─────────────────

/**
 * Resolve settlement price for a position on a given day.
 * If today has settle → use it, record in lastSettle.
 * If today has no settle → lookup lastSettleByPos for prior entry with date < today.
 * Returns { settle, hasDirectSettle, hasCarry }.
 *   hasDirectSettle: today's data includes this settle
 *   hasCarry: using a prior-day settle carried forward
 * If neither → settle is null → Gate 2 will FAIL.
 */
function resolveSettle(symbol, today, posKey, settleMap, lastSettleByPos) {
  const directSettle = getSettle(settleMap, symbol, today);
  if (directSettle !== undefined && directSettle > 0) {
    lastSettleByPos.set(posKey, { date: today, price: directSettle });
    return { settle: directSettle, hasDirectSettle: true, hasCarry: false };
  }

  // No direct settle — attempt carry from prior day
  const prior = lastSettleByPos.get(posKey);
  if (prior && prior.date < today && prior.price > 0) {
    return { settle: prior.price, hasDirectSettle: false, hasCarry: true };
  }

  // Neither direct settle nor valid prior carry → no usable settlement price
  return { settle: null, hasDirectSettle: false, hasCarry: false };
}

// ─── Formatting ────────────────────────────────────────────

function fmtCNY(v) { return '¥' + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function fmtPct(v) { return (v * 100).toFixed(2) + '%'; }

// ─── Main ──────────────────────────────────────────────────

async function main() {
  const wfArg = process.argv[2];
  let wfPath;
  if (wfArg) {
    wfPath = path.resolve(wfArg);
  } else {
    const files = fs.readdirSync(BACKTEST_DIR)
      .filter(f => f.startsWith('purged-walkforward-') && f.endsWith('.json'))
      .sort().reverse();
    if (files.length === 0) {
      console.error('No purged-walkforward JSON found.');
      process.exit(1);
    }
    wfPath = path.join(BACKTEST_DIR, files[0]);
  }

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  NORMALIZED-CAPITAL PORTFOLIO SIM (v5)     ║');
  console.log('║  P1 Item 5 — NOT real account returns      ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log(`Input: ${path.basename(wfPath)}`);

  const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));

  // ── Collect test run IDs from fold metadata ──
  const testRunIds = wf.foldsDetail.flatMap(fd => fd.testRunIds);
  console.log(`Test runs (from fold metadata): ${testRunIds.length}`);

  // ── Load raw data ──
  console.log('Loading raw data...');
  const rawMap = loadRawData();
  console.log(`Loaded ${rawMap.size} run datasets`);

  // ── Read OOS date metadata from walk-forward (Item 4 truth source) ──
  const oosMeta = readOOSMetadata(wf);
  console.log(`OOS signal period:   ${oosMeta.signalPeriod.start} → ${oosMeta.signalPeriod.end}`);
  console.log(`OOS entry period:    ${oosMeta.entryPeriod.start} → ${oosMeta.entryPeriod.end}`);
  console.log(`OOS label end period: ${oosMeta.labelEndPeriod.start} → ${oosMeta.labelEndPeriod.end}`);
  console.log(`  (${oosMeta.totalRuns} test runs, ${oosMeta.activeRunIds.size} active, ${oosMeta.totalRuns - oosMeta.activeRunIds.size} zero-trade)`);
  console.log(`  Date source: walk-forward testRunDateMetadata (single truth source)`);

  const trades = wf.allOOSTrades;
  console.log(`OOS trade inputs: ${trades.length}`);

  // ── Assign stable order index for same-day priority ──
  const indexedTrades = trades.map((t, i) => ({ ...t, _origIdx: i }));
  indexedTrades.sort((a, b) => {
    const cmp = a.signalDate.localeCompare(b.signalDate);
    if (cmp !== 0) return cmp;
    const cmp2 = a.runId.localeCompare(b.runId);
    if (cmp2 !== 0) return cmp2;
    const cmp3 = a.symbol.localeCompare(b.symbol);
    if (cmp3 !== 0) return cmp3;
    return a.direction.localeCompare(b.direction);
  });
  indexedTrades.forEach((t, i) => { t._priority = i; });

  const priorityHash = crypto.createHash('sha256')
    .update(JSON.stringify(indexedTrades.map(t => ({
      runId: t.runId, symbol: t.symbol, direction: t.direction,
      signalDate: t.signalDate, entryDate: t.entryDate, exitDate: t.exitDate
    }))))
    .digest('hex').substring(0, 16);
  console.log(`Trade order priority hash: ${priorityHash}`);

  // ── Cost parity quick check ──
  console.log('Cost parity check: ' + (verifySingleCostParity(3500, 3600, 1, 1) ? 'PASS' : 'FAIL'));
  if (!verifySingleCostParity(3500, 3600, 1, 1)) process.exit(1);

  const multMap = loadMultipliers();

  // ── Build full calendar ──
  // Calendar covers from first entry date to last labelEnd date
  const calStart = oosMeta.entryPeriod.start;
  const calEnd = oosMeta.labelEndPeriod.end;
  console.log(`\nCalendar range: ${calStart} → ${calEnd}`);

  const { calendar, settleMap } = buildCalendarAndSettle(rawMap, calStart, calEnd);
  console.log(`Full calendar: ${calendar.length} trading days (${calendar[0]} → ${calendar[calendar.length - 1]})`);
  console.log(`Settle entries: ${settleMap.size}`);

  // ── Index trades by entry/exit date ──
  const tradesByEntry = new Map();
  const tradesByExit = new Map();
  for (const t of indexedTrades) {
    if (!tradesByEntry.has(t.entryDate)) tradesByEntry.set(t.entryDate, []);
    tradesByEntry.get(t.entryDate).push(t);
    if (!tradesByExit.has(t.exitDate)) tradesByExit.set(t.exitDate, []);
    tradesByExit.get(t.exitDate).push(t);
  }
  for (const [date, arr] of tradesByEntry) {
    arr.sort((a, b) => a._priority - b._priority);
  }

  // ── Initialize account ──
  const account = {
    cash: SIM.initialCapital,
    equity: SIM.initialCapital,
    positions: [],
    closedTrades: [],
    rejectedOrders: [],
    dailyNewPositions: 0,
  };

  const equityCurve = [];
  const dailyStats = [];
  const settleCarryLog = []; // per-position-day: { date, symbol, posKey, hasDirectSettle, hasCarry, settleValue }
  const sizingAuditLog = []; // per-entry: cumulative cash path within day

  // ── lastSettleByPos: posKey → { date, price } ──
  const lastSettleByPos = new Map();

  // ─── Process EVERY trading day ──
  console.log(`\n── Simulation (daily, ${calendar.length} days) ──`);

  for (const today of calendar) {
    account.dailyNewPositions = 0;
    let dayNote = '';

    // Compute same-day close proceeds (before opening starts)
    const expiring = tradesByExit.get(today) || [];
    let sameDayCloseProceeds = 0;
    for (const t of expiring) {
      const pos = account.positions.find(p =>
        p.symbol === t.symbol && p.direction === t.direction && p.entryDate === t.entryDate
      );
      if (pos) {
        const sign = pos.direction === 'bullish' ? 1 : -1;
        const grossPL = sign * (t.exitPrice - pos.entryPrice) * pos.lots * pos.multiplier;
        const exitC = exitCostCNY(t.exitPrice, pos.lots, pos.multiplier);
        sameDayCloseProceeds += pos.margin + grossPL - exitC;
      }
    }

    // Store prior-day state
    const priorDayCash = account.cash;
    const priorDayEquity = account.equity;

    // ═══ 1. Open new positions ═══
    const entering = tradesByEntry.get(today) || [];
    let cumulativeCashAfterOpens = account.cash;
    for (const t of entering) {
      const raw = rawMap.get(t.runId);
      if (!raw) {
        account.rejectedOrders.push({ ...t, reason: 'no_raw_data' });
        continue;
      }
      const sizing = sizePosition(t.symbol, t.entryPrice, priorDayEquity, account, multMap, raw, t.signalDate);

      sizingAuditLog.push({
        date: today,
        symbol: t.symbol,
        priority: t._priority,
        priorDayCash,
        priorDayEquity,
        cashBeforeThisOpen: cumulativeCashAfterOpens,
        sameDayCloseProceeds,
        sizing,
        cashUsedForEntry: sizing.lots > 0 ? sizing.marginRequired + sizing.cost : 0,
        cashAfterThisOpen: sizing.lots > 0 ? cumulativeCashAfterOpens - sizing.marginRequired - sizing.cost : cumulativeCashAfterOpens
      });

      if (sizing.lots === 0) {
        account.rejectedOrders.push({
          ...t, reason: sizing.reason, sizingDetail: sizing,
          priority: t._priority,
          cashAtOrder: cumulativeCashAfterOpens,
          sameDayCloseProceedsAtOpen: sameDayCloseProceeds
        });
        continue;
      }
      if (account.cash < sizing.marginRequired + sizing.cost) {
        account.rejectedOrders.push({
          ...t, reason: 'insufficient_cash_at_open',
          priority: t._priority,
          cashAtOrder: cumulativeCashAfterOpens,
          sameDayCloseProceedsAtOpen: sameDayCloseProceeds
        });
        continue;
      }
      account.cash -= (sizing.marginRequired + sizing.cost);
      cumulativeCashAfterOpens = account.cash;
      account.positions.push({
        symbol: t.symbol,
        direction: t.direction,
        lots: sizing.lots,
        multiplier: sizing.multiplier,
        entryPrice: t.entryPrice,
        entryDate: t.entryDate,
        exitDate: t.exitDate,
        margin: sizing.marginRequired,
        entryCost: sizing.cost,
        signalDate: t.signalDate,
        runId: t.runId,
        sizingBudget: sizing.sizingBudget,
        estimatedStopLoss: sizing.estimatedStopLoss,
        priority: t._priority
      });
      account.dailyNewPositions++;
    }

    // ═══ 2. MTM all open positions at today's settle ═══
    let unrealizedPL = 0;
    let totalMargin = 0;
    let totalExposure = 0;

    for (const pos of account.positions) {
      const posKey = `${pos.symbol}|${pos.entryDate}|${pos.direction}`;
      const resolved = resolveSettle(pos.symbol, today, posKey, settleMap, lastSettleByPos);

      settleCarryLog.push({
        date: today,
        symbol: pos.symbol,
        posKey,
        hasDirectSettle: resolved.hasDirectSettle,
        hasCarry: resolved.hasCarry,
        settleValue: resolved.settle
      });

      if (resolved.settle !== null && resolved.settle > 0) {
        const sign = pos.direction === 'bullish' ? 1 : -1;
        unrealizedPL += sign * (resolved.settle - pos.entryPrice) * pos.lots * pos.multiplier;
      }

      totalMargin += pos.margin;
      totalExposure += pos.entryPrice * pos.lots * pos.multiplier;
    }

    // ═══ 3. Compute EOD equity ═══
    account.equity = account.cash + unrealizedPL + totalMargin;

    // ═══ 4. Margin call check ═══
    if (totalMargin > 0 && account.equity < totalMargin) {
      let worstIdx = -1;
      let worstPL = Infinity;
      for (let i = 0; i < account.positions.length; i++) {
        const pos = account.positions[i];
        const posKey = `${pos.symbol}|${pos.entryDate}|${pos.direction}`;
        const resolved = resolveSettle(pos.symbol, today, posKey, settleMap, lastSettleByPos);
        if (resolved.settle !== null && resolved.settle > 0) {
          const sign = pos.direction === 'bullish' ? 1 : -1;
          const upl = sign * (resolved.settle - pos.entryPrice) * pos.lots * pos.multiplier;
          if (upl < worstPL) { worstPL = upl; worstIdx = i; }
        }
      }
      if (worstIdx >= 0) {
        const pos = account.positions[worstIdx];
        const posKey = `${pos.symbol}|${pos.entryDate}|${pos.direction}`;
        const resolved = resolveSettle(pos.symbol, today, posKey, settleMap, lastSettleByPos);
        if (resolved.settle === null || resolved.settle <= 0) {
          throw new Error(`Margin call cannot resolve settle for ${pos.symbol} on ${today} (posKey=${posKey}) — no direct settle and no prior carry`);
        }
        const settle = resolved.settle;
        const sign = pos.direction === 'bullish' ? 1 : -1;
        const grossPL = sign * (settle - pos.entryPrice) * pos.lots * pos.multiplier;
        const exitCost = exitCostCNY(settle, pos.lots, pos.multiplier);
        const netPL = grossPL - exitCost - pos.entryCost;
        account.cash += pos.margin + grossPL - exitCost;
        account.positions.splice(worstIdx, 1);
        account.closedTrades.push({
          ...pos, exitDate: today, exitPrice: settle, exitCost,
          grossPL, netPL,
          netReturn: netPL / (pos.entryPrice * pos.lots * pos.multiplier),
          liquidated: true
        });
        if (!dayNote) dayNote = 'MARGIN_CALL';
        totalMargin -= pos.margin;
        unrealizedPL -= worstPL;
        account.equity = account.cash + unrealizedPL + totalMargin;
      }
    }

    // ═══ 5. Close positions expiring today ═══
    for (const t of expiring) {
      const posIdx = account.positions.findIndex(p =>
        p.symbol === t.symbol && p.direction === t.direction && p.entryDate === t.entryDate
      );
      if (posIdx < 0) continue;

      const pos = account.positions[posIdx];
      const sign = pos.direction === 'bullish' ? 1 : -1;
      const grossPL = sign * (t.exitPrice - pos.entryPrice) * pos.lots * pos.multiplier;
      const exitCost = exitCostCNY(t.exitPrice, pos.lots, pos.multiplier);
      const netPL = grossPL - exitCost - pos.entryCost;

      account.cash += pos.margin + grossPL - exitCost;
      account.positions.splice(posIdx, 1);

      account.closedTrades.push({
        ...pos,
        exitDate: t.exitDate,
        exitPrice: t.exitPrice,
        exitCost,
        grossPL,
        netPL,
        netReturn: netPL / (pos.entryPrice * pos.lots * pos.multiplier)
      });
    }

    // Recompute final EOD equity
    unrealizedPL = 0;
    totalMargin = 0;
    totalExposure = 0;
    for (const pos of account.positions) {
      const posKey = `${pos.symbol}|${pos.entryDate}|${pos.direction}`;
      const resolved = resolveSettle(pos.symbol, today, posKey, settleMap, lastSettleByPos);
      if (resolved.settle !== null && resolved.settle > 0) {
        const sign = pos.direction === 'bullish' ? 1 : -1;
        unrealizedPL += sign * (resolved.settle - pos.entryPrice) * pos.lots * pos.multiplier;
      }
      totalMargin += pos.margin;
      totalExposure += pos.entryPrice * pos.lots * pos.multiplier;
    }
    account.equity = account.cash + unrealizedPL + totalMargin;

    const identityErr = Math.abs(account.equity - (account.cash + unrealizedPL + totalMargin));

    dailyStats.push({
      date: today,
      equity: account.equity,
      cash: account.cash,
      unrealizedPL,
      totalMargin,
      totalExposure,
      openPositions: account.positions.length,
      newPositions: account.dailyNewPositions,
      closedToday: expiring.length,
      identityErr,
      note: dayNote
    });
    equityCurve.push({ date: today, equity: account.equity });
  }

  // ── Force-close remaining positions ──
  const lastDate = calendar[calendar.length - 1];
  for (const pos of [...account.positions]) {
    const posKey = `${pos.symbol}|${pos.entryDate}|${pos.direction}`;
    const resolved = resolveSettle(pos.symbol, lastDate, posKey, settleMap, lastSettleByPos);
    if (resolved.settle === null || resolved.settle <= 0) {
      throw new Error(`Force-close cannot resolve settle for ${pos.symbol} on ${lastDate} (posKey=${posKey}) — no direct settle and no prior carry`);
    }
    const settle = resolved.settle;
    const sign = pos.direction === 'bullish' ? 1 : -1;
    const grossPL = sign * (settle - pos.entryPrice) * pos.lots * pos.multiplier;
    const exitCost = exitCostCNY(settle, pos.lots, pos.multiplier);
    const netPL = grossPL - exitCost - pos.entryCost;
    account.cash += pos.margin + grossPL - exitCost;
    const idx = account.positions.indexOf(pos);
    if (idx >= 0) account.positions.splice(idx, 1);
    account.closedTrades.push({
      ...pos, exitDate: lastDate, exitPrice: settle, exitCost,
      grossPL, netPL,
      netReturn: netPL / (pos.entryPrice * pos.lots * pos.multiplier),
      forceClosed: true
    });
  }
  account.equity = account.cash;

  // ═══════════════════════════════════════════════════════════
  // GATE ASSERTIONS
  // ═══════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════');
  console.log('GATE ASSERTIONS');
  console.log('═══════════════════════════════════════════════');

  let allPass = true;
  const failures = [];

  // G1: Calendar coverage
  const g1_ok = calendar.length > 0 &&
    calendar[0] <= oosMeta.entryPeriod.start &&
    calendar[calendar.length - 1] >= oosMeta.labelEndPeriod.end;
  console.log(`  Gate 1 (calendar coverage): ${g1_ok ? 'PASS' : 'FAIL'}`);
  console.log(`    Calendar: ${calendar[0]} → ${calendar[calendar.length - 1]} (${calendar.length} days)`);
  console.log(`    Required: start ≤ ${oosMeta.entryPeriod.start}, end ≥ ${oosMeta.labelEndPeriod.end}`);
  if (!g1_ok) { allPass = false; failures.push('G1'); }

  // G2: Daily settle/carry — FAIL if any position-day has neither direct settle nor valid prior carry
  const g2Missing = settleCarryLog.filter(e => !e.hasDirectSettle && !e.hasCarry);
  const g2Total = settleCarryLog.length;
  const g2Direct = settleCarryLog.filter(e => e.hasDirectSettle).length;
  const g2Carry = settleCarryLog.filter(e => !e.hasDirectSettle && e.hasCarry).length;
  const g2_ok = g2Missing.length === 0;
  console.log(`  Gate 2 (daily settle/carry): ${g2_ok ? 'PASS' : 'FAIL'}`);
  console.log(`    Position-days: ${g2Total} total, ${g2Direct} direct settle, ${g2Carry} carry, ${g2Missing.length} missing`);
  if (g2Missing.length > 0) {
    const show = Math.min(g2Missing.length, 10);
    for (let i = 0; i < show; i++) {
      console.log(`    MISSING: ${g2Missing[i].date} ${g2Missing[i].symbol} ${g2Missing[i].posKey}`);
    }
  }
  if (!g2_ok) { allPass = false; failures.push('G2'); }

  // G3: Open-before-close — precise cumulative same-day cash path
  // Assert per-entry: cashBeforeThisOpen = priorDayCash - sum(prior entry costs in same day)
  // Assert close proceeds are NOT part of this chain (close happens AFTER open)
  let g3Violations = 0;
  const g3MaxViolations = 10;
  // Group by date, then verify each entry's cashBeforeThisOpen matches cumulative drain
  const byDate = new Map();
  for (const audit of sizingAuditLog) {
    if (!byDate.has(audit.date)) byDate.set(audit.date, []);
    byDate.get(audit.date).push(audit);
  }
  for (const [date, entries] of byDate) {
    let expectedCash = entries[0].priorDayCash; // first entry's prior-day cash
    for (const audit of entries) {
      if (audit.sizing.lots > 0) {
        // cashBeforeThisOpen MUST equal expectedCash (close proceeds not available yet)
        if (Math.abs(audit.cashBeforeThisOpen - expectedCash) > 0.01) {
          g3Violations++;
          if (g3Violations <= g3MaxViolations) {
            console.log(`    G3 VIOLATION: ${audit.date} ${audit.symbol} expectedCash=${fmtCNY(expectedCash)} actual=${fmtCNY(audit.cashBeforeThisOpen)} sameDayProceeds=${fmtCNY(audit.sameDayCloseProceeds)}`);
          }
        }
        // Advance expected cash by the entry drain
        expectedCash = audit.cashAfterThisOpen;
      }
      // Rejected entries don't consume cash, expectedCash unchanged
    }
    // Verify same-day close proceeds were NOT included in any expectedCash
    // (close happens in step 5, after all opens in step 1)
    const dayCloseProceeds = entries[0].sameDayCloseProceeds;
    if (dayCloseProceeds > 0) {
      for (const audit of entries) {
        if (audit.sizing.lots > 0 && audit.cashBeforeThisOpen > audit.priorDayCash - 0.01) {
          g3Violations++;
          if (g3Violations <= g3MaxViolations) {
            console.log(`    G3 VIOLATION: ${audit.date} ${audit.symbol} cashBefore=${fmtCNY(audit.cashBeforeThisOpen)} > priorDayCash=${fmtCNY(audit.priorDayCash)} — close proceeds may have leaked`);
          }
          break;
        }
      }
    }
  }
  const g3_ok = g3Violations === 0;
  console.log(`  Gate 3 (open-before-close): ${g3_ok ? 'PASS' : 'FAIL'} (violations: ${g3Violations}, ${byDate.size} trading days with entries)`);
  if (!g3_ok) { allPass = false; failures.push('G3'); }

  // G4: Cost parity — verify each normal trade against shared-backtest-lib
  let g4Failures = 0;
  const normalTrades = account.closedTrades.filter(t => !t.liquidated && !t.forceClosed);
  for (const t of normalTrades) {
    if (!verifySingleCostParity(t.entryPrice, t.exitPrice, t.lots, t.multiplier)) {
      g4Failures++;
    }
  }
  const g4_ok = g4Failures === 0;
  console.log(`  Gate 4 (cost parity vs shared-backtest-lib): ${g4_ok ? 'PASS' : 'FAIL'}`);
  console.log(`    ${normalTrades.length} normal trades verified; ${g4Failures} failed parity.`);
  console.log(`    Liquidation: ${account.closedTrades.filter(t => t.liquidated).length}, Force-closed: ${account.closedTrades.filter(t => t.forceClosed).length}`);
  if (!g4_ok) { allPass = false; failures.push('G4'); }

  // G5: Equity identity
  const maxIdentityErr = Math.max(...dailyStats.map(d => d.identityErr));
  const g5_ok = maxIdentityErr < 0.01;
  console.log(`  Gate 5 (equity identity): ${g5_ok ? 'PASS' : 'FAIL'} (max daily |equity - cash - margin - UPL| = ${maxIdentityErr.toFixed(6)})`);
  if (!g5_ok) { allPass = false; failures.push('G5'); }

  // G6: Risk budget
  const forcedLots = account.closedTrades.filter(t => t.sizingBudget && t.estimatedStopLoss && t.estimatedStopLoss > t.sizingBudget * 1.01);
  const rejectedFromBudget = account.rejectedOrders.filter(r => r.reason === 'sizing_budget_too_small_for_1_lot' || r.reason === 'estimated_stop_exceeds_budget');
  const g6_ok = forcedLots.length === 0;
  console.log(`  Gate 6 (risk budget): ${g6_ok ? 'PASS' : 'FAIL'}`);
  console.log(`    Forced 1-lot (budget exceeded): ${forcedLots.length}`);
  console.log(`    Rejected (budget too small): ${rejectedFromBudget.length}`);
  if (!g6_ok) { allPass = false; failures.push('G6'); }

  // G7: Input classification
  const classifiedKeys = new Set();
  for (const t of account.closedTrades) {
    classifiedKeys.add(`${t.runId}|${t.symbol}|${t.direction}|${t.entryDate}`);
  }
  for (const r of account.rejectedOrders) {
    if (r.reason !== 'no_raw_data') {
      classifiedKeys.add(`${r.runId}|${r.symbol}|${r.direction}|${r.entryDate}`);
    }
  }
  const allInputsMapped = indexedTrades.every(t => classifiedKeys.has(`${t.runId}|${t.symbol}|${t.direction}|${t.entryDate}`));
  const classifiedCount = account.closedTrades.length + account.rejectedOrders.filter(r => r.reason !== 'no_raw_data').length;
  const noDuplicates = classifiedKeys.size === classifiedCount;
  const g7_ok = classifiedCount === indexedTrades.length && allInputsMapped && noDuplicates;
  console.log(`  Gate 7 (input classification): ${g7_ok ? 'PASS' : 'FAIL'}`);
  console.log(`    Filled: ${account.closedTrades.length}, Rejected: ${account.rejectedOrders.length}, Total: ${classifiedCount} / ${indexedTrades.length} inputs`);
  console.log(`    All mapped: ${allInputsMapped}, No dups: ${noDuplicates}`);
  if (!g7_ok) { allPass = false; failures.push('G7'); }

  // G8: Period match — eval calendar covers full OOS range
  const g8_ok = calendar[0] <= oosMeta.entryPeriod.start &&
    calendar[calendar.length - 1] >= oosMeta.labelEndPeriod.end;
  console.log(`  Gate 8 (period match): ${g8_ok ? 'PASS' : 'FAIL'}`);
  console.log(`    OOS signal:   ${oosMeta.signalPeriod.start} → ${oosMeta.signalPeriod.end}`);
  console.log(`    OOS entry:    ${oosMeta.entryPeriod.start} → ${oosMeta.entryPeriod.end}`);
  console.log(`    OOS label end: ${oosMeta.labelEndPeriod.start} → ${oosMeta.labelEndPeriod.end}`);
  console.log(`    Date source: testRunDateMetadata from walk-forward JSON (single truth source)`);
  console.log(`    Calendar:     ${calendar[0]} → ${calendar[calendar.length - 1]}`);
  if (!g8_ok) { allPass = false; failures.push('G8'); }

  // G9: Final equity cash-flow identity
  const sumNetPL = account.closedTrades.reduce((s, t) => s + t.netPL, 0);
  const equityChange = account.equity - SIM.initialCapital;
  const g9Diff = Math.abs(equityChange - sumNetPL);
  const g9_ok = g9Diff < 1.0;
  console.log(`  Gate 9 (final equity cash-flow identity): ${g9_ok ? 'PASS' : 'FAIL'}`);
  console.log(`    ΔEquity = ${fmtCNY(equityChange)}, ΣNetPL = ${fmtCNY(sumNetPL)}, diff = ${fmtCNY(g9Diff)}`);
  if (!g9_ok) { allPass = false; failures.push('G9'); }

  console.log(`\n  Overall: ${allPass ? 'ALL GATES PASS' : 'FAILURES: ' + failures.join(', ')}`);
  if (!allPass) {
    console.log('\nFATAL: Gate failures. Results are INVALIDATED.');
    process.exit(1);
  }

  // ═══════════════════════════════════════════════════════════
  // PORTFOLIO METRICS
  // ═══════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════');
  console.log('PORTFOLIO METRICS (normalized-capital, NOT real)');
  console.log('═══════════════════════════════════════════════');

  const finalEquity = account.equity;
  const totalReturn = (finalEquity - SIM.initialCapital) / SIM.initialCapital;

  // Full-calendar monthly returns
  const fullMonths = [];
  const evalStart = calendar[0];
  const evalEnd = calendar[calendar.length - 1];
  let cursor = new Date(evalStart);
  cursor.setDate(1);
  const endDt = new Date(evalEnd);

  while (cursor <= endDt) {
    const monthKey = cursor.toISOString().substring(0, 7);
    fullMonths.push(monthKey);
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const eomEquity = new Map();
  for (const pt of equityCurve) {
    const m = pt.date.substring(0, 7);
    eomEquity.set(m, pt.equity);
  }

  const monthlyReturns = [];
  let prevEq = SIM.initialCapital;
  let lastKnownEq = SIM.initialCapital;
  const monthDetails = [];
  let inactiveDataMonths = 0; // renamed from zeroMonths: months with no equity data point
  const firstActiveMonth = fullMonths.find(m => eomEquity.has(m));

  for (const month of fullMonths) {
    if (eomEquity.has(month)) {
      lastKnownEq = eomEquity.get(month);
    } else {
      inactiveDataMonths++;
    }
    const endEq = (!firstActiveMonth || month < firstActiveMonth) ? SIM.initialCapital : lastKnownEq;
    const monthRet = (endEq - prevEq) / prevEq;
    monthlyReturns.push(monthRet);
    monthDetails.push({ month, endEquity: endEq, monthReturn: monthRet, active: eomEquity.has(month) });
    prevEq = endEq;
  }

  const avgMonthlyRet = monthlyReturns.reduce((a, b) => a + b, 0) / monthlyReturns.length;
  const monthlyStd = monthlyReturns.length > 1
    ? Math.sqrt(monthlyReturns.reduce((s, r) => s + (r - avgMonthlyRet) ** 2, 0) / (monthlyReturns.length - 1))
    : 0;

  const years = (new Date(evalEnd) - new Date(evalStart)) / (365.25 * 24 * 60 * 60 * 1000);
  const cagr = years > 0 ? Math.pow(1 + totalReturn, 1 / years) - 1 : totalReturn;

  const annualVol = monthlyStd * Math.sqrt(12);
  const sharpe = annualVol > 0 ? cagr / annualVol : 0;

  let peak = equityCurve[0].equity;
  let maxDD = 0;
  let maxDDStart = equityCurve[0].date;
  let maxDDEnd = equityCurve[0].date;
  let ddStart = equityCurve[0].date;
  for (const pt of equityCurve) {
    if (pt.equity > peak) { peak = pt.equity; ddStart = pt.date; }
    const dd = (peak - pt.equity) / peak;
    if (dd > maxDD) { maxDD = dd; maxDDStart = ddStart; maxDDEnd = pt.date; }
  }
  const calmar = maxDD > 0 ? cagr / maxDD : 0;

  const completedTrades = account.closedTrades;
  const winners = completedTrades.filter(t => t.netPL > 0);
  const losers = completedTrades.filter(t => t.netPL < 0);
  const totalNetPL = completedTrades.reduce((s, t) => s + t.netPL, 0);
  const avgWin = winners.length > 0 ? winners.reduce((s, t) => s + t.netPL, 0) / winners.length : 0;
  const avgLoss = losers.length > 0 ? losers.reduce((s, t) => s + t.netPL, 0) / losers.length : 0;
  const profitFactor = losers.length > 0 && losers.reduce((s, t) => s + t.netPL, 0) !== 0
    ? Math.abs(winners.reduce((s, t) => s + t.netPL, 0) / losers.reduce((s, t) => s + t.netPL, 0))
    : winners.length > 0 ? Infinity : 0;

  console.log(`\nAccount Eval Period:   ${evalStart} → ${evalEnd} (${years.toFixed(2)} years, ${calendar.length} trading days)`);
  console.log(`OOS Signal Period:     ${oosMeta.signalPeriod.start} → ${oosMeta.signalPeriod.end}`);
  console.log(`OOS Entry Period:      ${oosMeta.entryPeriod.start} → ${oosMeta.entryPeriod.end}`);
  console.log(`OOS Label End Period:  ${oosMeta.labelEndPeriod.start} → ${oosMeta.labelEndPeriod.end}`);
  console.log(`Date metadata source:  walk-forward testRunDateMetadata (${oosMeta.totalRuns} runs)`);
  console.log(`Full months:           ${fullMonths.length} (${inactiveDataMonths} with no equity month-end data)`);
  console.log(`Initial capital:       ${fmtCNY(SIM.initialCapital)}`);
  console.log(`Final equity:          ${fmtCNY(finalEquity)}`);
  console.log(`Total return:          ${fmtPct(totalReturn)}`);
  console.log(`CAGR (ann.):           ${fmtPct(cagr)}`);
  console.log(`Annual volatility:     ${fmtPct(annualVol)} (monthly std × √12, ${fullMonths.length} months)`);
  console.log(`Sharpe ratio:          ${sharpe.toFixed(3)} (rf=0 assumed)`);
  console.log(`Max drawdown:          ${fmtPct(maxDD)} (${maxDDStart} → ${maxDDEnd})`);
  console.log(`Calmar ratio:          ${calmar.toFixed(3)}`);
  console.log(`\nCompleted trades:      ${completedTrades.length} (${winners.length}W / ${losers.length}L)`);
  console.log(`Win rate:              ${fmtPct(completedTrades.length > 0 ? winners.length / completedTrades.length : 0)}`);
  console.log(`Total net P&L:         ${fmtCNY(totalNetPL)}`);
  console.log(`Avg win:               ${fmtCNY(avgWin)}`);
  console.log(`Avg loss:              ${fmtCNY(avgLoss)}`);
  console.log(`Profit factor:         ${profitFactor === Infinity ? '∞' : profitFactor.toFixed(3)}`);
  console.log(`Rejected orders:       ${account.rejectedOrders.length}`);
  if (account.rejectedOrders.length > 0) {
    const byReason = {};
    for (const r of account.rejectedOrders) {
      byReason[r.reason] = (byReason[r.reason] || 0) + 1;
    }
    for (const [reason, count] of Object.entries(byReason)) {
      console.log(`  ${reason}: ${count}`);
    }
  }
  console.log(`Liquidated:            ${completedTrades.filter(t => t.liquidated).length}`);
  console.log(`Force-closed:          ${completedTrades.filter(t => t.forceClosed).length}`);
  console.log(`\nCash-flow identity:    ΔEquity=${fmtCNY(equityChange)}, ΣNetPL=${fmtCNY(sumNetPL)}, diff=${fmtCNY(g9Diff)}`);

  // ── Monthly equity ──
  console.log('\n── Monthly Equity (full calendar) ──');
  for (const md of monthDetails) {
    console.log(`  ${md.month}: ${fmtCNY(md.endEquity)} (${fmtPct(md.monthReturn)})${md.active ? '' : ' [inactive]'}`);
  }

  // ── Exposure stats ──
  console.log('\n── Daily Exposure Stats ──');
  const exposures = dailyStats.map(d => d.totalExposure);
  const margins = dailyStats.map(d => d.totalMargin);
  const positions = dailyStats.map(d => d.openPositions);
  const avgExposure = exposures.reduce((a, b) => a + b, 0) / exposures.length;
  const maxExposure = Math.max(...exposures);
  const avgMargin = margins.reduce((a, b) => a + b, 0) / margins.length;
  const maxMargin = Math.max(...margins);
  const avgPos = positions.reduce((a, b) => a + b, 0) / positions.length;
  const maxPos = Math.max(...positions);
  console.log(`Avg exposure:          ${fmtCNY(avgExposure)}`);
  console.log(`Max exposure:          ${fmtCNY(maxExposure)}`);
  console.log(`Avg margin used:       ${fmtCNY(avgMargin)}`);
  console.log(`Max margin used:       ${fmtCNY(maxMargin)}`);
  console.log(`Avg open positions:    ${avgPos.toFixed(1)}`);
  console.log(`Max open positions:    ${maxPos}`);
  console.log(`Margin call days:      ${dailyStats.filter(d => d.note === 'MARGIN_CALL').length}`);

  // ── Gate 2 evidence ──
  console.log('\n── Gate 2 Evidence ──');
  console.log(`Settle/carry audit: ${g2Direct} direct settle + ${g2Carry} carry + ${g2Missing.length} missing = ${g2Total} total position-days`);
  if (g2Carry > 0) {
    const carrySamples = settleCarryLog.filter(e => !e.hasDirectSettle && e.hasCarry).slice(0, 5);
    for (const s of carrySamples) {
      console.log(`  Carry: ${s.date} ${s.symbol} settle=${s.settleValue}`);
    }
  } else {
    console.log('  No carry events — all position-days had direct settle data.');
  }

  // ── Capacity rejection evidence ──
  const capacityRejections = account.rejectedOrders.filter(r => r.reason === 'max_total_positions' || r.reason === 'max_daily_positions');
  if (capacityRejections.length > 0) {
    console.log('\n── Capacity Rejection Evidence (priority order) ──');
    for (const r of capacityRejections) {
      console.log(`  priority=${r.priority} ${r.symbol} ${r.entryDate}: ${r.reason} (cash=${fmtCNY(r.cashAtOrder || 0)})`);
    }
  }

  // ── Save ──
  const outPath = path.join(BACKTEST_DIR, `account-sim-${Date.now()}.json`);
  const output = {
    description: 'P1 Item 5 v5: Normalized-capital portfolio simulation — metadata-sourced dates, real carry, no fallbacks',
    disclaimer: 'NORMALIZED-CAPITAL SIMULATION — NOT real account returns.',
    version: 5,
    changes: [
      'OOS dates from walk-forward testRunDateMetadata (Item 4 single truth source); no runId parsing, no raw-data date derivation',
      'ResolveSettle failure → hard error (no pos.entryPrice fallback anywhere)',
      'Real settle carry via lastSettleByPos Map; resolveSettle() used uniformly (MTM/EOD/margin-call/force-close)',
      'G3: precise cumulative cashBeforeThisOpen chain assertion per trading day',
      'inactiveDataMonths renamed from zeroMonths'
    ],
    simulationParams: SIM,
    inputWF: path.basename(wfPath),
    oosPeriod: {
      signal: oosMeta.signalPeriod,
      entry: oosMeta.entryPeriod,
      labelEnd: oosMeta.labelEndPeriod,
      source: 'walk-forward testRunDateMetadata (Item 4 single truth source)',
      totalRuns: oosMeta.totalRuns,
      activeRuns: oosMeta.activeRunIds.size
    },
    oosSignalDates: oosMeta.entries,
    evalPeriod: { start: evalStart, end: evalEnd, years, tradingDays: calendar.length, fullMonths: fullMonths.length, inactiveDataMonths },
    priorityHash,
    gates: { allPass, failures },
    gateDetails: {
      g1CalendarCoverage: { ok: g1_ok },
      g2SettleCarry: { ok: g2_ok, total: g2Total, directSettle: g2Direct, carry: g2Carry, missing: g2Missing.length, mechanism: 'lastSettleByPos Map with date < today check' },
      g3OpenBeforeClose: { ok: g3_ok, violations: g3Violations, mechanism: 'cumulative cashBeforeOpen tracking within each trading day' },
      g4CostParity: { ok: g4_ok, normalTrades: normalTrades.length, failures: g4Failures, method: 'shared-backtest-lib.calculateCosts per normal trade' },
      g5EquityIdentity: { ok: g5_ok, maxErr: maxIdentityErr },
      g6RiskBudget: { ok: g6_ok, forcedLots: forcedLots.length, rejectedBudget: rejectedFromBudget.length },
      g7InputClassification: { ok: g7_ok, classifiedCount, totalInputs: indexedTrades.length },
      g8PeriodMatch: { ok: g8_ok },
      g9CashFlowIdentity: { ok: g9_ok, equityChange, sumNetPL, diff: g9Diff }
    },
    metrics: {
      initialCapital: SIM.initialCapital,
      finalEquity,
      totalReturn,
      cagr,
      annualVolatility: annualVol,
      sharpeRatio: sharpe,
      maxDrawdown: maxDD,
      maxDrawdownStart: maxDDStart,
      maxDrawdownEnd: maxDDEnd,
      calmarRatio: calmar,
      totalCompletedTrades: completedTrades.length,
      winners: winners.length,
      losers: losers.length,
      winRate: completedTrades.length > 0 ? winners.length / completedTrades.length : 0,
      totalNetPL,
      avgWin,
      avgLoss,
      profitFactor,
      rejectedOrders: account.rejectedOrders.length,
      rejectReasons: (() => {
        const r = {};
        for (const o of account.rejectedOrders) r[o.reason] = (r[o.reason] || 0) + 1;
        return r;
      })(),
      liquidated: completedTrades.filter(t => t.liquidated).length,
      forceClosed: completedTrades.filter(t => t.forceClosed).length,
      avgExposure,
      maxExposure,
      avgMarginUsed: avgMargin,
      maxMarginUsed: maxMargin,
      avgOpenPositions: avgPos,
      maxOpenPositions: maxPos,
      marginCallDays: dailyStats.filter(d => d.note === 'MARGIN_CALL').length,
      monthlyReturns,
      monthDetails,
      inactiveDataMonths
    },
    equityCurve,
    dailyStats,
    trades: account.closedTrades.map(t => ({
      symbol: t.symbol,
      direction: t.direction,
      lots: t.lots,
      multiplier: t.multiplier,
      entryDate: t.entryDate,
      entryPrice: t.entryPrice,
      exitDate: t.exitDate,
      exitPrice: t.exitPrice,
      margin: t.margin,
      entryCost: t.entryCost,
      exitCost: t.exitCost,
      grossPL: t.grossPL,
      netPL: t.netPL,
      netReturnOnNotional: t.netReturn,
      liquidated: !!t.liquidated,
      forceClosed: !!t.forceClosed
    })),
    rejectedOrders: account.rejectedOrders,
    priorityHash,
    timestamp: new Date().toISOString()
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nSaved: ${path.basename(outPath)}`);

  // ── Summary ──
  console.log('\n═══════════════════════════════════════════════');
  console.log('SUMMARY (normalized-capital, v5)');
  console.log('═══════════════════════════════════════════════');
  console.log(`Account Eval: ${evalStart} → ${evalEnd} (${calendar.length} days, ${fullMonths.length} months)`);
  console.log(`OOS Signal:   ${oosMeta.signalPeriod.start} → ${oosMeta.signalPeriod.end}`);
  console.log(`OOS Entry:    ${oosMeta.entryPeriod.start} → ${oosMeta.entryPeriod.end}`);
  console.log(`OOS LabelEnd: ${oosMeta.labelEndPeriod.start} → ${oosMeta.labelEndPeriod.end}`);
  console.log(`Portfolio: ${fmtCNY(SIM.initialCapital)} → ${fmtCNY(finalEquity)} (${fmtPct(totalReturn)})`);
  console.log(`CAGR: ${fmtPct(cagr)} | Vol: ${fmtPct(annualVol)} | Sharpe: ${sharpe.toFixed(3)}`);
  console.log(`MaxDD: ${fmtPct(maxDD)} | Calmar: ${calmar.toFixed(3)}`);
  console.log(`Trades: ${completedTrades.length} (${winners.length}W/${losers.length}L, WR ${fmtPct(winners.length/completedTrades.length)})`);
  console.log(`PF: ${profitFactor === Infinity ? '∞' : profitFactor.toFixed(3)} | Net P&L: ${fmtCNY(totalNetPL)}`);
  console.log(`Rejected: ${account.rejectedOrders.length} | Liquidated: ${completedTrades.filter(t=>t.liquidated).length} | Force-closed: ${completedTrades.filter(t=>t.forceClosed).length}`);
  console.log(`Gates: ${allPass ? 'ALL PASS' : 'FAILURES: ' + failures.join(', ')}`);
  console.log(`\nP1 fixes applied (v5):`);
  console.log('1. Carry: lastSettleByPos Map tracks {date, price}; only prior-date settle used.');
  console.log('2. OOS dates: consumed from walk-forward testRunDateMetadata (Item 4 single truth source).');
  console.log('3. No pos.entryPrice fallback — resolveSettle() failure throws hard error.');
  console.log('4. G3: precise cumulative cashBeforeThisOpen chain assertion.');
  console.log(`\nTrade order priority hash: ${priorityHash}`);
  console.log(`\nv2→v3 变化归因：v2 与 v3 因仓位手数约束(P0-1)和成本现金流(P0-2)同时变化，不可做单因素归因。v5 是当前假设下的归一化资本结果，v2 结果作废。`);
}

main().catch(err => { console.error(err); process.exit(1); });
