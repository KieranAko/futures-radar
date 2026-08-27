/**
 * Forward CLI — 前向验证记录闭环入口
 *
 * Usage:
 *   node forward-cli.js register <rawPath> <signalDate> [--manifest <path>]
 *   node forward-cli.js settle   <rawPath> <signalDate> [--manifest <path>]
 *   node forward-cli.js status   [--manifest <path>]
 *
 * 默认 manifest: data/futures-radar/forward/manifest.json
 * freezeSignalDate 未设置时 register 一律拒绝（正式样本必须从 freeze commit 后开始）。
 */

import { DEFAULT_MANIFEST_PATH } from './lib/forward-manifest.js';
import {
  registerForwardDate,
  settleForwardDate,
  getForwardStatus
} from './lib/forward-recorder.js';

function parseArgs(argv) {
  const args = { manifest: DEFAULT_MANIFEST_PATH };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--manifest') {
      args.manifest = argv[++i];
    } else {
      positional.push(argv[i]);
    }
  }
  args.positional = positional;
  return args;
}

function usage() {
  return [
    'usage:',
    '  node forward-cli.js register <rawPath> <signalDate> [--manifest <path>]',
    '  node forward-cli.js settle   <rawPath> <signalDate> [--manifest <path>]',
    '  node forward-cli.js status   [--manifest <path>]'
  ].join('\n');
}

const { positional, manifest } = parseArgs(process.argv.slice(2));
const [command, rawPath, signalDate] = positional;

try {
  switch (command) {
    case 'register': {
      if (!rawPath || !signalDate) throw new Error('register requires <rawPath> <signalDate>');
      const record = registerForwardDate(manifest, rawPath, signalDate);
      console.log(JSON.stringify({
        ok: true,
        signalDate,
        main: { candidateCount: record.main.candidateCount, d0Signals: record.main.d0Signals.length },
        control: { candidateCount: record.control.candidateCount, d0Signals: record.control.d0Signals.length }
      }, null, 2));
      break;
    }
    case 'settle': {
      if (!rawPath || !signalDate) throw new Error('settle requires <rawPath> <signalDate>');
      const settled = settleForwardDate(manifest, rawPath, signalDate);
      console.log(JSON.stringify({
        ok: true,
        signalDate,
        driftStatus: settled.driftStatus,
        mainTrades: settled.main.trades.length,
        controlTrades: settled.control.trades.length
      }, null, 2));
      break;
    }
    case 'status': {
      console.log(JSON.stringify(getForwardStatus(manifest), null, 2));
      break;
    }
    default:
      throw new Error(`unknown command "${command}"\n${usage()}`);
  }
} catch (err) {
  console.error(`forward-cli error: ${err.message}`);
  process.exit(1);
}
