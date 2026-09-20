// cost-anchor 模块根路径解析：V2：实验线已归档；本模块唯一活跃位置为 analyze/v2/cost-anchor
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function findRoot(start) {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'lib', 'workspace.cjs'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('cost-anchor: cannot find skill root');
    dir = parent;
  }
}

module.exports = findRoot(__dirname);
