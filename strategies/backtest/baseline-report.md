# 完整策略链回测试点 baseline

- universe: RB0, M0, SC0
- dates: 2026-07-14, 2026-07-23, 2026-08-03, 2026-08-12, 2026-08-20
- LLM mode: llm-no-web

| date | symbol | direction | playbook | plan status | trigger | stop | prior feedback |
|------|--------|-----------|----------|-------------|---------|------|----------------|
| 2026-07-14 | SC0 | bullish | PB-01 | watch | 519 | 502.78 | — |
| 2026-07-23 | M0 | bullish | PB-01 | executable | 3175 | 3103.6 | — |
| 2026-08-03 | RB0 | bearish | PB-01 | executable | 2976 | 3026.4 | verified |
| 2026-08-12 | M0 | bullish | PB-03 | executable | 3142 | 3126 | verified |
| 2026-08-20 | SC0 | bullish | PB-01 | watch | 583 | 564.73 | verified |

## feedback results
```json
{
  "schema": "futures-radar-strategy-feedback/1",
  "meta": {
    "currentRunId": "verify-final",
    "verifiedAt": "2026-08-27T15:29:27.713Z",
    "pendingBefore": 0,
    "verified": 3
  },
  "results": [
    {
      "recordId": "bt-pilot-2026-07-23:M0",
      "status": "verified",
      "signalDate": "2026-07-23",
      "verifyDate": "2026-07-27",
      "entryDate": "2026-07-27",
      "exitDate": "2026-07-28",
      "entryPrice": 3203,
      "exitPrice": 3103.6,
      "exitType": "stopped_out",
      "stoppedOut": true,
      "target1Hit": false,
      "directionCorrect": false,
      "verificationSeries": "main-continuous-proxy",
      "attribution": [
        {
          "code": "stop_hit",
          "detail": "止损 3103.6 被触发；需归因：止损过紧 / 方向错误 / 事件冲击"
        },
        {
          "code": "direction_wrong",
          "detail": "实际方向与报告方向相反（entry=3203, exit=3103.6）"
        }
      ],
      "verifiedRunId": "verify-final"
    },
    {
      "recordId": "bt-pilot-2026-08-03:RB0",
      "status": "invalidated_not_triggered",
      "signalDate": "2026-08-03",
      "verifyDate": "2026-08-04",
      "verificationSeries": "main-continuous-proxy",
      "attribution": [
        {
          "code": "trigger_miss",
          "detail": "T+1 未触发入场（bearish 触发价 2976），计划按契约作废"
        }
      ],
      "verifiedRunId": "verify-final"
    },
    {
      "recordId": "bt-pilot-2026-08-12:M0",
      "status": "invalidated_not_triggered",
      "signalDate": "2026-08-12",
      "verifyDate": "2026-08-13",
      "verificationSeries": "main-continuous-proxy",
      "attribution": [
        {
          "code": "trigger_miss",
          "detail": "T+1 未触发入场（bullish 触发价 3142），计划按契约作废"
        }
      ],
      "verifiedRunId": "verify-final"
    }
  ]
}
```