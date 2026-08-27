/**
 * LLM Replay
 * 离线 reasoning replay 编排器（backtest 侧 CJS，动态 import 复用 reasoning ESM）
 *
 * providerMode:
 * - mock: 测试注入 provider
 * - recorded: 按 packetHash+arm 从 fixture/归档读取最终模型 JSON
 * - live-model: 仅接受调用方显式注入 provider；缺 provider 直接抛错
 */

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const FOUR_ARMS = ['sp', 'ust-cot', 'st-cot', 'fincot'];
const DEFAULT_MODEL = { provider: 'recorded', modelId: 'recorded-fixture', temperature: 0, maxTokens: 1200 };

let reasoningRunnerPromise = null;
function loadReasoningRunner() {
  if (!reasoningRunnerPromise) {
    reasoningRunnerPromise = import(
      pathToFileURL(path.join(__dirname, '..', '..', 'reasoning', 'lib', 'reasoning-runner.js')).href
    );
  }
  return reasoningRunnerPromise;
}

let packetBundlePromise = null;
function loadPacketBundle() {
  if (!packetBundlePromise) {
    packetBundlePromise = import(
      pathToFileURL(path.join(__dirname, '..', '..', 'reasoning', 'lib', 'packet-bundle.js')).href
    );
  }
  return packetBundlePromise;
}

function buildRecordedProvider(recordedSource) {
  const index = new Map();
  for (const entry of recordedSource) {
    index.set(`${entry.packetHash}|${entry.arm}`, entry.text);
  }
  return {
    async complete({ prompt, model, metadata }) {
      const text = index.get(`${metadata.packetHash}|${metadata.arm}`);
      if (text === undefined) {
        throw new Error(
          `No recorded output for packetHash=${metadata.packetHash} arm=${metadata.arm}`
        );
      }
      return {
        text,
        provider: 'recorded',
        modelId: model?.modelId ?? 'recorded-fixture',
        temperature: model?.temperature ?? 0,
        maxTokens: model?.maxTokens ?? 1200
      };
    }
  };
}

/**
 * 离线 replay 一组 packet × arms，返回 rows（由调用方决定写 JSONL）
 * @param {object} args
 * @param {string} args.replayId
 * @param {object[]} args.packets
 * @param {string[]|string} [args.arms=['fincot']] - 'four' 展开为四臂
 * @param {'mock'|'recorded'|'live-model'} args.providerMode
 * @param {object|null} args.provider - mock/live-model 注入的 provider
 * @param {object[]} [args.recordedSource] - recorded 模式的 fixture/归档
 * @param {object} [args.model] - model metadata
 * @param {object} [args.rawOutcomeData] - outcome 数据（Task 7 消费）
 * @param {number} [args.parseRetries] - extractResult 失败后的额外重试次数；
 *   默认 live-model=2，mock/recorded=0（固定输出重试无意义）
 * @returns {Promise<object[]>} replay rows（契约 §1.4）
 */
async function replayReasoning({
  replayId,
  packets,
  arms = ['fincot'],
  providerMode,
  provider = null,
  recordedSource = null,
  model = DEFAULT_MODEL,
  rawOutcomeData = null,
  parseRetries = providerMode === 'live-model' ? 2 : 0
}) {
  const { runReasoningArm } = await loadReasoningRunner();
  const { assessPointInTime } = await loadPacketBundle();

  let resolvedArms = arms === 'four' ? FOUR_ARMS : arms;
  if (Array.isArray(resolvedArms) && resolvedArms.includes('four')) {
    resolvedArms = FOUR_ARMS;
  }

  let resolvedProvider = provider;
  if (providerMode === 'recorded') {
    if (!recordedSource || !Array.isArray(recordedSource)) {
      throw new Error('recorded providerMode requires recordedSource');
    }
    resolvedProvider = buildRecordedProvider(recordedSource);
  } else if (providerMode === 'live-model' && !provider) {
    throw new Error('live-model providerMode requires an explicitly injected provider');
  }
  if (!resolvedProvider) {
    throw new Error(`provider is required for providerMode=${providerMode}`);
  }

  const rows = [];

  for (const packet of packets) {
    // 资格必须从原始字段每次重算，缓存的 point_in_time 判定一律不信任
    const pointInTime = assessPointInTime(packet);

    for (const arm of resolvedArms) {
      if (!pointInTime.eligible) {
        rows.push({
          replayId,
          signalDate: packet.signalDate,
          symbol: packet.symbol,
          arm,
          packetHash: null,
          pointInTimeEligible: false,
          providerMode,
          promptHash: null,
          result: null,
          grounding: null,
          outcome: null,
          scoringStatus: 'non_point_in_time'
        });
        continue;
      }

      const entry = await runReasoningArm({
        packet,
        arm,
        provider: resolvedProvider,
        model,
        promptVersion: 'fincot-prompt@recorded',
        parseRetries
      });

      rows.push({
        replayId,
        signalDate: packet.signalDate,
        symbol: packet.symbol,
        arm,
        packetHash: entry.packetHash,
        pointInTimeEligible: true,
        providerMode,
        promptHash: entry.promptHash,
        result: entry.result,
        grounding: entry.grounding,
        outcome: null,
        // accepted 行待 llm-outcome（Task 7）评分
        scoringStatus:
          entry.status === 'accepted' ? null : entry.status
      });
    }
  }

  return rows;
}

module.exports = { replayReasoning, FOUR_ARMS };
