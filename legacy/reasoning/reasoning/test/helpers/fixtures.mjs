import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 测试用真实 raw.json 夹具路径。
 * 优先级：FUTURES_TEST_RAW_JSON 环境变量 > 内置夹具。
 * 内置夹具为真实 artifact 冻结切片（run 20260805-1027-auto 的 contracts.RB0，
 * fetchedAt 等源字段原样保留，与生产口径一致）。
 */
export const RAW_JSON_PATH = process.env.FUTURES_TEST_RAW_JSON
  || path.resolve(__dirname, '..', 'fixtures', 'raw-rb0-20260805.json');
