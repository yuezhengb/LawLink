# 律所资料导入与月结交付 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让银行流水、工资表、花名册和外部三表各按自身结构归档与核对；在来源、分配和个人/律所结果完整时生成内容真实、相互一致的月结交付包。

**Architecture:** 复用现有私有文件归档、哈希去重与银行对账链。银行行继续写 `FinanceSourceRow`；非银行资料进入类型化记录与人工映射流程，不产生伪银行流水或待认领付款。月结检查来源覆盖、当前批次、分配/工资/期初和调整；四类工作簿分别从同一个正式快照构建，ZIP 包含各自实际字节。

**Tech Stack:** Next.js 16、TypeScript、Prisma 5、PostgreSQL 16、ExcelJS、PizZip、Zod、Vitest、现有私有存储和审计服务。

## Global Constraints

- 依赖 `2026-09-23-law-firm-finance-core.md` 与 `2026-09-23-law-firm-finance-personal.md`；月结只接受当前来源指纹、`allocationVersion=2` 且个人/律所快照齐全的正式批次。
- 银行流水导入仍要求日期、金额和方向；工资、花名册与外部三表不要求银行字段，不进入 `FinanceReconciliationCase`。
- 任何来源文件保持私有；预览按权限脱敏；人员匹配冲突须人工处理；外部三表只用于核对，不自动生成法定会计凭证或报税结果。
- 原始资料、客户接单表、银行卡号、工资、合同号不得进入 Git、合成夹具、普通日志或公开下载链接。
- `.xls` 明确拒绝并要求本地转换为 `.xlsx`；本计划不新增未审过许可证与安全性的表格解析依赖。
- 月结交付要求 `finance.export`，原文件下载要求财务读取权限并写严格审计；查看页面权限不自动包含导出权限。
- 只在独立测试库演练迁移，合成数据验收后再由用户和外部财务老师选择脱敏账期复核；生产导入和部署另行安排。

---

## 文件结构与责任

| 文件 | 责任 |
| --- | --- |
| `src/lib/finance/import-parser.ts` | 银行专用解析入口与类型分流 |
| `src/lib/finance/payroll-parser.ts` | 工资表字段映射及数值校验 |
| `src/lib/finance/roster-parser.ts` | 花名册人员标识与重复/歧义提示 |
| `src/lib/finance/external-statements-parser.ts` | 外部三表期间、表名、项目及金额核对行 |
| `src/lib/finance/internal-types.ts` | 按资料类型区分的预览 DTO 与错误代码 |
| `src/server/finance/internal-imports.ts` | 类型化归档、文件去重、非银行记录保存、人工确认 |
| `src/server/finance/internal-source-coverage.ts` | 账期银行账户/资料覆盖确认和差异提示 |
| `src/server/finance/monthly-close.ts` | 阻断条件、月结版本、独立文件生成 |
| `src/server/finance/internal-export.ts` | 四类独立工作簿构建器 |
| `src/server/finance/internal-reports.ts` | 合同/案值、已开票净额、已确认收款的项目核对视角 |
| `src/app/(app)/finance/internal/_components/import-workspace.tsx` | 按类型显示列映射、脱敏预览和处理状态 |
| `src/app/(app)/finance/internal/_components/monthly-close-workspace.tsx` | 来源覆盖与阻断项处理入口 |
| `src/app/api/finance/internal/imports/preview/route.ts`、`commit/route.ts` | 保持既有 API，响应升级为类型化预览 |
| `src/app/api/finance/internal/coverage/route.ts` | 账期来源覆盖确认 |
| `src/app/api/finance/internal/monthly-close/route.ts`、`artifacts/[id]/route.ts` | 版本化月结和受保护下载 |
| `prisma/schema.prisma`、`prisma/migrations/20260923000003_finance_source_close/migration.sql` | 非银行记录、覆盖确认、月结版本及交付唯一性 |
| `src/tests/lib/finance-import-parser.test.ts`、`finance-payroll-parser.test.ts`、`finance-roster-parser.test.ts`、`finance-external-statements-parser.test.ts` | 解析测试 |
| `src/tests/server/finance-internal-imports.test.ts`、`finance-monthly-close.test.ts`、`finance-operating-acceptance.test.ts`、`src/tests/app/finance-internal-workspaces.test.tsx` | 归档、月结和权限验收 |

### Task 1: 按资料类型解析，阻止伪银行行

**Files:** Modify `src/lib/finance/import-parser.ts`, `src/lib/finance/internal-types.ts`; Create `src/lib/finance/payroll-parser.ts`, `src/lib/finance/roster-parser.ts`, `src/lib/finance/external-statements-parser.ts`; Test `src/tests/lib/finance-import-parser.test.ts`, `src/tests/lib/finance-payroll-parser.test.ts`, `src/tests/lib/finance-roster-parser.test.ts`, `src/tests/lib/finance-external-statements-parser.test.ts`.

**Interfaces:**

```ts
type PayrollImportRow = {
  sourceRowNumber: number; period: string; displayName: string;
  declaredSalary: string; actualCashPaid: string; selfCostDue: string;
};
type RosterImportRow = {
  sourceRowNumber: number; asOfDay: string; displayName: string; roleLabel: string;
};
type ExternalStatementRow = {
  sourceRowNumber: number; period: string;
  statement: "BALANCE_SHEET" | "INCOME" | "CASH_FLOW";
  item: string; amount: string;
};
type ParsedFinanceSource =
  | { kind: "BANK_STATEMENT"; rows: FinanceNormalizedRow[]; errors: FinanceRowError[] }
  | { kind: "PAYROLL"; period: string; rows: PayrollImportRow[]; errors: FinanceRowError[] }
  | { kind: "ROSTER"; period: string; rows: RosterImportRow[]; errors: FinanceRowError[] }
  | { kind: "EXTERNAL_THREE_STATEMENTS"; period: string; rows: ExternalStatementRow[]; errors: FinanceRowError[] }
  | { kind: "OTHER"; rows: []; errors: FinanceRowError[] };
function parseFinanceSource(bytes: Buffer, fileName: string, kind: FinanceSourceKind): Promise<ParsedFinanceSource>;
```

- [ ] **Step 1: 写失败测试。** 合成花名册仅有“姓名、身份、在册期间”，预览应有 1 条人员行且无 `MISSING_OCCURRED_AT/MISSING_AMOUNT`；合成工资表有“月份、姓名、申报工资、实际支付、自担社保”，金额两位小数；合成外部三表有“期间、表名、项目、期末金额”，不得转成收款行；银行缺日期/金额仍失败；旧 `.xls` 明确提示转换。
- [ ] **Step 2: 运行失败测试。** `npm run test:run -- src/tests/lib/finance-import-parser.test.ts src/tests/lib/finance-payroll-parser.test.ts src/tests/lib/finance-roster-parser.test.ts src/tests/lib/finance-external-statements-parser.test.ts`；预期后三类解析失败。
- [ ] **Step 3: 实现专用映射。** ExcelJS 仅解析 CSV/XLSX；工资和外部三表读取表内期间，缺期间时由上传表单显式输入；花名册由表单指定“截至日期”。表内期间与上传选择不一致时阻断。各解析器按列别名读取、校验行号与错误。工资输出内部用户匹配所需的短暂显示名、金额和字段映射；花名册输出人员匹配候选，不直接修改 `User`；外部三表输出报表类型、项目、期间和 Decimal 金额，缺三表之一给复核提示。预览只输出必要字段，身份证/银行卡号不进入 DTO。
- [ ] **Step 4: 测试并提交。** 同 Step 2 命令预期 PASS；提交上述文件，消息 `feat: parse finance sources by document type`。

### Task 2: 归档非银行记录并人工确认关联

**Files:** Modify `prisma/schema.prisma`, `src/server/finance/internal-imports.ts`, `src/app/(app)/finance/internal/_components/import-workspace.tsx`, `src/app/api/finance/internal/imports/preview/route.ts`, `src/app/api/finance/internal/imports/commit/route.ts`; Create `prisma/migrations/20260923000003_finance_source_close/migration.sql`; Test `src/tests/server/finance-internal-imports.test.ts`, `src/tests/app/finance-internal-workspaces.test.tsx`.

**Interfaces:** `FinanceImportRecord` 保存 `batchId`、`sourceRow`、`kind`、`period`、`normalizedDigest`、`resolvedUserId?`、非敏感标准化金额字段、`reviewStatus`；原始姓名只留在受保护文件中。`commitFinanceImport` 仍返回 `{batchId,duplicate}`。

- [ ] **Step 1: 写失败测试。** 工资表导入产生 `FinanceImportRecord`，不产生 `FinanceSourceRow` 或 `FinanceReconciliationCase`；同文件+类型再次提交幂等。花名册两位同名人员时状态为“待人工关联”，不得按首个姓名自动写入用户 ID。工资记录经财务确认后才调用 `savePayrollFact`；重复确认不重复入账。外部三表仅生成核对记录，不改案件收入。
- [ ] **Step 2: 运行失败测试。** `npm run test:run -- src/tests/server/finance-internal-imports.test.ts src/tests/app/finance-internal-workspaces.test.tsx`；预期非银行资料仍走银行流水路径而失败。
- [ ] **Step 3: 实现存储分流与人工确认。** 银行走原 `FinanceSourceRow` 与对账队列；非银行走新 `FinanceImportRecord`。所有资料的私有原文件、文件哈希、批次审计继续复用。批次 `periodStart/End` 由资料自身账期生成，不能假装交易日期；人员匹配使用内部 `User.id` 人工确认，同名/停用用户阻断自动激活。导入提交只归档，业务事实入账需要第二步有权限确认；确认前不参与计算批次。
- [ ] **Step 4: 测试并提交。** 同 Step 2 命令预期 PASS；`npm run prisma:validate` 预期 PASS；提交上述文件，消息 `feat: archive typed non-bank finance records`。

### Task 3: 建立来源覆盖确认与真实月结阻断项

**Files:** Modify `prisma/schema.prisma`, `prisma/migrations/20260923000003_finance_source_close/migration.sql`, `src/server/finance/monthly-close.ts`, `src/server/finance/materialization.ts`, `src/app/(app)/finance/internal/_components/monthly-close-workspace.tsx`; Create `src/server/finance/internal-source-coverage.ts`, `src/app/api/finance/internal/coverage/route.ts`; Test `src/tests/server/finance-monthly-close.test.ts`, `src/tests/app/finance-internal-workspaces.test.tsx`.

**Interfaces:** `FinancePeriodCoverage` 保存 `period`、本所自定义银行账户别名及对应已覆盖批次 ID、工资/花名册/外部表到位状态、无资料原因、复核人/时间；账户别名不是完整银行账号。`MonthlyCloseStatus` 继续返回 `blockingWarnings`、`reviewWarnings`、`ready`，并增加 `staleRun` 与来源覆盖摘要。

- [ ] **Step 1: 写失败测试。** 有一份银行文件但预期两个账户时不能月结；缺覆盖确认、待认领、分配错误、工资事实缺失、首月期初缺失、个人/律所快照缺失、旧版/过期批次均使 `ready=false`。确实无律师费收款且财务明确确认零来源的月份可以月结；外部三表尚未收到时有原因的复核提示，不伪造三表。
- [ ] **Step 2: 运行失败测试。** `npm run test:run -- src/tests/server/finance-monthly-close.test.ts src/tests/app/finance-internal-workspaces.test.tsx`；预期仅靠“无待认领+存在批次”就放行的旧行为失败。
- [ ] **Step 3: 实现覆盖模型和闸门。** 财务用户显式登记本所账户别名与对应私有批次，服务端核对批次种类、期间和去重哈希；不能用来源文件总数替代账户覆盖。`getMonthlyCloseStatus` 重新计算来源哈希并与批次比对，检查 `allocationVersion=2`、付款加退款与总额行数量守恒；待认领收入、分配错误、缺工资人数须从当前来源事实实际计数，不能在 `run.summary` 缺字段时默认为 0。还要检查首月期初和个人/律所快照存在，以及有效调整无未解决差异。外部三表与内部收入/成本差额列复核提示，不能自动把差额消掉。保存覆盖确认、原因和操作者审计。
- [ ] **Step 4: 测试并提交。** 同 Step 2 命令预期 PASS；`npm run prisma:validate` 预期 PASS；提交上述文件，消息 `fix: enforce finance source coverage before monthly close`。

### Task 4: 生成四份不同内容的工作簿和可追溯 ZIP

**Files:** Modify `src/server/finance/internal-export.ts`, `src/server/finance/monthly-close.ts`, `src/app/api/finance/internal/artifacts/[id]/route.ts`, `prisma/schema.prisma`, `prisma/migrations/20260923000003_finance_source_close/migration.sql`; Test `src/tests/server/finance-monthly-close.test.ts`, `src/tests/server/finance-internal-reports.test.ts`.

**Interfaces:**

```ts
type CloseWorkbookKind = "WAGE" | "ACCOUNTANT" | "PERSONAL" | "ADJUSTMENT_AUDIT";
function buildCloseWorkbook(kind: CloseWorkbookKind, runId: string, dependencies: FinanceReportsDependencies): Promise<Buffer>;
function buildCloseZip(period: string, runId: string, files: Record<CloseWorkbookKind, Buffer>): Buffer;
```

- [ ] **Step 1: 写失败测试。** 四份 XLSX 的页签分别覆盖工资申报/实际支付、会计核对、个人双余额、调整与冲销；各文件首行有同一 `runId/sourceHash/期间`。四份文件字节摘要不相同；ZIP 解包后恰有四份工作簿加一份说明，内部字节与独立下载一致；无 `finance.export` 权限不能生成或下载。重复生成同一版本只返回已有四类+ZIP 五个工件。
- [ ] **Step 2: 运行失败测试。** `npm run test:run -- src/tests/server/finance-monthly-close.test.ts src/tests/server/finance-internal-reports.test.ts`；预期同一工作簿换文件名、ZIP 只有一份工作簿而失败。
- [ ] **Step 3: 实现工作簿和月结版本。** 四个构建器只读传入 `runId` 的正式快照及关联事实，统一写 `runId/sourceHash/期间` 元数据。工资簿显示申报与实付，个人簿显示期初、分成、自担、预存和期末，调整簿显示追加/冲销对。会计资料是核对包，不写法定三表标题。ZIP 使用这四份实际字节。将 `FinanceMonthlyClose.period @unique` 改为 `(period,revision)` 唯一，所有按期间 `findUnique` 的读写改为“按版本降序取最新”，并确保历史工件仍指向其原月结行；来源变更后生成新版本，不覆盖旧 `FinanceArtifact`；`(runId,kind)` 唯一。生成与下载都要求 `finance.export`，保留严格审计。
- [ ] **Step 4: 测试并提交。** 同 Step 2 命令预期 PASS；检查 ZIP 解包文件摘要和受保护下载；`npm run prisma:validate` 预期 PASS；提交上述文件，消息 `feat: create versioned finance close artifacts`。

### Task 5: 合成端到端验收及资料启用闸门

**Files:** Modify `src/server/finance/internal-reports.ts`, `src/server/finance/internal-export.ts`, `src/tests/server/finance-operating-acceptance.test.ts`, `src/tests/app/finance-internal-workspaces.test.tsx`, `docs/FINANCE-OPERATING-LOOP.md`; Test `src/tests/server/finance-operating-acceptance.test.ts`.

**Interfaces:** 固定合成账期覆盖渠道、自拓、多律师、退款、工资/视同工资、预存、合伙人税款、资本、房租、外部三表差异和月结版本。

- [ ] **Step 1: 写真实链路合成测试。** 不把 `buildFinanceWorkbook` 整体 mock 成同一字节；调用真实解析/分配/快照/工作簿构建器。断言待确认收款和代收款被排除、退款后比例守恒、多人份额与原提成快照一致、个人成本不重复扣、资本不入损益、同一 `sourceHash` 贯穿四份文件；来源变化后旧包只读、新包产生新版本。项目核对还需从 LawLink 的 `Billing.contractAmount`、`Matter.claimAmount`、已开具发票净额和已确认付款读取各自数值，不能把案值当合同收费额，也不能把开票当收款。权限反向测试覆盖来源文件和交付文件下载。
- [ ] **Step 2: 运行失败测试。** `npm run test:run -- src/tests/server/finance-operating-acceptance.test.ts`；预期旧 mock 式验收无法证明真实工作簿内容而失败。
- [ ] **Step 3: 完成验收说明。** 更新操作文档中的各类资料必需列、预览与人工确认、金额基数、期初确认、工资申报与实付区别、月结阻断项、五个交付文件内容。项目核对表说明“案值、合同收费、已开票、已收款”各自来源；微信客户接单表要另取受控 CSV/XLSX 导出后按合同号/客户/对方与 LawLink 做只读差异匹配，本阶段不直接接管其原始数据。真实资料启用清单需包含受限制入口与 HTTPS、独立库迁移回滚演练、一个脱敏账期的本所财务复核及外部财务老师对内外账差异的书面确认；未完成这些条件时只可用合成资料演示。
- [ ] **Step 4: 验证并提交。** `npm run test:run`、`npm run lint`、`npm run typecheck`、`npm run prisma:validate`、`npm run build` 均预期退出码 0；`git diff --check` 无空白错误；检查 `git status --short` 无来源文件、导出包或数据库转储。提交上述文件，消息 `test: verify law firm finance close end to end`。

## 本计划完成判定

- 银行、工资、花名册、外部三表分别走正确的解析与归档路径，非银行资料不再制造伪对账待办。
- 任何来源/人员/规则/工资缺口会清楚显示阻断原因，不能从空批次或过期批次生成正式包。
- 五份交付工件内容、文件摘要和批次引用可核对；历史月结版本可回看，下载有权限与审计。
- 真实资料启用仍以本所财务与外部财务老师复核通过为最后的业务验收。
