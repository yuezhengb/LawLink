# 律所经营财务闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 LawLink 既有案件财务事实之上，分阶段交付一套可追溯的律所经营财务闭环：资料归档、银行对账、待认领、分成、个人双余额、投资人经营核算和月结交付。

**Architecture:** LawLink 的 `Matter`、`Billing`、`Receivable`、已确认 `Payment`、`FeeEntry`、`CommissionPlan` 继续作为业务事实来源；新增财务域保存来源证据、对账案例、版本化规则、不可变计算批次、个人追加式台账和月结文件。报表与导出只读取服务端持久化计算结果，不在页面临时重算，不复制 101 VPS 的源代码或业务数据。

**Tech Stack:** Next.js 16 App Router、TypeScript、React 19、Prisma 5、PostgreSQL 16、Zod、Decimal、ExcelJS（读取 CSV/XLSX 并生成工作簿）、Vitest、现有私有存储和审计服务。传统 XLS 暂不在服务端解析，上传时提示转换为 XLSX，避免引入当前存在高危漏洞且无修复版本的 SheetJS 依赖。

## Global Constraints

- LawLink 继续作为客户、案件、合同、案件应收和已确认案件收款的事实来源。
- 只有已确认的 LawLink `Payment` 且 `moneyKind = LAWYER_FEE` 才能进入收款勾稽、分配和个人结算。
- 阶段 1、2 不输出法定三表；外部三表仅作为核对资料和差异来源。
- 不做自动报税、自动工资/社保付款、银行开放接口或对外付款。
- 规则一旦被计算批次使用，不允许原地修改；历史计算必须保留规则版本和来源哈希。
- 个人可分配收入余额与自担成本预存余额必须分开；投资人资本、收入提取和个人税款不重复计入律所经营结果。
- 原始文件进入现有私有存储，数据库只保存必要的标准化字段和来源摘要；日志不得输出完整身份证号、电话、银行卡号或客户敏感文本。
- 任何更正使用追加记录或反向冲销，禁止物理删除已参与导入、匹配或计算的来源数据。
- 真实客户接单表、银行流水、工资表、花名册和外部账表不得进入 Git、测试夹具、日志或公开下载地址；测试只使用合成/脱敏数据。
- 101 VPS 上的 `admin.sofos.cc` 只作为业务和交互参考；不从其生产数据库读取数据，不在其运行容器上开发 LawLink。
- 现有 `next-env.d.ts` 的未提交修改属于用户既有改动；所有任务不得覆盖、格式化或提交该文件。
- 页面文案使用中文；不引入 Ant Design；核心金额算法只能存在于 `src/lib/finance` 或 `src/server/finance`，页面不得复制金额计算。
- 每个任务完成后运行该任务的聚焦测试；阶段完成后运行 `npm run lint`、`npm run typecheck`、`npm run prisma:validate` 和 `npm run build`。

---

## 文件结构与职责

### 新增文件

- `prisma/migrations/20260922000001_finance_operating_loop/migration.sql`：财务经营闭环增量迁移。
- `src/lib/finance/internal-types.ts`：来源行、匹配、分配、个人台账、月结和导出共享类型。
- `src/lib/finance/import-parser.ts`：CSV/XLS/XLSX 读取、列识别和标准化；无数据库依赖。
- `src/lib/finance/source-fingerprint.ts`：稳定值序列化和来源文件/行指纹。
- `src/lib/finance/internal-rules.ts`：规则 schema、金额分配、守恒和版本输入；无数据库依赖。
- `src/lib/finance/internal-matching.ts`：银行来源行与已确认 `Payment` 的确定性候选排序；无数据库依赖。
- `src/lib/finance/internal-accounting.ts`：个人双余额、成本覆盖、税款和投资人经营结果的纯函数。
- `src/server/finance/internal-schemas.ts`：所有财务域输入的 Zod schema。
- `src/server/finance/internal-imports.ts`：批次预览、私有文件写入、标准化行保存和重复导入处理。
- `src/server/finance/internal-reconciliation.ts`：候选查询、确认/忽略/疑点、退款关联和认领决策。
- `src/server/finance/internal-rules.ts`：案件来源档案、规则草稿/发布和生效区间校验。
- `src/server/finance/internal-allocation.ts`：从已确认 `Payment` 生成不可变分配批次。
- `src/server/finance/internal-accounting-actions.ts`：个人内账、工资、税款、资本流的服务端写入和查询。
- `src/server/finance/materialization.ts`：按账期生成、读取和替代 `FinanceCalculationRun`。
- `src/server/finance/monthly-close.ts`：月结状态、阻断项、人工调整/冲销和月度交付文件。
- `src/server/finance/internal-reports.ts`：人员、项目、律所三视角查询。
- `src/server/finance/internal-export.ts`：ExcelJS 月结包、透视表和审计表生成。
- `src/app/api/finance/internal/imports/preview/route.ts`：导入预览 API。
- `src/app/api/finance/internal/imports/commit/route.ts`：导入提交 API。
- `src/app/api/finance/internal/imports/[id]/source/route.ts`：受保护原文件下载 API。
- `src/app/api/finance/internal/reconciliation/route.ts`：待匹配队列和候选 API。
- `src/app/api/finance/internal/reconciliation/[id]/decision/route.ts`：认领、忽略和疑点决策 API。
- `src/app/api/finance/internal/reconciliation/export/route.ts`：待认领 Excel 导出 API。
- `src/app/api/finance/internal/reconciliation/import/route.ts`：人工认领结果 Excel 导入 API。
- `src/app/api/finance/internal/rules/route.ts`：规则草稿和案件来源档案 API。
- `src/app/api/finance/internal/rules/[id]/publish/route.ts`：规则版本发布 API。
- `src/app/api/finance/internal/allocation/preview/route.ts`：分配预览 API。
- `src/app/api/finance/internal/allocation/commit/route.ts`：分配快照提交 API。
- `src/app/api/finance/internal/materialize/route.ts`：账期计算批次 API。
- `src/app/api/finance/internal/monthly-close/route.ts`：月结状态和月结生成 API。
- `src/app/api/finance/internal/adjustments/route.ts`：追加调整和调整查询 API。
- `src/app/api/finance/internal/adjustments/[id]/reverse/route.ts`：反向冲销 API。
- `src/app/api/finance/internal/artifacts/[id]/route.ts`：受保护月结文件下载 API。
- `src/app/api/finance/internal/accounting/route.ts`：个人双余额查询 API。
- `src/app/api/finance/internal/payroll/route.ts`：工资事实 API。
- `src/app/api/finance/internal/tax/route.ts`：合伙人税款事实 API。
- `src/app/api/finance/internal/capital/route.ts`：投资人资本流 API。
- `src/app/api/finance/internal/export/route.ts`：受保护财务导出 API。
- `src/app/(app)/finance/internal/page.tsx`：财务经营闭环总入口。
- `src/app/(app)/finance/internal/_components/internal-finance-nav.tsx`：六组财务工作区导航。
- `src/app/(app)/finance/internal/imports/page.tsx`：资料导入工作区。
- `src/app/(app)/finance/internal/reconciliation/page.tsx`：银行对账与待认领工作区。
- `src/app/(app)/finance/internal/ledger/page.tsx`：分成、个人内账和三视角工作区。
- `src/app/(app)/finance/internal/rules/page.tsx`：案件来源档案和规则版本工作区。
- `src/app/(app)/finance/internal/monthly-close/page.tsx`：月结和财务交付工作区。
- `src/app/(app)/finance/internal/_components/import-workspace.tsx`：资料上传、列映射和预览交互组件。
- `src/app/(app)/finance/internal/_components/reconciliation-workspace.tsx`：待认领、候选和决策交互组件。
- `src/app/(app)/finance/internal/_components/ledger-workspace.tsx`：三视角快照和明细交互组件。
- `src/app/(app)/finance/internal/_components/rules-workspace.tsx`：案件来源档案和规则版本交互组件。
- `src/app/(app)/finance/internal/_components/monthly-close-workspace.tsx`：月结阻断项和交付文件交互组件。
- `src/tests/fixtures/finance-synthetic.ts`：不含真实客户信息的固定合成资料。
- `src/tests/lib/finance-synthetic-fixture.test.ts`：合成事实边界测试。
- `src/tests/lib/finance-import-parser.test.ts`：导入解析单测。
- `src/tests/lib/finance-source-fingerprint.test.ts`：来源文件和行指纹单测。
- `src/tests/lib/finance-internal-matching.test.ts`：匹配排序单测。
- `src/tests/lib/finance-internal-rules.test.ts`：分配和守恒单测。
- `src/tests/lib/finance-internal-accounting.test.ts`：双余额、税款和经营结果单测。
- `src/tests/server/finance-internal-imports.test.ts`：批次幂等和失败回滚单测。
- `src/tests/server/finance-internal-reconciliation.test.ts`：对账决策单测。
- `src/tests/server/finance-internal-rules.test.ts`：规则版本和案件来源档案单测。
- `src/tests/server/finance-internal-allocation.test.ts`：计算批次单测。
- `src/tests/server/finance-internal-accounting.test.ts`：个人内账和资本流单测。
- `src/tests/server/finance-internal-reports.test.ts`：三视角汇总和导出单测。
- `src/tests/server/finance-monthly-close.test.ts`：月结阻断项、调整和交付单测。
- `src/tests/app/finance-internal-workspaces.test.tsx`：页面权限、空状态和用户操作测试。
- `src/tests/server/finance-operating-acceptance.test.ts`：合成资料端到端验收测试。
- `docs/FINANCE-OPERATING-LOOP.md`：内部操作说明、字段映射、差异口径和边界。

### 复用与修改文件

- `prisma/schema.prisma`：新增财务域模型和 `User`、`Matter`、`Payment` 等反向关系。
- `package.json` / `package-lock.json`：复用现有 ExcelJS，不新增有已知高危漏洞且无修复版本的 SheetJS 依赖。
- `src/lib/roles/catalog.ts`：增加财务域导入、认领、规则、调整和导出权限；不删除现有 `finance.read/write/confirm/correct/settle`。
- `src/tests/lib/permissions.test.ts`、`src/tests/lib/custom-roles.test.ts`：补充权限不因管理员身份或业务管理权自动放大的断言。
- `src/server/finance/facts.ts`：复用已确认收款和退款事实，不改变现有事实读取口径。
- `src/server/finance/allocation.ts`、`src/server/finance/ledger-*`、`src/lib/finance/ledger.ts`：作为案件子账和 Payment 门禁的事实适配层，不把新财务逻辑散落进去。
- `src/app/(app)/finance/page.tsx`：增加财务经营闭环入口，不改变现有案件财务指标。
- `src/app/(app)/finance/_components/finance-view-v4.tsx`：增加入口卡片或导航链接，保留现有案件收付款工作区。
- `src/app/api/finance/export/route.ts`：不改现有案件财务导出；新闭环使用独立导出路由。

## 阶段 0：底座、权限与合成验收事实

### Task 0: 建立合成资料和财务域边界

**Files:**
- Create: `src/tests/fixtures/finance-synthetic.ts`
- Create: `src/tests/lib/finance-synthetic-fixture.test.ts`
- Create: `src/lib/finance/internal-types.ts`

**Interfaces:**
- Produces `SyntheticFinanceFixture` containing two users, one client, one matter, one confirmed lawyer-fee `Payment`, one pending receipt, one refund, one expense, one payroll record and one capital flow.
- Produces `FinanceSourceKind`, `FinanceNormalizedRow`, `FinanceMatchStatus`, `FinanceCalculationStatus`, `FinancePersonLedgerEntryKind` and shared Decimal-safe DTO types.

- [ ] **Step 1: Write the fixed synthetic fixture test**

```ts
import { describe, expect, it } from "vitest";
import { makeSyntheticFinanceFixture } from "@/tests/fixtures/finance-synthetic";

describe("财务闭环合成事实", () => {
  it("同时覆盖确认收款、待确认收款、退款、工资和资本流", () => {
    const fixture = makeSyntheticFinanceFixture();
    expect(fixture.confirmedPayment.confirmState).toBe("CONFIRMED");
    expect(fixture.pendingReceipt.confirmState).toBe("PENDING");
    expect(fixture.refund.moneyKind).toBe("LAWYER_FEE");
    expect(fixture.capitalFlow.kind).toBe("CAPITAL_IN");
  });
});
```

- [ ] **Step 2: Run the fixture test before implementation**

Run: `npm run test:run -- src/tests/lib/finance-synthetic-fixture.test.ts`
Expected: FAIL because the fixture factory and shared types do not exist.

- [ ] **Step 3: Implement only synthetic values and shared types**

Use IDs such as `synthetic-matter-1`, `synthetic-payment-1` and amounts such as `100000.00`; do not put client names, account numbers, phone numbers or production identifiers in the fixture. Keep amounts as `Prisma.Decimal` in server fixtures or decimal strings in pure-function fixtures.

- [ ] **Step 4: Run the test and inspect for sensitive literals**

Run: `npm run test:run -- src/tests/lib/finance-synthetic-fixture.test.ts`
Expected: PASS. Then run: `rg -n "Sofos@|BEGIN .*PRIVATE KEY|admin\.sofos|\.xlsx|\.pdf" src/tests/fixtures src/tests/lib/finance-synthetic-fixture.test.ts`
Expected: no output.

- [ ] **Step 5: Commit the boundary fixture**

```powershell
git add src/lib/finance/internal-types.ts src/tests/fixtures/finance-synthetic.ts src/tests/lib/finance-synthetic-fixture.test.ts
git commit -m "test: add synthetic finance loop fixture"
```

## 阶段 1：资料归档、标准化与银行对账

### Task 1: 建立财务域 Prisma 模型和权限边界

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260922000001_finance_operating_loop/migration.sql`
- Modify: `src/lib/roles/catalog.ts`
- Modify: `src/tests/lib/permissions.test.ts`
- Modify: `src/tests/lib/custom-roles.test.ts`
- Create: `src/tests/lib/finance-internal-permissions.test.ts`

**Interfaces:**
- Produces models `FinanceImportBatch`, `FinanceSourceFile`, `FinanceSourceRow`, `FinanceReconciliationCase`, `FinanceClaimDecision`, `FinanceRefundLink`, `FinanceMatterProfile`, `FinanceRuleSet`, `FinanceRuleVersion`, `FinanceCalculationRun`, `FinanceAllocationLine`, `FinancePersonLedgerEntry`, `FinancePayrollFact`, `FinancePartnerTaxRecord`, `FinanceCapitalFlow`, `FinanceAdjustment`, `FinanceMonthlyClose` and `FinanceArtifact`.
- Produces permission keys `finance.import`, `finance.reconcile`, `finance.rules`, `finance.adjust` and `finance.export`, each with explicit `ALL` scope; existing `finance.read/write/confirm/correct/settle` remain unchanged.

- [ ] **Step 1: Write permission regression tests**

```ts
import { describe, expect, it } from "vitest";
import { hasCustomPermission, scopeFor } from "@/lib/roles/catalog";

describe("经营财务权限", () => {
  it("自定义律师没有新财务写权限", () => {
    const user = { role: "CUSTOM", rolePermissions: [{ permissionKey: "finance.read", scope: "ALL" as const }] };
    expect(hasCustomPermission(user, "finance.read")).toBe(true);
    expect(hasCustomPermission(user, "finance.import")).toBe(false);
    expect(hasCustomPermission(user, "finance.adjust")).toBe(false);
  });

  it("业务管理权不能自动产生规则发布和调整权限", () => {
    const user = { role: "CUSTOM", managerAuthorized: true, rolePermissions: [{ permissionKey: "finance.read", scope: "ALL" as const }] };
    expect(scopeFor(user, "finance.rules")).toBeUndefined();
    expect(scopeFor(user, "finance.adjust")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run permission tests to verify the new keys are absent**

Run: `npm run test:run -- src/tests/lib/finance-internal-permissions.test.ts`
Expected: FAIL because the new permission keys and type members do not exist.

- [ ] **Step 3: Add the schema enums and models**

Add enums for import status, source kind, reconciliation status, calculation status, matter origin, ledger entry kind, tax phase, capital flow kind and adjustment status. Every model must include `id`, `createdAt`, `updatedAt` where it is mutable, and user relations for creator/decider fields. Use `Decimal @db.Decimal(14, 2)` for monetary values. Add indexes for `(period, status)`, `(matterId)`, `(paymentId)`, `(sourceHash)`, `(batchId, sourceRow)` and `(targetUserId, period)`.

Prisma enum names map to the literal unions exported by `internal-types.ts`; do not create a second conflicting TypeScript enum. Server actions convert Prisma values to the shared DTOs at the boundary.

`FinanceSourceRow` stores normalized date, signed amount, direction, counterparty digest/display value protected by finance permission, description digest/display value, external reference, source file ID and source row number. It does not store complete raw bank account text.

`FinanceCalculationRun` stores `periodStart`, `periodEnd`, `sourceHash`, `ruleVersionIds`, `status`, `trigger`, `calculatedAt`, `supersededById` and a JSON summary. `FinanceAdjustment` stores `account`, `targetUserId?`, `amount`, `reason`, `evidenceRef?`, `reversalOfId?`, `status` and audit user IDs.

- [ ] **Step 4: Write and apply the migration from the schema**

Run `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script` against a disposable schema comparison environment, save the reviewed delta as `prisma/migrations/20260922000001_finance_operating_loop/migration.sql`, and keep it limited to the new finance tables and indexes. Run `npm run prisma:validate` and `npx prisma generate`.

Expected: validation and client generation pass; existing tables are not dropped, renamed, or altered beyond explicit reverse relations.

- [ ] **Step 5: Register permissions without widening existing roles implicitly**

Add labels and scopes to `PERMISSIONS`; add the new keys to the explicit `FINANCE` grant set only where the existing role model intends full finance access. Do not add them to `MANAGER_GRANTS`, ordinary lawyer grants or `SOLE_PRACTICE_GRANTS` automatically. Add a separate explicit helper for `finance.adjust` and `finance.rules` checks if the existing `canExecuteFinance` union cannot express them safely.

- [ ] **Step 6: Run focused tests and commit**

Run: `npm run test:run -- src/tests/lib/finance-internal-permissions.test.ts src/tests/lib/permissions.test.ts src/tests/lib/custom-roles.test.ts`
Expected: PASS. Then run: `npm run prisma:validate`.
Commit:

```powershell
git add prisma/schema.prisma prisma/migrations/20260922000001_finance_operating_loop/migration.sql src/lib/roles/catalog.ts src/tests/lib/permissions.test.ts src/tests/lib/custom-roles.test.ts src/tests/lib/finance-internal-permissions.test.ts
git commit -m "feat: add finance operating loop schema and permissions"
```

### Task 2: Implement CSV/XLSX parsing, safe legacy-XLS rejection and source fingerprints

**Files:**
- Modify: `src/lib/finance/internal-types.ts`
- Create: `src/lib/finance/import-parser.ts`
- Create: `src/lib/finance/source-fingerprint.ts`
- Create: `src/tests/lib/finance-import-parser.test.ts`
- Create: `src/tests/lib/finance-source-fingerprint.test.ts`

**Interfaces:**
- Produces `parseFinanceWorkbook(bytes: Buffer, fileName: string, kind: FinanceSourceKind, suppliedMapping?: FinanceColumnMapping): Promise<FinanceParseResult>`.
- Produces `normalizeFinanceRow(input: unknown, mapping: FinanceColumnMapping, options: { sourceKind: FinanceSourceKind; sourceRowNumber: number }): FinanceNormalizedRow | FinanceRowError`.
- Produces `fileSha256(bytes: Buffer): string` and `rowFingerprint(row: FinanceNormalizedRow): string`.

- [ ] **Step 1: Confirm the safe parser boundary**

Reuse the existing ExcelJS dependency for `.csv` and `.xlsx`; do not add SheetJS `xlsx` because the current published version is flagged by `npm audit` for high-severity prototype-pollution and ReDoS issues without a fixed package release. For `.xls`, return an explicit unsupported-format error instructing the user to convert it to `.xlsx`; never invoke an untrusted external converter in the web request.

- [ ] **Step 2: Write parser tests for Chinese bank headers and bad rows**

In the test file, import `ExcelJS` and define the local async helper `xlsxBuffer(rows)` by creating a workbook, adding `Sheet1`, appending each row, and returning `Buffer.from(await workbook.xlsx.writeBuffer())`; this helper is test-only and does not enter the production parser.

```ts
it("识别借方/贷方并统一为有符号金额", async () => {
  const result = await parseFinanceWorkbook(xlsxBuffer([["日期", "对方户名", "借方发生额", "贷方发生额", "余额"], ["2026-08-01", "合成客户", "", "100000.00", "100000.00"]]), "银行流水.xlsx", "BANK_STATEMENT");
  expect(result.rows[0]).toMatchObject({ occurredAt: "2026-08-01", amount: "100000.00", direction: "CREDIT" });
});

it("缺少日期或金额时返回行级错误而不是静默丢弃", async () => {
  const result = await parseFinanceWorkbook(xlsxBuffer([["摘要", "金额"], ["缺日期", "100.00"]]), "bad.xlsx", "BANK_STATEMENT");
  expect(result.errors[0]).toMatchObject({ code: "MISSING_OCCURRED_AT", rowNumber: 2 });
});
```

- [ ] **Step 3: Run parser tests to verify they fail**

Run: `npm run test:run -- src/tests/lib/finance-import-parser.test.ts src/tests/lib/finance-source-fingerprint.test.ts`
Expected: FAIL because parser and fingerprint functions do not exist.

- [ ] **Step 4: Implement deterministic parsing and normalization**

Normalize dates to `YYYY-MM-DD`, amounts to decimal strings, direction to `CREDIT`/`DEBIT`, and preserve source file name plus source row number. Detect common Chinese aliases for date, debit, credit, amount, balance, counterparty, account, purpose, abstract, note, receipt number and invoice/reference number. A generic zero amount may be replaced by a non-zero debit/credit observation from the same row; never invent a value when both are absent.

Use a stable serializer that sorts object keys and normalizes whitespace before hashing. `rowFingerprint` must include batch kind, date, signed amount, counterparty digest, external reference, abstract digest and source row, but must not include a complete account number or unredacted sensitive text.

- [ ] **Step 5: Run tests and commit**

Run: `npm run test:run -- src/tests/lib/finance-import-parser.test.ts src/tests/lib/finance-source-fingerprint.test.ts`
Expected: PASS for `.csv`, `.xlsx`, safe rejection of `.xls`, Chinese headers, negative expenses, duplicate rows and missing-field errors.

```powershell
git add src/lib/finance/internal-types.ts src/lib/finance/import-parser.ts src/lib/finance/source-fingerprint.ts src/tests/lib/finance-import-parser.test.ts src/tests/lib/finance-source-fingerprint.test.ts docs/superpowers/plans/2026-09-22-law-firm-finance.md
git commit -m "feat: normalize finance source files"
```

### Task 3: Build atomic import batches and protected source downloads

**Files:**
- Create: `src/server/finance/internal-schemas.ts`
- Create: `src/server/finance/internal-imports.ts`
- Create: `src/app/api/finance/internal/imports/preview/route.ts`
- Create: `src/app/api/finance/internal/imports/commit/route.ts`
- Create: `src/app/api/finance/internal/imports/[id]/source/route.ts`
- Create: `src/tests/server/finance-internal-imports.test.ts`
- Modify: `src/server/audit.ts` only if a finance-specific redaction helper is needed; do not change generic audit semantics.

**Interfaces:**
- `previewFinanceImport(formData: FormData): Promise<FinanceImportPreview>`
- `commitFinanceImport(input: CommitFinanceImportInput): Promise<{ batchId: string; duplicate: boolean }>`
- `downloadFinanceImportSource(id: string): Promise<{ bytes: Buffer; fileName: string; mimeType: string }>`

- [ ] **Test fixture setup:** use an in-memory Prisma/storage mock with local test helpers `formDataFor(fileName)` and `inputFor(fileName)` that load only the Task 0 synthetic bytes; assert the action receives the mock through dependency injection rather than connecting to a real database or storage provider.

- [ ] **Step 1: Write failing atomicity tests**

```ts
it("预览不写数据库和私有存储", async () => {
  const result = await previewFinanceImport(formDataFor("synthetic.xlsx"));
  expect(result.validCount).toBe(1);
  expect(db.financeImportBatch.create).not.toHaveBeenCalled();
  expect(storage.writeFile).not.toHaveBeenCalled();
});

it("同一 sha256 的已提交批次幂等返回原批次", async () => {
  db.financeImportBatch.findUnique.mockResolvedValue({ id: "batch-old", status: "COMMITTED" });
  await expect(commitFinanceImport(inputFor("same.xlsx"))).resolves.toEqual({ batchId: "batch-old", duplicate: true });
  expect(storage.writeFile).not.toHaveBeenCalled();
});

it("数据库事务失败时删除已写入的原文件", async () => {
  db.financeImportBatch.findUnique.mockResolvedValue(null);
  db.$transaction.mockRejectedValue(new Error("db failed"));
  await expect(commitFinanceImport(inputFor("synthetic.xlsx"))).rejects.toThrow("db failed");
  expect(storage.deleteFile).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:run -- src/tests/server/finance-internal-imports.test.ts`
Expected: FAIL because the schemas, actions and routes do not exist.

- [ ] **Step 3: Implement schemas and preview**

`internal-schemas.ts` must export `financeImportKindSchema`, `financeColumnMappingSchema`, `financePeriodSchema`, `commitFinanceImportSchema` and `sourceDownloadSchema`. Preview validates file extension, byte size, mapped required fields and row-level errors, but returns only safe previews with masked accounts and truncated descriptions.

- [ ] **Step 4: Implement the atomic commit sequence**

The only accepted sequence is: read bytes → parse and validate again on the server → calculate SHA-256 → look up a committed batch with the same hash and kind → `storage.writeFile("finance-imports", bytes)` → one Prisma transaction creates batch, source file, source rows and audit entry via `auditTx` → return batch ID. If any database step fails after storage succeeds, call `storage.deleteFile` and rethrow the original database error. A batch with blocking row errors is rejected as a whole; it never becomes a partially committed batch.

- [ ] **Step 5: Implement protected source download**

The route must call `requireSession("finance.read")` or `requireSession("finance.import")`, verify the batch is visible to the session, call `auditStrict` for the sensitive download, set `Content-Disposition: attachment`, and stream bytes without returning a public URL. Audit detail contains batch ID, kind, byte count and file extension only.

- [ ] **Step 6: Run tests and commit**

Run: `npm run test:run -- src/tests/server/finance-internal-imports.test.ts`; expected PASS for preview side effects, duplicate idempotency, transaction cleanup, permission rejection, masked preview and protected download.

```powershell
git add src/server/finance/internal-schemas.ts src/server/finance/internal-imports.ts src/app/api/finance/internal/imports src/tests/server/finance-internal-imports.test.ts
git commit -m "feat: add audited finance import batches"
```

### Task 4: Implement deterministic reconciliation, claims and refunds

**Files:**
- Create: `src/lib/finance/internal-matching.ts`
- Create: `src/server/finance/internal-reconciliation.ts`
- Create: `src/app/api/finance/internal/reconciliation/route.ts`
- Create: `src/app/api/finance/internal/reconciliation/[id]/decision/route.ts`
- Create: `src/app/api/finance/internal/reconciliation/export/route.ts`
- Create: `src/app/api/finance/internal/reconciliation/import/route.ts`
- Create: `src/tests/lib/finance-internal-matching.test.ts`
- Create: `src/tests/server/finance-internal-reconciliation.test.ts`
- Modify: `src/lib/finance/internal-types.ts` only for matching DTOs.

**Interfaces:**
- `rankPaymentCandidates(row: FinanceNormalizedRow, candidates: ConfirmedPaymentCandidate[]): FinanceMatchSuggestion[]`
- `listFinanceReconciliationCases(input: ReconciliationQuery): Promise<ReconciliationQueue>`
- `decideFinanceReconciliation(input: ReconciliationDecisionInput): Promise<{ caseId: string; status: FinanceMatchStatus }>`
- `linkFinanceRefund(input: RefundLinkInput): Promise<{ linkId: string }>`
- `exportClaimDecisions(input: ReconciliationQuery): Promise<Buffer>`
- `importClaimDecisions(file: File): Promise<{ applied: number; skipped: number; errors: number }>`

- [ ] **Step 1: Write matching tests before implementation**

In the test file, define test-only helpers `row(date, amount): FinanceNormalizedRow` and `payment(id, date, amount): ConfirmedPaymentCandidate` with the fields required by the declared interfaces; use no database records or production identifiers.

```ts
it("同金额同上海日期优先于仅金额相同的候选", () => {
  const result = rankPaymentCandidates(row("2026-08-01", "100.00"), [
    payment("p-same-day", "2026-08-01", "100.00"),
    payment("p-window", "2026-08-03", "100.00")
  ]);
  expect(result[0]).toMatchObject({ paymentId: "p-same-day", confidence: "HIGH" });
});

it("同分候选进入疑点而不是自动确认", () => {
  const result = rankPaymentCandidates(row("2026-08-01", "100.00"), [
    payment("p-1", "2026-08-01", "100.00"), payment("p-2", "2026-08-01", "100.00")
  ]);
  expect(result.every(item => item.autoConfirm === false)).toBe(true);
});

it("金额不同即使摘要相同也不产生自动候选", () => {
  expect(rankPaymentCandidates(row("2026-08-01", "100.01"), [payment("p", "2026-08-01", "100.00")])).toEqual([]);
});
```

- [ ] **Step 2: Implement scoring rules**

Use exact amount plus same external reference/invoice reference for 100 points; exact amount plus same Shanghai calendar day for 90; exact amount within ±3 Shanghai calendar days for 70; otherwise no candidate. Only a unique candidate scoring at least 90 can be `SUGGESTED`. Same-score candidates, an already-used Payment, an unconfirmed Payment or a non-`LAWYER_FEE` Payment must be `EXCEPTION` or omitted. Never confirm based on client name alone.

- [ ] **Step 3: Implement server queries and decisions**

Candidate queries must join only `Payment` whose source `FeeEntry.confirmState = CONFIRMED`, `moneyKind = LAWYER_FEE`, `matter.deletedAt = null` and whose matter is visible under the finance report filter. The decision transaction locks the case, checks that it is still open, checks that the Payment is not already confirmed elsewhere, writes the decision and `auditTx`, and never edits source row amount or Payment amount.

- [ ] **Step 4: Implement unresolved claims and refund links**

Support claim target `clientId`, `matterId`, optional lawyer/channel metadata, reason and operator. A debit containing refund/return/advance semantics may be linked to one original lawyer-fee Payment; the net amount is used by later calculations. Reject a second active refund link for the same source amount unless a finance correction explicitly reverses the first link.

The export route contains only masked source row ID, date, signed amount, candidate IDs, decision column and a short reason field. The import route validates the batch ID and row fingerprint again, ignores already decided rows, applies only explicit `CONFIRM`, `IGNORE` or `SUSPECT` decisions, and returns row-level errors without changing the original source row.

- [ ] **Step 5: Run tests and commit**

Run: `npm run test:run -- src/tests/lib/finance-internal-matching.test.ts src/tests/server/finance-internal-reconciliation.test.ts`
Expected: PASS; pending receipts never become candidates, ambiguous matches never auto-confirm, repeated decisions are idempotent, and refund links preserve source history.

```powershell
git add src/lib/finance/internal-matching.ts src/server/finance/internal-reconciliation.ts src/app/api/finance/internal/reconciliation src/tests/lib/finance-internal-matching.test.ts src/tests/server/finance-internal-reconciliation.test.ts
git commit -m "feat: add finance reconciliation and claim workflow"
```

## 阶段 2：版本化分配与三视角核对

### Task 5: Implement matter profiles, versioned rules and allocation snapshots

**Files:**
- Create: `src/lib/finance/internal-rules.ts`
- Create: `src/server/finance/internal-rules.ts`
- Create: `src/server/finance/internal-allocation.ts`
- Create: `src/app/api/finance/internal/rules/route.ts`
- Create: `src/app/api/finance/internal/rules/[id]/publish/route.ts`
- Create: `src/app/api/finance/internal/allocation/preview/route.ts`
- Create: `src/app/api/finance/internal/allocation/commit/route.ts`
- Create: `src/tests/lib/finance-internal-rules.test.ts`
- Create: `src/tests/server/finance-internal-rules.test.ts`
- Create: `src/tests/server/finance-internal-allocation.test.ts`

**Interfaces:**
- `financeRuleDefinitionSchema` and `financeMatterProfileSchema`.
- `calculateAllocation(input: AllocationInput): AllocationResult`.
- `createFinanceRuleDraft(input): Promise<{ id: string; version: number }>`.
- `publishFinanceRule(id: string): Promise<{ id: string; version: number }>`.
- `setFinanceMatterProfile(input): Promise<{ matterId: string }>`.
- `previewInternalAllocation(input): Promise<AllocationPreview>`.
- `commitInternalAllocation(runId: string): Promise<{ runId: string; status: "COMMITTED" }>`.

- [ ] **Step 1: Write pure rule tests**

```ts
it("渠道案按渠道、律所、案源、承办和协办拆分且金额守恒", () => {
  const result = calculateAllocation({
    gross: "100000.00", channelRate: "0.10", firmRate: "0.45",
    sourceRate: "0.20", handlingRate: "0.45", coRate: "0.35"
  });
  expect(result.channel.plus(result.firm).plus(result.source).plus(result.handling).plus(result.co).toFixed(2)).toBe("100000.00");
  expect(result.channel.gte(0)).toBe(true);
});

it("缺少案件来源或比例超过边界时阻断提交", () => {
  expect(() => calculateAllocation({ gross: "100.00", channelRate: "0.10", firmRate: "0.95", sourceRate: "0.50", handlingRate: "0.50", coRate: "0.50" })).toThrow("分配比例不合法");
});
```

- [ ] **Step 2: Implement rule schema and immutable publication**

Rules contain kind, effective dates, percentages/fixed amounts, rounding mode, source note and active status. Drafts may be edited; published versions cannot be updated or deleted. Publishing runs in a transaction that checks `effectiveFrom < effectiveTo`, same-kind published ranges do not overlap, percentages are non-negative and totals fit the configured boundary. The publication audit stores rule ID/version and operator, not client names or source descriptions.

- [ ] **Step 3: Implement matter profile and calculation preview**

`setFinanceMatterProfile` upserts only `matterId`, origin, lawyer level, channel label, participant IDs, internal note and audit fields. It verifies the matter exists and is not deleted. Allocation preview reads confirmed `Payment`, `FinanceMatterProfile`, active `CommissionPlan`, refund links and effective rule versions; it reports missing profile, missing plan, missing rule and illegal percentage as blocking issues.

- [ ] **Step 4: Implement immutable commit and idempotency**

Preview creates `FinanceCalculationRun(status = PREVIEW)` and line snapshots. Commit re-reads the sources in a transaction, compares the input fingerprint, refuses changed or blocked input, writes `FinanceAllocationLine`, marks the run `COMMITTED`, and returns the existing committed run for an identical retry. It never edits `Payment`, `FeeEntry` or the matter itself.

- [ ] **Step 5: Run tests and commit**

Run: `npm run test:run -- src/tests/lib/finance-internal-rules.test.ts src/tests/server/finance-internal-rules.test.ts src/tests/server/finance-internal-allocation.test.ts`
Expected: PASS for immutable publication, percentage boundaries, missing configuration blocks, amount conservation, source-change rejection and idempotent commit.

```powershell
git add src/lib/finance/internal-rules.ts src/server/finance/internal-rules.ts src/server/finance/internal-allocation.ts src/app/api/finance/internal/rules src/app/api/finance/internal/allocation src/tests/lib/finance-internal-rules.test.ts src/tests/server/finance-internal-rules.test.ts src/tests/server/finance-internal-allocation.test.ts
git commit -m "feat: persist versioned finance allocation snapshots"
```

### Task 6: Implement the three finance views and export data contract

**Files:**
- Create: `src/server/finance/internal-reports.ts`
- Create: `src/server/finance/internal-export.ts`
- Create: `src/app/api/finance/internal/export/route.ts`
- Create: `src/tests/server/finance-internal-reports.test.ts`

**Interfaces:**
- `getInternalFinanceSummary(input): Promise<InternalFinanceSummary>`.
- `getPersonView(input): Promise<PersonFinanceView[]>`.
- `getProjectAttributionView(input): Promise<ProjectAttributionView[]>`.
- `getFirmOperatingView(input): Promise<FirmOperatingView>`.
- `buildFinanceWorkbook(input): Promise<Buffer>`.

- [ ] **Step 1: Write aggregation tests**

Use the synthetic fixture helpers from Task 0; define `start` and `end` as fixed `Date` values and provide mocked `committedRun({ amount })`/`previewRun({ amount })` rows matching the Prisma DTO returned by the repository mock. The test must not depend on the real database.

```ts
it("只汇总 COMMITTED 计算批次", async () => {
  db.financeCalculationRun.findMany.mockResolvedValue([
    committedRun({ amount: "100.00" }),
    previewRun({ amount: "999.00" })
  ]);
  const result = await getInternalFinanceSummary({ start, end, groupBy: "LAWYER" });
  expect(result.total).toBe("100.00");
});

it("三视角使用同一计算批次并可穿透到分配行", async () => {
  const result = await getInternalFinanceSummary({ start, end, groupBy: "ALL" });
  expect(result.persons[0].calculationRunId).toBe(result.firm.calculationRunId);
  expect(result.projects[0].lines[0].sourcePaymentId).toBe("synthetic-payment-1");
});
```

- [ ] **Step 2: Implement server-side aggregation**

All query inputs are validated by Zod and filtered by `finance.read`, existing matter visibility and `FinanceCalculationRun.status = COMMITTED`. Person view includes gross income, channel fee, source/handling/co shares, base salary, personal social/fund, custom cost, tax, frozen amount, withdrawn and pending. Project view includes matter, client reference, channel, rates and monthly role amounts. Firm view includes fee revenue, other operating income, channel/lawyer commission, taxes, firm salary/social, rent/office cost, operating result and capital net separately.

- [ ] **Step 3: Implement the workbook contract**

The workbook has fixed sheets `人员透支表`, `客户项目归属`, `律所经营成果`, `来源与对账`, `调整审计`. Amounts use `#,##0.00`; dates use Shanghai calendar formatting; source files and account fields are masked; each sheet includes `calculationRunId` and source period. The route writes an export audit entry containing period, view, bytes and operator only.

- [ ] **Step 4: Run tests and commit**

Run: `npm run test:run -- src/tests/server/finance-internal-reports.test.ts`
Expected: PASS; PREVIEW/FAILED runs never appear, unauthorized users are rejected, three views reconcile to the same run and workbook sheet names are stable.

```powershell
git add src/server/finance/internal-reports.ts src/server/finance/internal-export.ts src/app/api/finance/internal/export src/tests/server/finance-internal-reports.test.ts
git commit -m "feat: add finance three-view reports"
```

## 阶段 3：个人内账、工资、税款与投资人经营

### Task 7: Implement personal double balances and operating accounting

**Files:**
- Create: `src/lib/finance/internal-accounting.ts`
- Create: `src/server/finance/internal-accounting-actions.ts`
- Create: `src/app/api/finance/internal/accounting/route.ts`
- Create: `src/app/api/finance/internal/payroll/route.ts`
- Create: `src/app/api/finance/internal/tax/route.ts`
- Create: `src/app/api/finance/internal/capital/route.ts`
- Create: `src/tests/lib/finance-internal-accounting.test.ts`
- Create: `src/tests/server/finance-internal-accounting.test.ts`

**Interfaces:**
- `buildPersonalDoubleBalance(input): PersonalDoubleBalance`.
- `buildFirmOperatingResult(input): FirmOperatingResult`.
- `savePayrollFact(input): Promise<{ id: string }>`.
- `savePartnerTaxRecord(input): Promise<{ id: string }>`.
- `saveCapitalFlow(input): Promise<{ id: string }>`.
- `getInternalAccounting(input): Promise<InternalAccountingView>`.

- [ ] **Step 1: Write the double-balance tests**

```ts
it("收入余额与自担预存余额分开计算", () => {
  const result = buildPersonalDoubleBalance({
    openingDistributable: "0.00", openingReserve: "20000.00",
    earnedIncome: "10000.00", selfCostDue: "30000.00",
    selfFundingIn: "0.00", withdrawn: "0.00", partnerTaxAdvance: "0.00", unsettledHold: "0.00"
  });
  expect(result.selfFundingUsed).toBe("20000.00");
  expect(result.selfFundingReserveEnd).toBe("0.00");
  expect(result.reserveGap).toBe("40000.00");
  expect(result.distributableEnd).toBe("-20000.00");
});

it("收入提取和个人税款预付不重复进入律所经营成本", () => {
  const result = buildFirmOperatingResult({ feeRevenue: "100.00", incomeWithdrawal: "80.00", partnerTaxAdvance: "20.00", firmSalary: "0.00", firmSocial: "0.00", rent: "0.00", channel: "0.00", lawyer: "0.00", taxes: "0.00" });
  expect(result.operatingResult).toBe("100.00");
});
```

- [ ] **Step 2: Implement monthly double-balance arithmetic**

For each person and month, calculate earned source/handling/co income, self salary/social/fund cost, self-funding inflow, self-funding used, reserve ending balance, two-month coverage target, reserve gap, unsettled hold, income withdrawal, partner tax advance, personally paid tax and distributable ending balance. Keep negative distributable balances and carry reserve gap to the next month; never clamp a deficit to zero except for a display-only pending-withdrawal field.

- [ ] **Step 3: Implement operating result and capital separation**

Compute `feeRevenue + otherOperatingIncome - channelCommissionAccrued - lawyerCommissionAccrued - turnoverTaxes - firmSalaryCost - firmSocialCost - rentOfficeOther`. Exclude personal reserve, income withdrawal, partner personal tax cash and capital in/out. Record capital flow kind, investor, date, amount, through-partner ID, linked bank source and remarks.

- [ ] **Step 4: Implement payroll and partner tax facts**

Payroll facts contain period, gross salary, commission, social personal/company, fund personal/company, income tax, other deduction, reimbursement, actual payment period and source batch. Partner tax records separate estimated tax, firm advance, personal paid amount/date, phase and evidence reference. All writes require `finance.adjust` or a dedicated finance role and use `auditTx`.

- [ ] **Step 5: Run tests and commit**

Run: `npm run test:run -- src/tests/lib/finance-internal-accounting.test.ts src/tests/server/finance-internal-accounting.test.ts`
Expected: PASS for two balances, two-month gap carry, income-withdrawal exclusion, tax advance/unverified tax and capital separation.

```powershell
git add src/lib/finance/internal-accounting.ts src/server/finance/internal-accounting-actions.ts src/app/api/finance/internal/accounting src/app/api/finance/internal/payroll src/app/api/finance/internal/tax src/app/api/finance/internal/capital src/tests/lib/finance-internal-accounting.test.ts src/tests/server/finance-internal-accounting.test.ts
git commit -m "feat: add personal double balances and firm operating accounting"
```

## 阶段 4：持久化计算、月结和交付

### Task 8: Implement materialization, adjustments and monthly close package

**Files:**
- Create: `src/server/finance/materialization.ts`
- Create: `src/server/finance/monthly-close.ts`
- Create: `src/app/api/finance/internal/materialize/route.ts`
- Create: `src/app/api/finance/internal/monthly-close/route.ts`
- Create: `src/app/api/finance/internal/adjustments/route.ts`
- Create: `src/app/api/finance/internal/adjustments/[id]/reverse/route.ts`
- Create: `src/app/api/finance/internal/artifacts/[id]/route.ts`
- Create: `src/tests/server/finance-monthly-close.test.ts`

**Interfaces:**
- `sourceFingerprintForPeriod(period): Promise<string>`.
- `materializeFinancePeriod(input): Promise<FinanceCalculationRun>`.
- `getMonthlyCloseStatus(period): Promise<MonthlyCloseStatus>`.
- `createFinanceAdjustment(input): Promise<{ id: string; runId: string }>`.
- `reverseFinanceAdjustment(id: string, note: string): Promise<{ reversalId: string }>`.
- `generateMonthlyClose(period): Promise<FinanceArtifact[]>`.

- [ ] **Test fixture setup:** provide the mocked transaction database as `db` through the service dependency fixture; all dates, users, IDs and source facts come from Task 0 synthetic data.

- [ ] **Step 1: Write monthly close blocking tests**

```ts
it("待认领或分成不平时不能生成正式月结包", async () => {
  const status = await getMonthlyCloseStatus("2026-08");
  expect(status.ready).toBe(false);
  expect(status.blockingWarnings).toEqual(expect.arrayContaining([expect.stringContaining("待认领")]))
  await expect(generateMonthlyClose("2026-08")).rejects.toThrow("存在阻断项");
});

it("调整采用追加凭证，冲销不删除原记录", async () => {
  const created = await createFinanceAdjustment({ period: "2026-08", account: "user.self_cost", targetUserId: "synthetic-user-1", amount: "100.00", reason: "合成测试调整" });
  const reversal = await reverseFinanceAdjustment(created.id, "合成测试冲销");
  expect(await db.financeAdjustment.findUnique({ where: { id: created.id } })).toMatchObject({ status: "REVERSED" });
  expect(reversal.reversalId).toBeTruthy();
});
```

- [ ] **Step 2: Implement source hash and persisted runs**

Hash the sorted, redacted input facts for the selected period and all prior facts that affect carry-forward balances: users and cost settings, matter profiles, confirmed payments, refund links, payroll facts, partner tax records, capital flows and posted/reversed adjustments. If an existing `COMMITTED` run has the same hash, return it. If the hash differs, create a new run and mark the previous one `SUPERSEDED` only after the new run commits.

- [ ] **Step 3: Implement monthly status and adjustment lifecycle**

Status must report archived source files, source kinds, transaction count, unresolved count, unresolved income count, split error count, missing payroll facts, template warnings, blocking warnings, review warnings, run ID and source hash. Adjustments are append-only; a reversal creates an equal opposite row and retains `reversalOfId`. Original bank rows, payroll facts and allocation lines are never edited.

- [ ] **Step 4: Implement generated artifacts**

Generate a wage workbook, accountant package, personal finance views, adjustment audit workbook and complete ZIP from the same committed run. Store artifact metadata and a protected download path. Reject generation when the run is PREVIEW, FAILED or has blocking warnings; allow a clearly labeled draft only through an explicit preview endpoint.

- [ ] **Step 5: Run tests and commit**

Run: `npm run test:run -- src/tests/server/finance-monthly-close.test.ts`
Expected: PASS for source-hash reuse, changed-source new run, blocking warnings, append-only adjustments, reversals, artifact/run identity and protected downloads.

```powershell
git add src/server/finance/materialization.ts src/server/finance/monthly-close.ts src/app/api/finance/internal/materialize src/app/api/finance/internal/monthly-close src/app/api/finance/internal/adjustments src/app/api/finance/internal/artifacts src/tests/server/finance-monthly-close.test.ts
git commit -m "feat: add persisted monthly close and finance artifacts"
```

### Task 9: Add the six workspaces without changing the existing case-ledger semantics

**Files:**
- Create: `src/app/(app)/finance/internal/page.tsx`
- Create: `src/app/(app)/finance/internal/_components/internal-finance-nav.tsx`
- Create: `src/app/(app)/finance/internal/imports/page.tsx`
- Create: `src/app/(app)/finance/internal/reconciliation/page.tsx`
- Create: `src/app/(app)/finance/internal/ledger/page.tsx`
- Create: `src/app/(app)/finance/internal/rules/page.tsx`
- Create: `src/app/(app)/finance/internal/monthly-close/page.tsx`
- Create: `src/app/(app)/finance/internal/_components/import-workspace.tsx`
- Create: `src/app/(app)/finance/internal/_components/reconciliation-workspace.tsx`
- Create: `src/app/(app)/finance/internal/_components/ledger-workspace.tsx`
- Create: `src/app/(app)/finance/internal/_components/rules-workspace.tsx`
- Create: `src/app/(app)/finance/internal/_components/monthly-close-workspace.tsx`
- Modify: `src/app/(app)/finance/page.tsx`
- Modify: `src/app/(app)/finance/_components/finance-view-v4.tsx`
- Create: `src/tests/app/finance-internal-workspaces.test.tsx`

**Interfaces:**
- Server pages call `requireSession("finance.read")` before loading finance-domain data.
- Client components receive serialized Decimal strings and explicit flags: `canImport`, `canReconcile`, `canManageRules`, `canAdjust` and `canExport`.

- [ ] **Step 1: Write permission and empty-state UI tests**

```tsx
it("没有导入权限时不渲染上传按钮", () => {
  render(<ImportWorkspace batches={[]} canImport={false} />);
  expect(screen.queryByRole("button", { name: "上传并预览" })).not.toBeInTheDocument();
});

it("没有数据时不展示假金额", () => {
  render(<LedgerWorkspace view={{ persons: [], projects: [], firm: null }} />);
  expect(screen.getByText("暂无已提交的财务计算批次")).toBeInTheDocument();
  expect(screen.queryByText(/¥/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Implement navigation and server page gates**

Render six groups: `财务总览`, `银行流水与归档`, `待办认领与归类`, `分成与个人内账`, `月结与财务交付`, `报表与核对`. Each page loads only the data required for its group. Existing `/finance/reconciliation` remains the case-level receivable/payment workspace; the new `/finance/internal/*` paths are the firm-level operating finance workspace.

The rules page uses `rules-workspace.tsx` and is reachable from the `分成与个人内账` group; it exposes draft, effective-date and publish status without exposing unmasked source evidence.

- [ ] **Step 3: Implement import and reconciliation workspaces**

The import page has select kind → upload → map columns → preview rows → submit. The reconciliation page shows candidate reason, amount difference, source batch/row, target matter and decision history, with actions `接受建议`, `改选目标`, `标记疑点`, `忽略并说明`. No native `alert`, `confirm` or `prompt`; use the existing toast/dialog pattern.

- [ ] **Step 4: Implement ledger and monthly-close workspaces**

Ledger supports person/project/firm view switches, period filters, drill-down to allocation lines and export. Personal view displays distributable balance and reserve balance in separate columns. Monthly close displays source coverage, blocking warnings, unresolved export/import, adjustments/reversal history, run ID/hash and artifact download buttons. Every displayed amount comes from a server snapshot.

- [ ] **Step 5: Add a link from the existing finance page**

Add an `InternalFinanceLinks` card to `FinancePage`/`FinanceViewV4` only when the user has `finance.read`. Do not alter existing KPI semantics, pending-receipt confirmation, invoice workflows, matter-level visibility or existing `finance/export` output.

- [ ] **Step 6: Run UI tests and commit**

Run: `npm run test:run -- src/tests/app/finance-internal-workspaces.test.tsx`
Expected: PASS; unauthorized users cannot see write buttons, empty states contain no fabricated data, and all visible amounts carry period/run context.

```powershell
git add 'src/app/(app)/finance/internal' 'src/app/(app)/finance/page.tsx' 'src/app/(app)/finance/_components/finance-view-v4.tsx' src/tests/app/finance-internal-workspaces.test.tsx
git commit -m "feat: add internal finance workspaces"
```

## 收尾阶段：文档、端到端验收与交付闸门

### Task 10: Add operations documentation and synthetic end-to-end acceptance

**Files:**
- Create: `docs/FINANCE-OPERATING-LOOP.md`
- Create: `src/tests/server/finance-operating-acceptance.test.ts`
- Modify: `docs/PRD.md` only to record implemented entry points and boundaries; do not add future promises.

- [ ] **Step 1: Write the synthetic end-to-end acceptance test**

Use the fixture from Task 0: one confirmed lawyer-fee payment, one pending receipt, one refund linked to the payment, channel/firm/lawyer split, two payroll facts, one partner tax advance and one capital flow. Assert that pending receipt is excluded, import is idempotent, matching has one unique suggestion, allocation conserves the payment amount, person/firm views share a run ID, reserve gap persists, capital is excluded from operating result and a month-close artifact lists the same run hash.

- [ ] **Step 2: Run the acceptance test before full checks**

Run: `npm run test:run -- src/tests/server/finance-operating-acceptance.test.ts`
Expected: PASS without network access, production database access or real files.

- [ ] **Step 3: Write the operations guide**

Document the upload formats, required fields, duplicate handling, candidate-match reasons, manual claim decisions, refund linking, rule publication, double-balance meaning, tax/capital boundaries, monthly adjustments, artifact downloads and the statement that results are management reconciliation outputs rather than statutory financial statements. Do not include real client names, contract numbers, bank accounts, passwords, VPS addresses or sample file contents.

- [ ] **Step 4: Run the complete verification suite**

Run in order:

```powershell
npm run test:run
npm run lint
npm run typecheck
npm run prisma:validate
npm run build
git diff --check HEAD~1..HEAD
rg -n "Sofos@|BEGIN .*PRIVATE KEY|101\.34\.217\.248" src/tests src/lib/finance src/server/finance docs/FINANCE-OPERATING-LOOP.md
```

Expected: all project checks exit 0; the final `rg` returns no sensitive credentials or production IP references; the documented public entry URL is intentionally not part of this source-secret scan; `next-env.d.ts` remains the only pre-existing worktree modification when no other user changes exist.

- [ ] **Step 5: Review the final diff and commit documentation**

Run: `git status --short --branch` and `git diff --stat`. Verify no real business files, generated private artifacts or database dumps are staged.

```powershell
git add docs/FINANCE-OPERATING-LOOP.md docs/PRD.md src/tests/server/finance-operating-acceptance.test.ts
git commit -m "docs: document finance operating loop and acceptance"
```

## 阶段检查点与执行顺序

按 `Task 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10` 执行。每个任务单独提交并运行聚焦测试；Task 1 的迁移只在独立测试数据库演练；Task 5 的计算快照确认输入不变后才允许提交；Task 8 的月结文件只从 `COMMITTED` run 生成；Task 9 的 UI 不得改变现有案件财务入口语义。

阶段 1、2 完成后，由用户先用合成资料验收银行收入、Payment 门禁、案件分配和三视角报表。阶段 3、4 完成后，再用至少一个脱敏账期由用户和外部财务老师共同核对个人双余额、税款预付、资本流、月结调整和交付文件。没有这一步，不宣布财务口径已完成，也不连接生产资料。
