# 律所个人内账与经营结果 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将律师自担成本、两个月预存保障、实际/视同工资、合伙人税款、投资人资本流和律所真实经营成本纳入同一正式账期，并保留跨月结转及历史快照。

**Architecture:** 沿用 `2026-09-23-law-firm-finance-core.md` 的已提交分配批次；人员余额与律所经营结果在提交时写成不可变账期快照，页面和导出读取快照。工资与成本事实单独录入、受保护并留修订审计；第一期余额需要财务确认的期初值，之后从上月正式快照结转。

**Tech Stack:** Next.js 16、TypeScript、Prisma 5、PostgreSQL 16、`Prisma.Decimal`、Zod、Vitest、现有审计/权限/私有存储。

## Global Constraints

- 依赖 `2026-09-23-law-firm-finance-core.md` 的 `allocationVersion=2` 正式批次；不得从旧版或空批次派生个人余额。
- `grossSalary` 表示申报/工资表口径；新增 `actualCashPaid` 表示实际支付现金；二者不互相推定。“视同工资”时实际支付额必须为 0。
- 个人自担与律所承担由有依据的财务事实显式指定，不能从“个人/单位社保”列名或律师角色直接推断谁最终承担。
- 预存保障、可分配收入、合伙人税款和资本流分别记账；同一自担成本只能由预存或可分配收入承担一次。
- 期初余额必须有财务确认记录；缺记录时不能默认 0。个人应结余额允许负数；期末保障缺口以期末预存余额衡量。
- 外部三表、个人所得税、合伙人税额的法定口径由外部财务老师确认；系统这里只做内部核对。
- 本地测试只用 `synthetic-*` 资料；不导入真实工资、花名册、银行或客户文件；生产迁移、推送和部署不在本计划执行范围内。

---

## 文件结构与责任

| 文件 | 责任 |
| --- | --- |
| `src/lib/finance/internal-accounting.ts` | 个人双余额、预存使用与经营结果纯函数 |
| `src/lib/finance/internal-types.ts` | 余额、工资处理和经营成本 DTO |
| `src/server/finance/internal-accounting-actions.ts` | 工资、税款、资本事实的输入验证及审计 |
| `src/server/finance/internal-balances.ts` | 期初、跨月结转、个人和律所正式快照的唯一计算入口 |
| `src/server/finance/internal-operating-costs.ts` | 房租、办公、经营税费等成本事实与银行来源关联 |
| `src/server/finance/internal-workspaces.ts` | 从正式快照读取内账，去除每月期初写死 0 的逻辑 |
| `src/server/finance/internal-reports.ts`、`src/server/finance/internal-export.ts` | 经营结果及个人余额查询、导出 |
| `src/app/(app)/finance/internal/_components/ledger-workspace.tsx` | 个人/律所视图，展示构成和来源 |
| `src/app/(app)/finance/internal/_components/accounting-facts-workspace.tsx` | 工资、税款、资本和成本录入/复核 |
| `src/app/(app)/finance/internal/ledger/page.tsx` | 加载录入权限和事实 |
| `src/app/api/finance/internal/accounting/route.ts`、`payroll/route.ts`、`tax/route.ts`、`capital/route.ts` | 既有接口按新事实模型收敛 |
| `src/app/api/finance/internal/operating-costs/route.ts` | 经营成本写入和读取 |
| `prisma/schema.prisma`、`prisma/migrations/20260923000002_finance_person_balances/migration.sql` | 工资处理字段、期初值、成本和正式快照 |
| `src/tests/lib/finance-internal-accounting.test.ts`、`src/tests/server/finance-internal-accounting.test.ts`、`src/tests/server/finance-internal-reports.test.ts`、`src/tests/app/finance-internal-workspaces.test.tsx` | 对应回归 |

### 个人余额的唯一事实来源

| 金额 | 采用的事实 | 防重复规则 |
| --- | --- | --- |
| 律师本期所得 | `FinanceAllocationRecipient` 正式快照 | 不再把同一 `EARNED_INCOME` 台账行加一次 |
| 自担成本 | 财务确认的 `FinancePayrollFact.selfCostDue`，非工资成本另走有证据调整 | 不同时从工资列名和 `SELF_COST` 行推导第二份成本 |
| 预存入金、实际提款 | 有银行证据或明确凭据的个人台账事件 | 同一 `sourceRef` 只能记一次，不能再从资本流重复注入 |
| 合伙人税款预付 | `FinancePartnerTaxRecord.firmAdvance` | 同源 `PARTNER_TAX_ADVANCE` 台账行仅作投影，不重复相减 |
| 投资人出资/退资 | `FinanceCapitalFlow` | 不自动转成律师所得或律所经营收入 |

### Task 1: 消除预存与收入余额的重复扣减

**Files:** Modify `src/lib/finance/internal-accounting.ts`, `src/lib/finance/internal-types.ts`; Test `src/tests/lib/finance-internal-accounting.test.ts`.

**Interfaces:** `buildPersonalDoubleBalance(input: PersonalDoubleBalanceInput): PersonalDoubleBalance` 新增返回 `selfCostChargedToIncome`；输入新增 `reserveTargetMonthlyCost`，无值时使用本月 `selfCostDue`。

- [ ] **Step 1: 写失败测试。** 期初可分配 `0`、预存 `20000`、本期收入 `10000`、自担成本 `30000` 时，预存使用 `20000`，收入承担 `10000`，期末可分配 `0`，期末预存 `0`，以每月 `30000` 的两个月期末目标计保障缺口 `60000`。另测预存不足、预存多于成本、负可分配结转、零成本、分币尾差。
- [ ] **Step 2: 运行失败测试。** `npm run test:run -- src/tests/lib/finance-internal-accounting.test.ts`；预期原测试中的 `-20000.00`/`40000.00` 与新版正确断言不符。
- [ ] **Step 3: 替换个人余额公式。** `availableReserve = openingReserve + selfFundingIn`；`selfFundingUsed = min(availableReserve,selfCostDue)`；`selfCostChargedToIncome = selfCostDue - selfFundingUsed`；`reserveEnd = availableReserve - selfFundingUsed`；`distributableEnd = openingDistributable + earnedIncome - selfCostChargedToIncome - withdrawn - partnerTaxAdvance - unsettledHold`；`reserveGap = max(0, 2 × reserveTargetMonthlyCost - reserveEnd)`。所有计算使用 Decimal，输入成本和提取须非负。更新旧测试断言，使“可分配 + 预存”的合计变化等于收入加预存流入减成本与提取。
- [ ] **Step 4: 测试并提交。** 同 Step 2 命令预期 PASS；提交修改，消息 `fix: charge self costs only once across personal balances`。

### Task 2: 区分工资申报、实际支付与最终承担人

**Files:** Modify `prisma/schema.prisma`, `src/server/finance/internal-accounting-actions.ts`, `src/app/api/finance/internal/payroll/route.ts`; Create `prisma/migrations/20260923000002_finance_person_balances/migration.sql`; Test `src/tests/server/finance-internal-accounting.test.ts`.

**Interfaces:** `FinancePayrollFact` 新增 `isDeemedWage`、`actualCashPaid`、`selfCostDue`、`firmSalaryCost`、`firmSocialCost`、`firmFundCost` 和 `treatmentNote`；`FinancePayrollFactRevision` 保存修改前后金额快照、版本、操作者和时间。`savePayrollFact(input)` 继续返回 `{ id }`。

- [ ] **Step 1: 写失败测试。** “视同工资”可有申报工资 `8000.00` 且实际支付 `0.00`；若实际支付大于 0，拒绝。自担成本 `1300.00` 不会因为 `socialCompany=1000.00` 自动变成律所成本；只有显式 `firmSocialCost` 才计入律所。对同一人同月事实再保存时，版本增加且旧金额留在修订记录；未授权账号被拒绝。
- [ ] **Step 2: 运行失败测试。** `npm run test:run -- src/tests/server/finance-internal-accounting.test.ts`；预期新字段/修订断言失败。
- [ ] **Step 3: 增量迁移和服务。** 工资新增字段默认 0 或 `false`，旧行标记“承担口径待核对”，不得把默认 0 解释为已核对。事务内写当前事实、修订记录和审计；修订摘要含字段名、旧值、新值，不向普通日志输出工资数据。为工资、社保、公积金、报销和实际支付分别校验非负与两位小数；`isDeemedWage=true` 时 `actualCashPaid=0`。在独立测试库执行迁移演练，检查没有删除原工资事实。
- [ ] **Step 4: 测试并提交。** 同 Step 2 命令预期 PASS；`npm run prisma:validate` 预期 PASS；提交修改，消息 `feat: distinguish declared and paid payroll facts`。

### Task 3: 期初确认、跨月结转和不可变个人快照

**Files:** Modify `prisma/schema.prisma`, `prisma/migrations/20260923000002_finance_person_balances/migration.sql`, `src/server/finance/internal-allocation.ts`, `src/server/finance/materialization.ts`, `src/server/finance/internal-workspaces.ts`; Create `src/server/finance/internal-balances.ts`; Test `src/tests/server/finance-internal-accounting.test.ts`, `src/tests/server/finance-monthly-close.test.ts`.

**Interfaces:**

```ts
import type { Prisma } from "@prisma/client";
type OpeningBalanceInput = { userId: string; firstPeriod: string; distributable: string; reserve: string; evidenceRef: string };
type PersonPeriodSnapshot = { runId: string; userId: string; openingDistributable: string; openingReserve: string; earned: string; selfCostDue: string; selfFundingUsed: string; distributableEnd: string; reserveEnd: string; reserveGap: string };
function calculatePersonPeriodSnapshots(runId: string, period: string, db: Prisma.TransactionClient): Promise<PersonPeriodSnapshot[]>;
```

- [ ] **Step 1: 写失败测试。** 首月缺期初确认时正式提交阻断；显式零期初带证据可提交。八月期末可分配 `5000.00`、预存 `3000.00`，九月自动以这两个数为期初；若八月批次被替代，九月旧批次标为来源已过期，不复用。工资事实变更后旧快照金额不变，新批次才用新事实。同一税款预付同时有税款记录与台账投影时只扣一次，同一收款份额不再从 `EARNED_INCOME` 投影加一次。
- [ ] **Step 2: 运行失败测试。** `npm run test:run -- src/tests/server/finance-internal-accounting.test.ts src/tests/server/finance-monthly-close.test.ts`；预期缺期初和结转断言失败。
- [ ] **Step 3: 加快照模型。** `FinanceOpeningBalance` 每名人员只允许一条正式期初记录，保存 `firstPeriod`、两个余额、证据和财务确认人；`FinancePersonPeriodSnapshot` 以 `(runId,userId)` 唯一，保存全部输入、预存使用、期末余额和缺口。账期人员范围是本期分配受益人、工资事实人员、期初人员和上月仍有余额人员的并集，防止无新收款者余额消失。提交分配批次的同一事务里按稳定人员 ID 顺序生成快照；没有上月正式快照时只接受本期显式期初。`sourceFingerprintForPeriod` 包含本期事实、上月正式批次 ID/哈希及期初记录，并将计算引擎版本从 `allocation-v2` 提升为 `personal-v1`，使先前仅有分配行的批次不能被误复用。不得继续在 `internal-workspaces.ts` 中传 `openingDistributable:"0.00"` 与 `openingReserve:"0.00"` 作为默认值。
- [ ] **Step 4: 测试并提交。** 同 Step 2 命令预期 PASS；迁移验证通过；提交上述文件，消息 `feat: persist carried personal finance balances`。

### Task 4: 把律所真实成本计入经营结果

**Files:** Modify `prisma/schema.prisma`, `prisma/migrations/20260923000002_finance_person_balances/migration.sql`, `src/lib/finance/internal-accounting.ts`, `src/server/finance/internal-reports.ts`, `src/server/finance/materialization.ts`; Create `src/server/finance/internal-operating-costs.ts`, `src/app/api/finance/internal/operating-costs/route.ts`; Test `src/tests/lib/finance-internal-accounting.test.ts`, `src/tests/server/finance-internal-reports.test.ts`.

**Interfaces:** `FinanceOperatingCost` 保存 `period`、`category`（`RENT|OFFICE|TURNOVER_TAX|OTHER`）、`amount`、`sourceRowId?`、`evidenceRef?`、`createdById`；`FinanceFirmPeriodSnapshot` 对一个 `runId` 保存收入、渠道、律师、工资、社保公积金、房租办公、流转税费、其他成本及结果。

- [ ] **Step 1: 写失败测试。** 收入 `100000`、渠道 `20000`、律师 `35000`、律所承担工资 `5000`、社保公积金 `2000`、房租办公 `3000`、流转税费 `1000`，经营结果应为 `34000.00`。加入个人预存 `10000`、收入提取 `5000`、投资人出资 `50000`、合伙人个人实缴税 `2000` 后结果仍为 `34000.00`。同一银行支出不允许分类金额合计超过原支出。
- [ ] **Step 2: 运行失败测试。** `npm run test:run -- src/tests/lib/finance-internal-accounting.test.ts src/tests/server/finance-internal-reports.test.ts`；预期报表仍返回“留所金额”而失败。
- [ ] **Step 3: 接入经营成本事实。** 只有确认的银行支出或有证据的人工成本可以创建 `FinanceOperatingCost`，按银行来源行累计分类金额不得超过支出绝对值。工资中的 `firmSalaryCost/firmSocialCost/firmFundCost` 只计算一次；个人 `selfCostDue` 不作为律所成本。提交批次时写 `FinanceFirmPeriodSnapshot`，公式为律师费收入减渠道、律师、流转税费、律所承担工资/社保公积金、房租办公和其他成本。其他经营收入在本阶段固定为零并在报表说明中标明；需要纳入时先建立独立有证据的收入分类，不从资本流水或未核对银行入款自动推定。`FinanceCapitalFlow` 与 `FinancePartnerTaxRecord.personallyPaid` 不进入公式。
- [ ] **Step 4: 测试并提交。** 同 Step 2 命令预期 PASS；`npm run prisma:validate` 预期 PASS；提交上述文件，消息 `feat: include actual firm operating costs in finance snapshot`。

### Task 5: 补齐财务操作入口和报表解释

**Files:** Create `src/app/(app)/finance/internal/_components/accounting-facts-workspace.tsx`; Modify `src/app/(app)/finance/internal/ledger/page.tsx`, `src/app/(app)/finance/internal/_components/ledger-workspace.tsx`, `src/app/(app)/finance/internal/_components/types.ts`, `src/server/finance/internal-workspaces.ts`, `src/server/finance/internal-export.ts`, `docs/FINANCE-OPERATING-LOOP.md`; Test `src/tests/app/finance-internal-workspaces.test.tsx`, `src/tests/server/finance-internal-reports.test.ts`.

**Interfaces:** 页面经现有 `/payroll`、`/tax`、`/capital` 以及新增 `/operating-costs` API 保存；读视图包含期初、本期所得、预存使用、可分配余额、预存余额、两个月保障缺口及律所成本构成。

- [ ] **Step 1: 写失败测试。** 财务账号能从内账页录入/查看“申报工资”和“实际支付”、个人自担、律所承担、税款和资本；只读账号只看有权查看的数据，无提交按钮。测试个人预存使用与所得抵扣各显示一次，律所经营页显示具体成本行和计算批次。
- [ ] **Step 2: 运行失败测试。** `npm run test:run -- src/tests/app/finance-internal-workspaces.test.tsx src/tests/server/finance-internal-reports.test.ts`；预期新入口和快照字段断言失败。
- [ ] **Step 3: 实现表单和说明。** 以人员搜索/选择替代输入 `userId`；金额字段以人民币元显示，输入校验与服务端一致；“视同工资”明确展示申报额和实际支付额。资本出入、收入提取、律所预付与个人实缴税分组展示；任何可修改字段显示来源和期间。导出读取同一正式快照，标记“内部经营核对”，不称法定财务报表。
- [ ] **Step 4: 全阶段验证。** 聚焦测试预期 PASS；再运行 `npm run lint`、`npm run typecheck`、`npm run prisma:validate`、`npm run build`，均预期退出码 0；人工复算 Task 1/4 固定数字。提交上述文件，消息 `feat: expose firm payroll and personal ledger workspaces`。

## 本计划完成判定

- 个人预存和收入不重复承担同一笔成本；无期初证据不产生正式余额；跨月结转与被替代批次重算可解释。
- 视同工资、申报工资和实际支付有独立字段；工资事实与经营成本的最终承担人需要明确输入。
- 经营结果由已入账收入及真实律所成本计算，个人资金与投资人资本不混入损益。
- 下一阶段按 `2026-09-23-law-firm-finance-close.md` 完成专用导入、月结交付和验收。
