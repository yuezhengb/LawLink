# 律所财务分配核心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每笔已确认律师费按本所规则产生可追溯、金额守恒、支持多人案源/承办/协办的正式分配；堵住空批次和旧口径误入月结的路径。

**Architecture:** `Payment` 与确认收款时派生的 `FeeEntry.COMMISSION` 是既有案件子账事实。新财务域保存付款级总额行与多个人员角色明细，使用同一来源指纹预览、提交和读取；旧批次保留只读，不能当成新口径月结批次。

**Tech Stack:** Next.js 16、TypeScript、Prisma 5、PostgreSQL 16、Zod、`Prisma.Decimal`、Vitest、现有 shadcn/ui。

## Global Constraints

- 使用已有 LawLink 仓库；先在隔离工作树实施，当前 `main` 上的旧计划 `2026-09-22-law-firm-finance.md` 已部分完成，不重跑其建表任务。
- 本计划只计算 `moneyKind = LAWYER_FEE` 且来源 `FeeEntry.confirmState = CONFIRMED` 的 `Payment`；退款必须关联原收款。
- 20% 渠道、45% 律所、35% 律师池均以每笔已确认律师费收款总额为基数，作为**未发布的初始模板**；退款另作负向事件。未由本所财务确认的规则不得自动发布或用于真实账期。
- 自拓合伙人留所 10%；独立律师留所按已确认规则在 15%—18% 之间选择一个具体值；其余进入律师池，不能自动取区间中点。
- 新版规则标记 `calculationBase: "GROSS"`；旧规则定义与旧计算批次保持可读，但不得静默转成新版。
- 金额、百分比和尾差均用 Decimal；一笔付款的总额只出现一次，角色人员明细之和必须等于律师池。
- 既有 `CommissionPlan` 和确认收款时已生成的 `FeeEntry.COMMISSION` 不被财务域改写。若新分配与历史提成快照不一致，预览给阻断项。
- 财务界面按本仓库中文文案与墨案 UI 约定；权限复用 `finance.read`、`finance.rules`、`finance.export` 等显式授权。
- 本地只用 `synthetic-*` 合成数据；不提交客户、银行、工资、凭据、来源文件，也不执行生产迁移、推送或部署。

---

## 文件结构与责任

| 文件 | 责任 |
| --- | --- |
| `src/lib/finance/internal-rules.ts` | 新版总额和角色池纯计算；保留旧函数供历史显示 |
| `src/lib/finance/internal-types.ts` | 分配版本、角色和预览 DTO |
| `src/server/finance/internal-rules.ts` | 案件角色分配、规则发布验证与审计 |
| `src/server/finance/internal-allocation.ts` | 读取收款及历史提成快照、生成预览与提交批次 |
| `src/server/finance/materialization.ts` | 统一来源指纹；取消不经过分配验证的直接正式批次 |
| `src/server/finance/internal-reports.ts` | 付款总额按主行汇总，人员所得按角色明细汇总 |
| `src/server/finance/internal-workspaces.ts` | 工作区查询与预览/正式状态 |
| `src/app/(app)/finance/internal/_components/rules-workspace.tsx` | 展示比例基数、生效期和规则草稿 |
| `src/app/(app)/finance/internal/_components/ledger-workspace.tsx` | 展示每人角色所得和批次依据 |
| `src/app/(app)/finance/internal/_components/monthly-close-workspace.tsx` | 将旧“直接生成正式批次”操作改为预览、复核、提交 |
| `src/app/api/finance/internal/materialize/route.ts` | 兼容旧入口，但只返回预览，不再直接提交 |
| `prisma/schema.prisma`、`prisma/migrations/20260923000001_finance_allocation_recipients/migration.sql` | 角色明细关系与案件角色配置的增量迁移 |
| `src/tests/lib/finance-internal-rules.test.ts`、`src/tests/server/finance-internal-allocation.test.ts`、`src/tests/server/finance-monthly-close.test.ts`、`src/tests/server/finance-internal-reports.test.ts`、`src/tests/app/finance-internal-workspaces.test.tsx` | 对应行为回归 |

### Task 1: 明确总额百分比与版本化规则

**Files:** Modify `src/lib/finance/internal-rules.ts`, `src/lib/finance/internal-types.ts`, `src/server/finance/internal-rules.ts`, `src/app/(app)/finance/internal/_components/rules-workspace.tsx`; Test `src/tests/lib/finance-internal-rules.test.ts`, `src/tests/server/finance-internal-rules.test.ts`.

**Interfaces:**

```ts
import type { Prisma } from "@prisma/client";
type FinanceRole = "SOURCE" | "HANDLING" | "CO";
type LawFirmRuleV2 = {
  calculationBase: "GROSS";
  channelRate: string;
  firmRate: string;
  roleRates: Record<FinanceRole, string>;
};
declare function calculateLawFirmAllocation(gross: string, rule: LawFirmRuleV2): {
  channel: Prisma.Decimal; firm: Prisma.Decimal; lawyerPool: Prisma.Decimal;
  roles: Record<FinanceRole, Prisma.Decimal>;
};
```

- [ ] **Step 1: 写失败测试。** 用 `100000.00` 断言渠道 `20000.00`、律所 `45000.00`、律师池 `35000.00`；角色比例 `0.20/0.50/0.30` 应得到 `7000.00/17500.00/10500.00`。另测合伙人自拓 `firmRate=0.10` 得律师池 `90000.00`，独立律师 `0.18` 得 `82000.00`；比例超 1、角色合计不为 1、负金额均拒绝。
- [ ] **Step 2: 运行失败测试。** `npm run test:run -- src/tests/lib/finance-internal-rules.test.ts src/tests/server/finance-internal-rules.test.ts`；预期新函数或新版规则校验失败，旧用例仍通过。
- [ ] **Step 3: 实现新版纯函数与校验。** 渠道 `round(gross × channelRate)`、律所 `round(gross × firmRate)`、律师池 `gross − channel − firm`；角色金额依次取整，最后一项吸收分币尾差。发布时要求 `calculationBase="GROSS"`、`0≤channelRate+firmRate≤1`、非零律师池的角色比例之和恰为 `1`。保留旧版规则的读取路径，并在 UI 明示“收款总额为基数”。初始规则只填草稿，不运行 seed 自动发布。
- [ ] **Step 4: 运行聚焦测试并提交。** 同 Step 2 命令预期 PASS；`git add` 上述文件，`git commit -m "feat: define gross-based law firm allocation rules"`。

### Task 2: 将一笔付款拆为总额行和多个人员角色明细

**Files:** Modify `prisma/schema.prisma`, `src/lib/finance/internal-rules.ts`, `src/server/finance/internal-rules.ts`, `src/server/finance/internal-allocation.ts`; Create `prisma/migrations/20260923000001_finance_allocation_recipients/migration.sql`; Test `src/tests/server/finance-internal-allocation.test.ts`, `src/tests/server/finance-internal-rules.test.ts`.

**Interfaces:**

```ts
type RoleAssignment = { role: "SOURCE" | "HANDLING" | "CO"; userId: string; shareRate: string };
type AllocationRecipient = { paymentId: string; userId: string; role: RoleAssignment["role"]; amount: string };
type AllocationPreviewV2 = { runId: string; sourceHash: string; blockingIssues: string[]; lines: AllocationPreviewLine[]; recipients: AllocationRecipient[] };
```

- [ ] **Step 1: 写失败测试。** 一笔 `100000.00` 渠道款，甲取得案源 `7000.00` 加承办 `12250.00`，乙取得承办 `5250.00` 加协办 `10500.00`；人员合计 `19250.00/15750.00`，总额行仍只有一条。为两人配置已确认提成快照 `19.25%/15.75%`，预览无阻断；将甲快照改为 `20%` 后出现“不一致”阻断。重复角色/人员、无效人员、角色比例缺口均阻断。
- [ ] **Step 2: 运行失败测试。** `npm run test:run -- src/tests/server/finance-internal-allocation.test.ts`；预期多人受益和快照核对断言失败。
- [ ] **Step 3: 加增量模型。** `FinanceMatterProfile` 增 `roleAssignments Json @default("[]")`；`FinanceAllocationLine` 仍是一笔收款或一笔退款各一条总额行，新增 `sourceKind`（`PAYMENT|REFUND`，旧行默认 `PAYMENT`）、`refundLinkId?`、`sourceOccurredAt DateTime?`（旧行可空，新版写入必填）和反向关系 `recipients FinanceAllocationRecipient[]`；新表含 `allocationLineId`、`userId`、`role`、`shareRate Decimal(8,6)`、`amount Decimal(14,2)`、`createdAt`，对 `(allocationLineId,userId,role)` 唯一。先用独立测试库演练迁移、检查 SQL 只新增列/表/索引，不删除旧行；`npm run prisma:validate` 和 `npm run prisma:generate` 通过。
- [ ] **Step 4: 实现人员分配与旧账核对。** 角色内 `shareRate` 合计须为 1；按稳定人员 ID 顺序分配尾差。对每个 `Payment.feeEntryId` 读取其子 `FeeEntry` 中已确认的 `type=COMMISSION` 快照，以 `beneficiaryUserId` 汇总；与本次每人金额比较，允许 0.01 元的舍入差且该差必须有明确尾差归属，其他差额阻断。当前 `CommissionPlan` 仅作为将来确认收款的配置及来源指纹输入，不能覆盖历史子账快照。
- [ ] **Step 5: 测试并提交。** `npm run test:run -- src/tests/server/finance-internal-allocation.test.ts src/tests/server/finance-internal-rules.test.ts` 预期 PASS；`npm run prisma:validate` 预期 PASS；提交上述文件，消息 `feat: persist multi-lawyer allocation recipients`。

### Task 3: 统一来源指纹、预览、提交和旧批次门禁

**Files:** Modify `src/server/finance/internal-allocation.ts`, `src/server/finance/materialization.ts`, `src/server/finance/monthly-close.ts`, `src/app/api/finance/internal/materialize/route.ts`; Test `src/tests/server/finance-internal-allocation.test.ts`, `src/tests/server/finance-monthly-close.test.ts`.

**Interfaces:** `sourceFingerprintForPeriod(period)` 为完整账期返回 SHA-256；`previewInternalAllocation({periodStart,periodEnd})` 返回带 `allocationVersion: 2` 的 `PREVIEW`；`commitInternalAllocation(runId)` 只将复核通过且指纹未变的预览变为 `COMMITTED`。

- [ ] **Step 1: 写失败测试。** 账期有已确认付款时，`materializeFinancePeriod` 不能生成没有 `FinanceAllocationLine` 的 `COMMITTED`；改变角色分配、子提成快照、退款、对账决策或已发布规则后，旧预览提交失败；旧批次没有 `allocationVersion:2` 时月结 `ready=false`。八月确认收款、九月退款的例子中，八月正向行保持原额，九月出现链接原付款的负向退款行；累计退款不得大于原付款。
- [ ] **Step 2: 运行失败测试。** `npm run test:run -- src/tests/server/finance-internal-allocation.test.ts src/tests/server/finance-monthly-close.test.ts`；预期空正式批次或旧批次门禁测试失败。
- [ ] **Step 3: 收敛批次路径。** `sourceFingerprintForPeriod` 以固定排序覆盖本期已确认付款、其子提成快照、本期银行退款及原付款分配快照、已确认对账决定、规则版本、案件画像及角色分配、已归档银行来源；个人账影响项仍在完整账期哈希里。哈希输入显式加入计算引擎版本 `allocation-v2`，后续个人快照上线时提升版本，避免仅代码变化却复用旧结果。每笔退款用 `FinanceRefundLink.sourceRow.occurredAt` 决定归属月份，按原付款分配快照的金额比例生成负向行和负向人员明细，尾差稳定归属；跨月退款不得改写原月正式批次。退款造成与案件子账的提成差异应列出待处理项，由既有财务更正或人工复核关闭。`/materialize` 兼容入口只调用预览，不再直接将空批次写为 `COMMITTED`。正式提交重新采集完整事实并比较指纹、阻断项与总额/角色明细数量；`summary` 存 `allocationVersion:2`、付款数、退款数、总额行数、人员行数和阻断数。重复预览同一指纹应复用或明确返回已有预览，不触发唯一键异常。
- [ ] **Step 4: 禁用旧口径月结。** 月结只接受当前账期、最新来源指纹、`allocationVersion=2` 且付款数加退款数与总额行数相等的 `COMMITTED` 批次；旧批次保留只读并显示“旧口径待复核”。零付款账期允许在明确的来源覆盖与零交易确认后形成零金额批次，不能凭空视为完整。
- [ ] **Step 5: 测试并提交。** 同 Step 2 命令预期 PASS；提交上述文件，消息 `fix: require validated allocation snapshots for monthly close`。

### Task 4: 提供案件配置、分配预览和三视角正确展示

**Files:** Modify `src/app/(app)/finance/internal/_components/rules-workspace.tsx`, `src/app/(app)/finance/internal/_components/ledger-workspace.tsx`, `src/app/(app)/finance/internal/_components/monthly-close-workspace.tsx`, `src/app/(app)/finance/internal/_components/types.ts`, `src/server/finance/internal-workspaces.ts`, `src/server/finance/internal-reports.ts`, `src/app/(app)/finance/internal/rules/page.tsx`; Test `src/tests/app/finance-internal-workspaces.test.tsx`, `src/tests/server/finance-internal-reports.test.ts`.

**Interfaces:** 配置页调用现有 `/api/finance/internal/rules` 的案件画像写入口；预览用 `/api/finance/internal/allocation/preview`，提交用 `/api/finance/internal/allocation/commit`；人员报表从 `FinanceAllocationRecipient` 汇总，项目/律所收入从 `FinanceAllocationLine` 汇总。

- [ ] **Step 1: 写失败测试。** 财务权限用户可找到“案件来源与人员分配”“预览本期分配”“确认正式分配”入口；无 `finance.rules` 权限者无写按钮。一个付款、两名律师的人员视角分别显示 `19250.00/15750.00`，项目和律所总收入只显示 `100000.00` 一次；阻断项未清时提交按钮禁用。
- [ ] **Step 2: 运行失败测试。** `npm run test:run -- src/tests/app/finance-internal-workspaces.test.tsx src/tests/server/finance-internal-reports.test.ts`；预期入口或多人汇总断言失败。
- [ ] **Step 3: 实现用户路径。** 案件选择使用现有案件搜索与可见性规则，不要求用户输入内部 ID；按案件来源、渠道、自拓身份、规则集、角色/人员/比例编辑。规则页显示“比例基数：本笔净律师费收款总额”和明确计算预览；月结工作区先预览并展示阻断项，再由有权人员确认提交。报表对旧批次展示版本标签，不把旧金额混入新版汇总；导出使用与页面相同的批次 ID。
- [ ] **Step 4: 测试与阶段验收。** 同 Step 2 命令预期 PASS；再运行 `npm run lint`、`npm run typecheck`、`npm run prisma:validate`、`npm run build`，均预期退出码 0。用固定合成账期人工核对 `渠道 + 律所 + 甲 + 乙 = 净收款`、旧收款子账不被修改。提交上述文件，消息 `feat: add law firm allocation workflow and views`。

## 本计划完成判定

- 一笔付款无论几位受益人，项目收入只计一次；人员所得之和严格等于律师池。
- 现有提成子账与新分配不一致、来源变化、规则未发布、缺角色/人员、旧批次或空批次均不能成为新口径正式月结基础。
- 原始 `Payment`、`FeeEntry`、旧计算批次保持原样；新迁移经过独立测试库演练。
- 下一阶段按 `2026-09-23-law-firm-finance-personal.md` 继续；最后按 `2026-09-23-law-firm-finance-close.md` 完成资料与月结。
