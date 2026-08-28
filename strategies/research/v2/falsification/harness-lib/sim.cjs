// falsification harness — deterministic trade simulator (T+1 fills, gap-abandon,
// stop-first path priority, time exits, roll-jump policy, cost model, R accounting)
'use strict';

const { assert, isFiniteNum, round } = require('./util.cjs');

// EntryIntent contract (produced by strategy adapters on signal bar T, closed prices):
// {
//   signalDate, direction: +1|-1,        // trade direction (legs carry per-leg side)
//   legs: [{ symbol, side (+1|-1), stop, target, weight }],   // stop/target in price terms
//   sizeR,                                // risk budget in R units (library pricingModel.position)
//   timeExitBars,                         // max holding bars including entry bar; null = unlimited
//   gapAbandon: { type:'atr', factor } | { type:'pct', pct } | null,
//   gapAtrValues: { SYM: number },        // PIT ATR at signal bar T (for atr gap rule)
//   tags: { ... },                        // theory-level subsample tags
//   manage: fn(ctx, bar) | null,          // optional dynamic exit/adjust hook (adapter-owned)
// }
class TradeSim {
  constructor({ cost, jumpDatesBySymbol, pathPriority = 'stop-first', log = null, derivedViews = null }) {
    this.cost = cost; // { roundtripBps, legs }
    this.jumpDatesBySymbol = jumpDatesBySymbol || {}; // sym -> Set(date)
    this.pathPriority = pathPriority;
    this.log = log;
    this.derivedViews = derivedViews || {}; // sym -> {fieldName: array} (PIT managed by caller)
    this.trades = [];
    this.abandons = [];
    this.pending = []; // intents awaiting their next-bar fill
    this.open = [];
    this._tradeSeq = 0;
  }

  _isJumpDate(symbol, date) {
    const s = this.jumpDatesBySymbol[symbol];
    return s ? s.has(date) : false;
  }

  submitIntent(intent, meta) {
    this.pending.push({ intent, meta });
  }

  // engine calls this every global date G: first fills, then open-trade management
  onGlobalDate(date, barIndexBySymbol) {
    this._lastBarIndex = barIndexBySymbol; // expose to manage hooks (PIT by date)
    // 1) fills due today: first global date > signalDate where ALL leg symbols have a bar
    const still = [];
    for (const p of this.pending) {
      const legs = p.intent.legs;
      const afterSignal = date > p.intent.signalDate;
      const allBars = legs.every((lg) => barIndexBySymbol[lg.symbol].has(date));
      if (afterSignal && allBars) {
        this._tryFill(p, date, barIndexBySymbol);
      } else {
        still.push(p);
      }
    }
    this.pending = still;
    // 2) manage open trades with today's bars
    for (const t of this.open.slice()) {
      this._manageTrade(t, date, barIndexBySymbol);
    }
  }

  _tryFill(p, date, barIndexBySymbol) {
    const intent = p.intent;
    // jump-bar entry ban (F5 / 换月日不作入场日)
    for (const lg of intent.legs) {
      if (this._isJumpDate(lg.symbol, date)) {
        this.abandons.push({ signalDate: intent.signalDate, date, reason: 'roll-jump-bar', intent: intent });
        return;
      }
    }
    // gap-abandon check (T+1 open vs T close)
    if (intent.gapAbandon) {
      for (const lg of intent.legs) {
        const idx = barIndexBySymbol[lg.symbol].get(date);
        if (idx === undefined || idx === 0) { this.abandons.push({ signalDate: intent.signalDate, date, reason: 'no-bar', intent: intent }); return; }
        const bars = p.meta.daily[lg.symbol];
        const open = bars.open[idx];
        const prevClose = bars.close[idx - 1];
        if (!isFiniteNum(open) || !isFiniteNum(prevClose)) {
          this.abandons.push({ signalDate: intent.signalDate, date, reason: 'non-finite-price', intent: intent });
          return;
        }
        const gap = Math.abs(open - prevClose);
        let threshold = Infinity;
        if (intent.gapAbandon.type === 'atr') {
          const atrVal = (intent.gapAtrValues || {})[lg.symbol];
          threshold = isFiniteNum(atrVal) && atrVal > 0 ? intent.gapAbandon.factor * atrVal : Infinity;
        } else if (intent.gapAbandon.type === 'pct') {
          threshold = intent.gapAbandon.pct / 100 * prevClose;
        }
        if (gap > threshold) {
          this.abandons.push({
            signalDate: intent.signalDate, date, reason: 'gap-abandon',
            symbol: lg.symbol, gap, threshold, intent: intent,
          });
          return;
        }
      }
    }
    // fill all legs at today's open
    const legs = intent.legs.map((lg) => {
      const idx = barIndexBySymbol[lg.symbol].get(date);
      const bars = p.meta.daily[lg.symbol];
      const entry = bars.open[idx];
      const stop = lg.stop;
      if (!isFiniteNum(entry) || !isFiniteNum(stop) || stop === entry) {
        throw new Error(`bad fill for ${lg.symbol}@${date}: entry=${entry} stop=${stop}`);
      }
      return {
        symbol: lg.symbol, side: lg.side, entry, stop, target: lg.target,
        stopInit: stop, targetInit: lg.target ?? null,
        weight: isFiniteNum(lg.weight) ? lg.weight : 1 / intent.legs.length,
        riskDist: Math.abs(entry - stop), exit: null, exitDate: null, exitReason: null,
      };
    });
    const trade = {
      id: this._tradeSeq++,
      direction: intent.direction,
      sizeR: intent.sizeR || 1,
      timeExitBars: intent.timeExitBars ?? null,
      entryDate: date,
      entryBarIndexes: Object.fromEntries(legs.map((lg, i) => [lg.symbol, barIndexBySymbol[lg.symbol].get(date)])),
      signalDate: intent.signalDate,
      legs,
      tags: intent.tags || {},
      manage: intent.manage || null,
      open: true,
      _meta: p.meta,
    };
    this.open.push(trade);
  }

  _manageTrade(trade, date, barIndexBySymbol) {
    if (!trade.open) return;
    // adapter dynamic management hook (z-based exits, F_t rules, ...)
    if (trade.manage) {
      const barInfo = {};
      const views = {};
      for (const lg of trade.legs) {
        const idx = barIndexBySymbol[lg.symbol].get(date);
        if (idx !== undefined) {
          const bars = this._barsFor(lg.symbol, trade);
          barInfo[lg.symbol] = {
            idx, date,
            open: bars.open[idx], high: bars.high[idx], low: bars.low[idx], close: bars.close[idx],
          };
          const fields = this.derivedViews[lg.symbol];
          if (fields) {
            views[lg.symbol] = { fields, anchorIdx: idx };
          }
        }
      }
      const decision = trade.manage({ trade, date, barInfo, views, sim: this });
      if (decision && decision.exit) {
        this._closeTrade(trade, date, decision.exitPrices, decision.reason || 'managed-exit', barIndexBySymbol);
        return;
      }
      if (decision && decision.adjust) {
        for (const [sym, upd] of Object.entries(decision.adjust)) {
          const lg = upd.legIndex !== undefined ? trade.legs[upd.legIndex] : trade.legs.find((l) => l.symbol === sym);
          if (lg) {
            if (upd.stop === 'disable') lg.stop = null;
            else if (isFiniteNum(upd.stop)) lg.stop = upd.stop;
            if (isFiniteNum(upd.target)) lg.target = upd.target;
          }
        }
      }
    }
    // fixed-price stop/target resolution, stop-first path priority (conservative)
    const perLegResult = {};
    let anyStop = false;
    let allTargets = true;
    for (const lg of trade.legs) {
      if (lg.exit !== null) continue;
      const idx = barIndexBySymbol[lg.symbol].get(date);
      if (idx === undefined) { allTargets = false; continue; } // symbol had no bar today
      const bars = this._barsFor(lg.symbol, trade);
      const o = bars.open[idx]; const h = bars.high[idx]; const l = bars.low[idx];
      const long = lg.side > 0;
      let exit = null; let reason = null;
      if (long) {
        if (isFiniteNum(o) && o <= lg.stop) { exit = o; reason = 'stop-gap-through'; }
        else if (isFiniteNum(l) && l <= lg.stop) { exit = lg.stop; reason = 'stop'; anyStop = true; }
        else if (isFiniteNum(o) && isFiniteNum(lg.target) && o >= lg.target) { exit = o; reason = 'target-gap-through'; }
        else if (isFiniteNum(h) && isFiniteNum(lg.target) && h >= lg.target) { exit = lg.target; reason = 'target'; }
      } else {
        if (isFiniteNum(o) && o >= lg.stop) { exit = o; reason = 'stop-gap-through'; }
        else if (isFiniteNum(h) && h >= lg.stop) { exit = lg.stop; reason = 'stop'; anyStop = true; }
        else if (isFiniteNum(o) && isFiniteNum(lg.target) && o <= lg.target) { exit = o; reason = 'target-gap-through'; }
        else if (isFiniteNum(l) && isFiniteNum(lg.target) && l <= lg.target) { exit = lg.target; reason = 'target'; }
      }
      if (exit !== null) {
        lg.exit = exit; lg.exitDate = date; lg.exitReason = reason;
        perLegResult[lg.symbol] = reason;
      } else {
        allTargets = false;
      }
    }
    if (anyStop) {
      // close all legs: non-stopped legs at today's close (spread integrity)
      for (const lg of trade.legs) {
        if (lg.exit === null) {
          const idx = barIndexBySymbol[lg.symbol].get(date);
          if (idx !== undefined) {
            const bars = this._barsFor(lg.symbol, trade);
            lg.exit = bars.close[idx]; lg.exitDate = date; lg.exitReason = 'close-on-sibling-stop';
          }
        }
      }
      this._finalize(trade, date, 'stop');
      return;
    }
    if (allTargets) {
      this._finalize(trade, date, 'target');
      return;
    }
    // roll-jump force close at previous close (F5: jump returns excluded from P&L)
    for (const lg of trade.legs) {
      if (this._isJumpDate(lg.symbol, date)) {
        for (const l2 of trade.legs) {
          const idx = barIndexBySymbol[l2.symbol].get(date);
          if (idx !== undefined && idx > 0 && l2.exit === null) {
            const bars = this._barsFor(l2.symbol, trade);
            l2.exit = bars.close[idx - 1]; l2.exitDate = bars.dates[idx - 1]; l2.exitReason = 'roll-jump';
          }
        }
        this._finalize(trade, date, 'roll-jump');
        return;
      }
    }
    // time exit at close of the timeExitBars-th bar (entry bar = bar 1)
    if (trade.timeExitBars !== null) {
      const firstLegBars = this._barsFor(trade.legs[0].symbol, trade);
      const idx = barIndexBySymbol[trade.legs[0].symbol].get(date);
      if (idx !== undefined) {
        const held = idx - trade.entryBarIndexes[trade.legs[0].symbol] + 1;
        if (held >= trade.timeExitBars) {
          for (const lg of trade.legs) {
            if (lg.exit === null) {
              const i2 = barIndexBySymbol[lg.symbol].get(date);
              if (i2 !== undefined) {
                const bars = this._barsFor(lg.symbol, trade);
                lg.exit = bars.close[i2]; lg.exitDate = date; lg.exitReason = 'time-exit';
              }
            }
          }
          this._finalize(trade, date, 'time-exit');
        }
      }
    }
  }

  _barsFor(symbol, trade) {
    return trade._meta.daily[symbol];
  }

  _closeTrade(trade, date, exitPrices, reason, barIndexBySymbol) {
    for (const lg of trade.legs) {
      if (lg.exit === null) {
        const price = exitPrices ? exitPrices[lg.symbol] : null;
        if (isFiniteNum(price)) {
          lg.exit = price; lg.exitDate = date; lg.exitReason = reason;
        } else {
          const idx = barIndexBySymbol[lg.symbol].get(date);
          if (idx !== undefined) {
            const bars = this._barsFor(lg.symbol, trade);
            lg.exit = bars.close[idx]; lg.exitDate = date; lg.exitReason = reason;
          }
        }
      }
    }
    this._finalize(trade, date, reason);
  }

  _finalize(trade, date, reason) {
    if (!trade.open) return;
    trade.open = false;
    trade.exitDate = date;
    trade.exitReason = reason;
    // R accounting + costs
    const { roundtripBps = 0, legs: nLegs } = this.cost || {};
    const perLegRoundtripBps = nLegs > 0 ? roundtripBps / nLegs : 0;
    let grossR = 0;
    let netR = 0;
    for (const lg of trade.legs) {
      if (lg.exit === null) throw new Error(`leg ${lg.symbol} never exited for trade ${trade.id}`);
      const rawR = (lg.side * (lg.exit - lg.entry)) / lg.riskDist;
      const costR = (perLegRoundtripBps / 1e4) * lg.entry / lg.riskDist;
      lg.rawR = round(rawR);
      lg.costR = round(costR);
      lg.netR = round(rawR - costR);
      grossR += lg.weight * rawR;
      netR += lg.weight * (rawR - costR);
    }
    trade.grossR = round(grossR * (trade.sizeR || 1));
    trade.netR = round(netR * (trade.sizeR || 1));
    this.trades.push(trade);
    const i = this.open.indexOf(trade);
    if (i >= 0) this.open.splice(i, 1);
  }

  // close everything still open at the very end of data (mark-to-close at last bar close)
  forceCloseAll(lastDate, barIndexBySymbol) {
    // close at the FOLD's last bar (per symbol: last bar <= lastDate), never at dataset end
    for (const t of this.open.slice()) {
      for (const lg of t.legs) {
        if (lg.exit === null) {
          const bars = this._barsFor(lg.symbol, t);
          let idx = barIndexBySymbol[lg.symbol].get(lastDate);
          if (idx === undefined) {
            idx = bars.dates.length - 1;
            while (idx >= 0 && bars.dates[idx] > lastDate) idx--;
          }
          if (idx >= 0) {
            lg.exit = bars.close[idx];
            lg.exitDate = bars.dates[idx];
            lg.exitReason = 'end-of-fold';
          }
        }
      }
      this._finalize(t, lastDate, 'end-of-fold');
    }
  }

  stats() {
    return {
      trades: this.trades.length,
      abandons: this.abandons.length,
      openLeft: this.open.length,
    };
  }
}

module.exports = { TradeSim };
