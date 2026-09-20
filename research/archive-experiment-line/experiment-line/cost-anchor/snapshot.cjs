// experiment-line/cost-anchor/snapshot.cjs — run 级快照投影 CLI
'use strict';

const { projectSnapshot } = require('./library.cjs');

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--runId');
  const runId = i >= 0 ? args[i + 1] : null;
  if (!runId) throw new Error('--runId required');
  const out = projectSnapshot(runId);
  console.log(`cost-anchor snapshot: ${out.symbols.length} symbols`);
  return out;
}

if (require.main === module) main();
module.exports = { main };
