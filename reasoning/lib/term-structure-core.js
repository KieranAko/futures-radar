/**
 * Term Structure Core — 纯函数（不依赖网络/文件系统，可单测）
 * 合约候选生成 / 合约挑选 / 主导合约解析 / term_structure 字段构造与组装
 *
 * P1 口径统一：main_price/main_contract/series_contract 全取主导合约
 * signalDate 收盘（与 price_data 干净序列同源），不再取主力连续收盘。
 * 前缀匹配用精确边界（前缀后必须紧跟纯数字），单字母品种不碰撞（A→AP/AG、I→IF）。
 */

/**
 * 主力连续代码 → 品种前缀（RB0 → RB，SA0 → SA）
 * @param {string} symbol - 主力连续代码
 * @returns {string} 品种前缀
 */
export function commodityPrefix(symbol) {
  return symbol.replace(/\d+$/, '');
}

/**
 * 合约代码是否属于品种前缀：前缀后必须紧跟纯数字（RB2610 ✓，RB0 ✗）
 * 精确边界防止单字母前缀碰撞（A→AP/AG/AL、I→IF）。
 */
function codeMatchesPrefix(code, prefix) {
  return code.startsWith(prefix) && /^\d+$/.test(code.slice(prefix.length));
}

/**
 * 生成近月/远月候选合约月份（YYMM 编码，跨年滚动）
 * 近月候选 [M+1, M+2, M]（跳过当月交割风险优先下月）
 * 远月候选 [M+3..M+9]（部分品种下一流动性远月超过 +6 月，如 SA 的 1/5/9 主力月）
 * @param {string} signalDate - YYYY-MM-DD
 * @returns {{near: string[], far: string[]}} 月份编码数组（如 ['2609']）
 */
export function resolveContractCandidates(signalDate) {
  const [year, month] = signalDate.split('-').map(Number);
  const code = (offset) => {
    const total = month + offset;
    const y = year + Math.floor((total - 1) / 12);
    const m = ((total - 1) % 12) + 1;
    return `${String(y).slice(-2)}${String(m).padStart(2, '0')}`;
  };
  return {
    near: [code(1), code(2), code(0)],
    far: [code(3), code(4), code(5), code(6), code(7), code(8), code(9)]
  };
}

/**
 * 从 Python 返回的 contracts 结果中挑选持仓量最大的可用合约
 * （远月选流动性最好的月份，避免拿到接近交割月的噪声报价）
 * @param {object} contractsResult - futures-term-structure.py 的 contracts 输出
 * @param {string[]} monthCandidates - 月份编码候选（如 ['2609']）
 * @param {string} prefix - 品种前缀
 * @param {string|null} excludeContract - 需排除的合约代码（远月不得与近月重复）
 * @returns {{contract: string|null, price: number|null}}
 */
export function pickContract(contractsResult, monthCandidates, prefix, excludeContract = null) {
  let best = null;
  for (const month of monthCandidates) {
    const contract = `${prefix}${month}`;
    if (contract === excludeContract) continue;
    const entry = contractsResult?.[contract];
    if (!entry || entry.available !== true || typeof entry.close !== 'number' || entry.close <= 0) {
      continue;
    }
    const liquidity =
      typeof entry.hold === 'number' ? entry.hold : typeof entry.volume === 'number' ? entry.volume : 0;
    if (!best || liquidity > best.liquidity) {
      best = { contract, price: entry.close, liquidity };
    }
  }
  return best ? { contract: best.contract, price: best.price } : { contract: null, price: null };
}

/**
 * 解析当日主导合约：候选合约中持仓量最大者（P0 干净序列的抓取目标）
 * 候选月份列表覆盖近月 + 远月（resolveContractCandidates），主导月份
 * 通常在列（SA 的 1/5/9、RB 的 1/5/10 主力月）。若主导不在候选内返回 null，
 * 调用方须 fallback 主力连续并显式标注，不得静默。
 * @param {object} contractsResult - Python contracts 输出
 * @param {string} prefix - 品种前缀（如 SA）
 * @returns {string|null} 主导合约代码（如 SA2701）
 */
export function resolveDominantContract(contractsResult, prefix) {
  let best = null;
  let bestLiquidity = -1;
  for (const [code, entry] of Object.entries(contractsResult)) {
    if (!codeMatchesPrefix(code, prefix)) continue;
    if (!entry || entry.available !== true) continue;
    const liquidity =
      typeof entry.hold === 'number' ? entry.hold : typeof entry.volume === 'number' ? entry.volume : 0;
    if (liquidity > bestLiquidity) {
      bestLiquidity = liquidity;
      best = code;
    }
  }
  return best;
}

/**
 * 挑选远月合约：必须比主导月份（全部候选持仓量最大者）更深的月份中
 * 选持仓量最大者。避免当主力连续跟踪某一远月时，把浅于该月的合约
 * 当作"远月"而误标期限结构方向。
 * @param {object} contractsResult - Python contracts 输出
 * @param {string[]} farMonthCandidates - 远月月份候选
 * @param {string} prefix - 品种前缀
 * @returns {{contract: string|null, price: number|null}}
 */
export function resolveFarContract(contractsResult, farMonthCandidates, prefix) {
  let dominantMonth = null;
  let dominantLiquidity = -1;
  for (const [code, entry] of Object.entries(contractsResult)) {
    if (!codeMatchesPrefix(code, prefix)) continue;
    if (!entry || entry.available !== true) continue;
    const liquidity =
      typeof entry.hold === 'number' ? entry.hold : typeof entry.volume === 'number' ? entry.volume : 0;
    if (liquidity > dominantLiquidity) {
      dominantLiquidity = liquidity;
      dominantMonth = code.slice(prefix.length);
    }
  }

  let best = null;
  for (const month of farMonthCandidates) {
    if (dominantMonth && month <= dominantMonth) continue;
    const contract = `${prefix}${month}`;
    const entry = contractsResult?.[contract];
    if (!entry || entry.available !== true || typeof entry.close !== 'number' || entry.close <= 0) {
      continue;
    }
    const liquidity =
      typeof entry.hold === 'number' ? entry.hold : typeof entry.volume === 'number' ? entry.volume : 0;
    if (!best || liquidity > best.liquidity) {
      best = { contract, price: entry.close, liquidity };
    }
  }
  return best ? { contract: best.contract, price: best.price } : { contract: null, price: null };
}

/**
 * 由三方价格构造 term_structure 字段（纯函数）
 * P1：main 口径统一为主导合约（与 price_data 干净序列同源），
 * series_contract 透传标记同一 packet 的干净序列合约。
 * @param {object} args
 * @param {string} args.signalDate - YYYY-MM-DD
 * @param {string} args.fetchedAt - 实际抓取时间 ISO8601
 * @param {string|null} args.mainContract - 主导合约代码（如 SA2701）
 * @param {number|null} args.mainPrice - 主导合约 signalDate 收盘价
 * @param {string|null} args.nearContract - 近月合约代码
 * @param {number|null} args.nearPrice - 近月收盘价
 * @param {string|null} args.farContract - 远月合约代码
 * @param {number|null} args.farPrice - 远月收盘价
 * @returns {object} term_structure 字段（或 { gap: 'missing' }）
 */
export function buildTermStructureField({
  signalDate,
  fetchedAt,
  mainContract,
  mainPrice,
  nearContract,
  nearPrice,
  farContract,
  farPrice
}) {
  const base = {
    source: 'akshare',
    asOf: `${signalDate}T15:00:00+08:00`,
    fetchedAt,
    _timestamp_origin: 'observed'
  };

  const pricesOk =
    typeof nearPrice === 'number' && nearPrice > 0 &&
    typeof farPrice === 'number' && farPrice > 0 &&
    typeof mainPrice === 'number' && mainPrice > 0;

  if (!pricesOk || !mainContract || !nearContract || !farContract) {
    return { ...base, gap: 'missing' };
  }

  const spreadPct = parseFloat((((farPrice - mainPrice) / mainPrice) * 100).toFixed(2));
  const shape = spreadPct >= 0 ? 'contango' : 'backwardation';

  return {
    ...base,
    near_contract: nearContract,
    main_contract: mainContract,
    series_contract: mainContract,
    far_contract: farContract,
    near_price: nearPrice,
    main_price: mainPrice,
    far_price: farPrice,
    spread_pct: spreadPct,
    shape,
    freshness: 'same_day',
    gap: null
  };
}

/**
 * 组装 term_structure 字段（纯函数，不依赖网络）
 * P1：main_price/main_contract 取主导合约 signalDate 收盘（与 price_data 干净序列
 * 同源），不再取 raw.json 主力连续收盘；series_contract 标记干净序列合约。
 * @param {object} args
 * @param {string} args.symbol - 主力连续代码（仅用于品种前缀解析）
 * @param {string} args.signalDate - YYYY-MM-DD
 * @param {string} args.fetchedAt - 实际抓取时间 ISO8601
 * @param {object} args.contractsResult - Python contracts 输出（close 为 signalDate 当日或之前最后 bar）
 * @returns {{field: object, dominantContract: string|null}}
 *   dominantContract 供 freeze-packets 干净序列复用（单一解析点，杜绝口径分叉）
 */
export function assembleTermStructure({ symbol, signalDate, fetchedAt, contractsResult }) {
  const prefix = commodityPrefix(symbol);
  const candidates = resolveContractCandidates(signalDate);

  const dominant = resolveDominantContract(contractsResult, prefix);
  const dominantEntry = dominant ? contractsResult[dominant] : null;
  const mainPrice =
    dominantEntry && typeof dominantEntry.close === 'number' && dominantEntry.close > 0
      ? dominantEntry.close
      : null;

  const near = pickContract(contractsResult, candidates.near, prefix);
  const far = resolveFarContract(contractsResult, candidates.far, prefix);

  const field = buildTermStructureField({
    signalDate,
    fetchedAt,
    mainContract: dominant,
    mainPrice,
    nearContract: near.contract,
    nearPrice: near.price,
    farContract: far.contract,
    farPrice: far.price
  });

  return { field, dominantContract: dominant };
}
