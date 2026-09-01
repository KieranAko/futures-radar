# Git 推送策略 v1

> 目标：本地小步提交，远端批量落库；只在改动足够大或达到里程碑时推送，避免产生过多推送记录。

## 1. 原则

- 本地开发阶段可以频繁 commit；
- 未通过全量测试（`npm test`）不推送；
- 未达到里程碑/累积量/时间上限不推送；
- 数据正确性、生产阻断类修复走 T0 紧急通道（仍需测试全绿）；
- 不 force push main；落后远端时先合并/变基，再推送。

## 2. 推送门槛

| 等级 | 触发条件 |
|---|---|
| T0 紧急 | `--emergency`：生产数据错误、报告错误、安全/阻断问题 |
| T1 里程碑 | 有 `feat:` 提交，或显式 `--milestone`（功能模块完成并验证） |
| T2 累积量 | 未推送提交 ≥3 个，或净变更 ≥150 行 |
| T3 时间上限 | 距上次推送 ≥24 小时且存在未推送提交 |

判定器输出 `PUSH` 或 `HOLD`；`HOLD` 时列出各阈值的进度。

## 3. 命令

```bash
# 只判定，不跑测试
node scripts/git-push-policy.cjs --check

# 判定 → npm test → push
node scripts/git-push-policy.cjs --push

# 紧急通道 / 显式里程碑
node scripts/git-push-policy.cjs --push --emergency
node scripts/git-push-policy.cjs --push --milestone

# 自定义阈值（默认 3 commits / 150 行 / 24 小时）
node scripts/git-push-policy.cjs --check --min-commits 5 --min-lines 300 --max-hours 48
```

## 4. 推送前自动执行的检查

1. `origin/main..HEAD` 提交数与 diff 行数；
2. 是否落后远端（behind > 0 → HOLD）；
3. 工作区是否干净（不干净 → HOLD）；
4. `--push` 时先跑 `npm test`，失败即中止；
5. 推送成功后写入 `.git/futures-radar-push-policy.json` 记录 `lastPushAt`，供 T3 判定。

## 5. 提交历史瘦身（可选）

批量推送只减少推送事件；若还要减少远端 commit 条数：

- 功能开发走 feature branch，合并时 **Squash and merge**；
- 单人仓库可在推送前对同一功能的多个 commit 执行 `git reset --soft origin/main` 后重新提交为一条 `feat:` commit；
- 数据修复、独立 bugfix 可保留原子提交。

## 6. 例外与纪律

- T0 也需要 `--push` 完整测试流程，不能跳过；
- 不在本策略下使用 `git push -f`；
- 远端已有他人提交时，先 `git pull --rebase` 并重新测试。
