# 完整策略链回测试点 baseline

- universe: RB0, HC0, I0, M0, Y0, SC0, TA0, MA0, CU0, AU0, EG0, RM0
- dates: 2026-07-02, 2026-07-08, 2026-07-14, 2026-07-20, 2026-07-24, 2026-07-30, 2026-08-05, 2026-08-11, 2026-08-17
- LLM mode: llm-no-web

| date | symbol | direction | playbook | plan status | trigger | stop | prior feedback |
|------|--------|-----------|----------|-------------|---------|------|----------------|
| 2026-07-02 | SC0 | bearish | PB-01 | watch | 430 | 448.2 | — |
| 2026-07-08 | M0 | bullish | PB-03 | executable | 3051 | 2999.7 | — |
| 2026-07-14 | MA0 | bullish | PB-01 | watch | 2632 | 2547.78 | verified |
| 2026-07-20 | M0 | bullish | PB-01 | executable | 3129 | 3065.4 | verified |
| 2026-07-24 | RM0 | bullish | PB-01 | watch | 2467 | 2388.06 | verified |
| 2026-07-30 | I0 | bearish | PB-01 | watch | 710 | 732.7 | verified |
| 2026-08-05 | CU0 | bullish | PB-03 | watch | 107340 | 105651 | verified |
| 2026-08-11 | SC0 | bullish | PB-01 | watch | 564 | 545.76 | verified |
| 2026-08-17 | MA0 | bullish | PB-01 | watch | 2735 | 2647.48 | verified |

## feedback results
```json
{
  "schema": "futures-radar-strategy-feedback/1",
  "meta": {
    "currentRunId": "verify-final",
    "verifiedAt": "2026-08-27T16:11:16.959Z",
    "pendingBefore": 0,
    "verified": 2
  },
  "results": [
    {
      "recordId": "bt-pilot-2026-07-08:M0",
      "status": "verified",
      "signalDate": "2026-07-08",
      "verifyDate": "2026-07-10",
      "entryDate": "2026-07-10",
      "exitDate": "2026-07-17",
      "entryPrice": 3043,
      "exitPrice": 3061,
      "exitType": "time_exit",
      "stoppedOut": false,
      "target1Hit": false,
      "directionCorrect": true,
      "verificationSeries": "main-continuous-proxy",
      "attribution": [
        {
          "code": "direction_correct",
          "detail": "实际方向与报告方向一致（entry=3043, exit=3061）"
        }
      ],
      "verifiedRunId": "verify-final"
    },
    {
      "recordId": "bt-pilot-2026-07-20:M0",
      "status": "verified",
      "signalDate": "2026-07-20",
      "verifyDate": "2026-07-22",
      "entryDate": "2026-07-22",
      "exitDate": "2026-07-29",
      "entryPrice": 3142,
      "exitPrice": 3109,
      "exitType": "time_exit",
      "stoppedOut": false,
      "target1Hit": false,
      "directionCorrect": false,
      "verificationSeries": "main-continuous-proxy",
      "attribution": [
        {
          "code": "direction_wrong",
          "detail": "实际方向与报告方向相反（entry=3142, exit=3109）"
        }
      ],
      "verifiedRunId": "verify-final"
    }
  ]
}
```