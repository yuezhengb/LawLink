# 律所内部财务系统第一期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 LawLink 现有案件财务子账之上，交付可复核的财务资料导入、内部收入分配、银行收款勾稽、差异处理和 Excel/CSV 导出闭环。

**Architecture:** 保留 LawLink 的 `Matter`、`Billing`、`Receivable`、已确认 `Payment`、`FeeEntry` 和 `CommissionPlan` 作为案件业务事实来源；在同一 PostgreSQL 中新增独立财务域表和服务层。第一期只生成带规则版本的核算/对账快照，不生成正式借贷凭证，不复制 ERPNext 或其他 GPL 系统代码。

**Tech Stack:** Next.js 16 App Router、TypeScript、React 19、Prisma 5、PostgreSQL 16、Zod、ExcelJS、SheetJS `xlsx`（仅用于 XLS/XLSX 读取）、Vitest、现有私有存储与审计服务。

## Global Constraints

- LawLink 继续作为客户、案件、合同、案件应收和已确认案件收款的事实来源。
- 第一阶段不包含自动报税、工资/社保付款、银行开放接口、OCR、正式会计凭证过账、期间结账和法定三表权威输出。
- 流程资料中的 20%/45%/35%、10% 和 15%—18% 只能作为可配置初始规则，不能写死。
- 规则一旦被计算批次使用，不允许原地修改；历史计算必须保留原规则版本。
- 原始文件进入私有存储，数据库只保存必要的标准化字段；日志不得输出完整身份证号、电话、银行卡号或客户敏感文本。
- 只有已确认的 LawLink 实收才能进入案件收款勾稽和律师分配。
- 任何更正采用追加记录，不物理删除已经参与导入、匹配或计算的来源数据。
- 真实客户接单表、银行流水、工资表、花名册和外部账表不得进入 Git；测试只使用合成样本。
- 业务规则沉淀在 `src/lib/finance` 或 `src/server/finance`，页面不得自行计算金额或状态。
- 面向用户的页面文案使用中文；不得引入 Ant Design 或 `@ant-design/*`。
- 修改后必须运行 `npm run lint`、`npm run typecheck`、`npm run prisma:validate` 和 `npm run build`。

---

## 文件结构与职责

### 新增文件

- `prisma/migrations/20260922000001_finance_internal_reconciliation/migration.sql`：第一期财务域的增量 SQL，仅供独立测试库和获授权环境使用。
- `src/lib/finance/internal-types.ts`：导入、匹配、规则计算和报告共享的纯 TypeScript 类型。
- `src/lib/finance/internal-rules.ts`：规则定义 Zod schema、金额分配算法和金额守恒校验；无数据库依赖。
- `src/lib/finance/import-parser.ts`：CSV/XLS/XLSX 的工作簿读取、列映射和标准化；无数据库依赖。
- `src/lib/finance/internal-matching.ts`：银行流水与已确认案件收款的确定性候选排序；无数据库依赖。
- `src/server/finance/internal-schemas.ts`：服务端输入 schema，负责动作参数、日期范围和权限边界校验。
- `src/server/finance/internal-imports.ts`：财务导入批次写入、私有原文件读出和批次查询。
- `src/server/finance/internal-actions.ts`：导入、对账、规则和分配相关 Server Actions 的薄入口。
- `src/server/finance/internal-reconciliation.ts`：查询候选收款、生成建议、确认/忽略/关闭差异。
- `src/server/finance/internal-rules-actions.ts`：规则集、规则版本和案件财务来源档案的事务写入。
- `src/server/finance/internal-allocation.ts`：读取已确认收款并生成不可变分配快照。
- `src/server/finance/internal-reports.ts`：汇总核对报表的数据查询和权限过滤。
- `src/server/finance/internal-export.ts`：ExcelJS 工作簿生成。
- `src/app/api/finance/imports/[id]/source/route.ts`：受权限保护的原始导入文件下载。
- `src/app/api/finance/internal/export/route.ts`：受权限保护的内部核算/对账 Excel 导出。
- `src/app/(app)/finance/imports/page.tsx`：导入批次页面。
- `src/app/(app)/finance/imports/_components/import-workspace.tsx`：上传、列映射、预览和提交界面。
- `src/app/(app)/finance/firm-reconciliation/page.tsx`：律所级对账页面，避免与现有案件应收分配页混淆。
- `src/app/(app)/finance/firm-reconciliation/_components/firm-reconciliation-workspace.tsx`：建议匹配、人工确认和差异关闭界面。
- `src/app/(app)/finance/rules/page.tsx`：规则版本页面。
- `src/app/(app)/finance/rules/_components/rules-workspace.tsx`：规则草稿、发布和案件来源档案界面。
- `src/app/(app)/finance/internal-ledger/page.tsx`：内部核算结果页面。
- `src/app/(app)/finance/internal-ledger/_components/internal-ledger-workspace.tsx`：按案件、律师、渠道和月份查看分配快照。
- `src/app/(app)/finance/_components/internal-finance-links.tsx`：现有财务首页到新财务域页面的入口卡片。
- `src/tests/lib/finance-internal-rules.test.ts`：规则算法单测。
- `src/tests/lib/finance-import-parser.test.ts`：CSV/XLS/XLSX 读取与标准化单测。
- `src/tests/lib/finance-internal-matching.test.ts`：匹配排序和歧义保护单测。
- `src/tests/lib/finance-internal-permissions.test.ts`：新财务权限目录和内置角色单测。
- `src/tests/server/finance-internal-imports.test.ts`：批次写入、重复导入和失败回滚单测。
- `src/tests/server/finance-internal-reconciliation.test.ts`：候选查询、确认和差异关闭单测。
- `src/tests/server/finance-internal-rules.test.ts`：规则版本不可变与生效区间单测。
- `src/tests/server/finance-internal-allocation.test.ts`：快照生成、缺少配置和幂等单测。
- `src/tests/server/finance-internal-reports.test.ts`：汇总和访问范围单测。
- `src/tests/app/finance-internal-workspaces.test.tsx`：财务域页面的预览、权限和空状态测试。
- `docs/FINANCE-INTERNAL-OPERATIONS.md`：第一期操作说明、字段映射和差异处理口径。

### 修改文件

- `prisma/schema.prisma`：新增财务导入、财务来源档案、规则版本、对账案例和分配快照模型，并补齐 `User`/`Matter` 的反向关系。
- `src/lib/roles/catalog.ts`：新增 `finance.import`、`finance.reconcile`、`finance.rules`、`finance.export`，均为全所范围；财务内置岗位默认拥有，其他岗位不隐式继承。
- `src/tests/lib/permissions.test.ts`：补充新权限不因系统管理员身份或业务管理权自动放大的断言。
- `src/app/(app)/finance/page.tsx`：增加新财务域入口和读取权限判断，不改变现有案件财务指标。
- `package.json` / `package-lock.json`：增加固定版本的 `xlsx` 依赖以读取旧式 `.xls` 文件；现有 `.xlsx` 报表导出继续使用 ExcelJS。

## Task 1: 建立财务域 Prisma 模型和权限边界

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260922000001_finance_internal_reconciliation/migration.sql`
- Modify: `src/lib/roles/catalog.ts`
- Modify: `src/tests/lib/permissions.test.ts`
- Create: `src/tests/lib/finance-internal-permissions.test.ts`

**Interfaces:**
- Produces Prisma models `FinanceImportBatch`、`FinanceImportRow`、`FinanceMatterProfile`、`FinanceRuleSet`、`FinanceRuleVersion`、`FinanceReconciliationCase`、`FinanceAllocationRun`、`FinanceAllocationLine`。
- Produces permission keys `finance.import`、`finance.reconcile`、`finance.rules`、`finance.export`，全部只允许 `ALL` scope。

- [ ] **Step 1: Write permission regression tests**

```ts
import { describe, expect, it } from "vitest";
import { PERMISSIONS, copyBuiltinGrants, scopeFor } from "@/lib/roles/catalog";

describe("内部财务权限", () => {
  it("四项财务域权限只提供全所范围", () => {
    for (const key of ["finance.import", "finance.reconcile", "finance.rules", "finance.export"] as const) {
      expect(PERMISSIONS.find((item) => item.key === key)?.scopes).toEqual(["ALL"]);
    }
  });

  it("财务岗位得到四项权限，主任授权本身不扩展为导入或规则管理", () => {
    const finance = copyBuiltinGrants("FINANCE");
    expect(scopeFor({ role: "CUSTOM", rolePermissions: finance }, "finance.import")).toBe("ALL");
    expect(scopeFor({ role: "CUSTOM", rolePermissions: finance }, "finance.rules")).toBe("ALL");
    expect(scopeFor({ role: "CUSTOM", rolePermissions: [{ permissionKey: "finance.read", scope: "ALL" }] }, "finance.import")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm run test:run -- src/tests/lib/finance-internal-permissions.test.ts`

Expected: FAIL because the four permission keys do not yet exist in `PermissionKey`.

- [ ] **Step 3: Add the permission definitions and built-in grants**

在 `src/lib/roles/catalog.ts` 的财务权限段加入：

```ts
{ key: "finance.import", label: "导入财务资料", group: "财务", scopes: ["ALL"] },
{ key: "finance.reconcile", label: "确认财务勾稽与差异", group: "财务", scopes: ["ALL"] },
{ key: "finance.rules", label: "维护内部核算规则", group: "财务", scopes: ["ALL"] },
{ key: "finance.export", label: "导出内部财务资料", group: "财务", scopes: ["ALL"] },
```

把四个 key 加入 `copyBuiltinGrants("FINANCE")` 的全所权限数组；不要加入 `MANAGER_GRANTS`，不要加入普通律师和独立执业默认模板。保留现有 `finance.read`、`finance.write`、`finance.confirm`、`finance.correct`、`finance.settle` 的行为。

- [ ] **Step 4: Add the exact enum and model definitions**

在财务模型附近加入以下枚举和字段。`sourceType/sourceId` 是有意保留的来源多态键，服务层必须用 Zod 白名单校验；不能用任意字符串直接写入。

```prisma
enum FinanceImportKind { BANK_STATEMENT PAYROLL EXTERNAL_STATEMENT }
enum FinanceImportStatus { PREVIEW COMMITTED REJECTED }
enum FinanceImportRowStatus { VALID DUPLICATE INVALID }
enum FinanceCashDirection { IN OUT }
enum FinanceMatterOrigin { CHANNEL SELF_SOURCED OTHER }
enum FinanceRuleKind { CHANNEL_SPLIT SELF_SOURCED_SPLIT PAYROLL SOCIAL_INSURANCE EXPENSE }
enum FinanceRuleStatus { DRAFT PUBLISHED RETIRED }
enum FinanceMatchStatus { UNMATCHED SUGGESTED MATCHED EXCEPTION IGNORED }
enum FinanceAllocationRunStatus { PREVIEW COMMITTED FAILED }
enum FinanceAllocationLineKind {
  CHANNEL_COMMISSION
  FIRM_RETAINED
  LAWYER_POOL
  LAWYER_SHARE
  ASSISTANCE_SHARE
  REIMBURSEMENT
  SOCIAL_INSURANCE
  TAX_RESERVE
  NET_DISTRIBUTABLE
  UNALLOCATED
}

model FinanceImportBatch {
  id String @id @default(cuid())
  kind FinanceImportKind
  status FinanceImportStatus @default(PREVIEW)
  originalName String
  storagePath String?
  mimeType String?
  size Int?
  sha256 String @unique
  columnMapping Json
  periodStart DateTime?
  periodEnd DateTime?
  totalRows Int @default(0)
  validRows Int @default(0)
  duplicateRows Int @default(0)
  errorRows Int @default(0)
  createdById String
  createdBy User @relation("FinanceImportCreator", fields: [createdById], references: [id], onDelete: Restrict)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  rows FinanceImportRow[]
  reconciliationCases FinanceReconciliationCase[]
  allocationRuns FinanceAllocationRun[]
  @@index([kind, status, createdAt])
}

model FinanceImportRow {
  id String @id @default(cuid())
  batchId String
  batch FinanceImportBatch @relation(fields: [batchId], references: [id], onDelete: Restrict)
  rowNumber Int
  occurredAt DateTime?
  amount Decimal? @db.Decimal(14, 2)
  direction FinanceCashDirection?
  counterparty String?
  description String?
  accountRef String?
  externalReference String?
  category String?
  fingerprint String
  status FinanceImportRowStatus
  errorCodes String[]
  createdAt DateTime @default(now())
  reconciliationCases FinanceReconciliationCase[]
  @@unique([batchId, rowNumber])
  @@index([fingerprint])
  @@index([batchId, status])
}

model FinanceMatterProfile {
  id String @id @default(cuid())
  matterId String @unique
  matter Matter @relation(fields: [matterId], references: [id], onDelete: Restrict)
  origin FinanceMatterOrigin
  lawyerLevel String?
  channelLabel String?
  note String?
  updatedById String
  updatedBy User @relation("FinanceMatterProfileUpdater", fields: [updatedById], references: [id], onDelete: Restrict)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model FinanceRuleSet {
  id String @id @default(cuid())
  name String
  kind FinanceRuleKind
  description String?
  active Boolean @default(true)
  createdById String
  createdBy User @relation("FinanceRuleSetCreator", fields: [createdById], references: [id], onDelete: Restrict)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  versions FinanceRuleVersion[]
  @@unique([name, kind])
}

model FinanceRuleVersion {
  id String @id @default(cuid())
  ruleSetId String
  ruleSet FinanceRuleSet @relation(fields: [ruleSetId], references: [id], onDelete: Restrict)
  version Int
  status FinanceRuleStatus @default(DRAFT)
  effectiveFrom DateTime
  effectiveTo DateTime?
  definition Json
  createdById String
  createdBy User @relation("FinanceRuleVersionCreator", fields: [createdById], references: [id], onDelete: Restrict)
  publishedById String?
  publishedBy User? @relation("FinanceRuleVersionPublisher", fields: [publishedById], references: [id], onDelete: Restrict)
  createdAt DateTime @default(now())
  publishedAt DateTime?
  allocationLines FinanceAllocationLine[]
  @@unique([ruleSetId, version])
  @@index([ruleSetId, status, effectiveFrom])
}

model FinanceReconciliationCase {
  id String @id @default(cuid())
  batchId String
  batch FinanceImportBatch @relation(fields: [batchId], references: [id], onDelete: Restrict)
  sourceRowId String
  sourceRow FinanceImportRow @relation(fields: [sourceRowId], references: [id], onDelete: Restrict)
  targetType String
  targetId String
  status FinanceMatchStatus @default(UNMATCHED)
  suggestedReason String?
  difference Decimal? @db.Decimal(14, 2)
  reviewedById String?
  reviewedBy User? @relation("FinanceReconciliationReviewer", fields: [reviewedById], references: [id], onDelete: Restrict)
  reviewedAt DateTime?
  resolutionNote String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@unique([sourceRowId, targetType, targetId])
  @@index([batchId, status])
  @@index([targetType, targetId])
}

model FinanceAllocationRun {
  id String @id @default(cuid())
  sourceBatchId String?
  sourceBatch FinanceImportBatch? @relation(fields: [sourceBatchId], references: [id], onDelete: Restrict)
  periodStart DateTime
  periodEnd DateTime
  status FinanceAllocationRunStatus @default(PREVIEW)
  totalInput Decimal @db.Decimal(14, 2)
  totalOutput Decimal @db.Decimal(14, 2)
  residual Decimal @db.Decimal(14, 2)
  inputFingerprint String
  failureCode String?
  createdById String
  createdBy User @relation("FinanceAllocationCreator", fields: [createdById], references: [id], onDelete: Restrict)
  committedAt DateTime?
  createdAt DateTime @default(now())
  lines FinanceAllocationLine[]
  @@unique([periodStart, periodEnd, inputFingerprint])
  @@index([periodStart, periodEnd, status])
}

model FinanceAllocationLine {
  id String @id @default(cuid())
  runId String
  run FinanceAllocationRun @relation(fields: [runId], references: [id], onDelete: Restrict)
  sourceType String
  sourceId String
  matterId String?
  matter Matter? @relation(fields: [matterId], references: [id], onDelete: Restrict)
  ruleVersionId String
  ruleVersion FinanceRuleVersion @relation(fields: [ruleVersionId], references: [id], onDelete: Restrict)
  kind FinanceAllocationLineKind
  beneficiaryUserId String?
  beneficiaryUser User? @relation("FinanceAllocationBeneficiary", fields: [beneficiaryUserId], references: [id], onDelete: Restrict)
  baseAmount Decimal @db.Decimal(14, 2)
  amount Decimal @db.Decimal(14, 2)
  note String?
  createdAt DateTime @default(now())
  @@index([runId, kind])
  @@index([matterId, beneficiaryUserId])
  @@unique([runId, sourceType, sourceId, kind, beneficiaryUserId])
}
```

在 `User` 和 `Matter` 增加与上述 relation 名称对应的反向字段；不要删除或重命名现有财务关系。对 `FinanceImportBatch`、`FinanceImportRow`、`FinanceReconciliationCase` 的删除策略统一为 `Restrict`，保证导入来源可追溯。

- [ ] **Step 5: Generate and validate the migration in an isolated database**

Run: `npx prisma format`  以及 `npm run prisma:validate`

Run against a disposable PostgreSQL database: `npx prisma migrate deploy`

Expected: schema validation succeeds; all new tables, indexes, unique constraints and foreign keys exist; the working database is not the existing LawLink preview or production database.

- [ ] **Step 6: Run focused tests and commit**

Run: `npm run test:run -- src/tests/lib/finance-internal-permissions.test.ts src/tests/lib/permissions.test.ts`

Expected: PASS.

Commit: `git add prisma src/lib/roles/catalog.ts src/tests/lib/permissions.test.ts src/tests/lib/finance-internal-permissions.test.ts && git commit -m "feat: add internal finance data boundaries"`

## Task 2: 实现纯函数金额规则引擎

**Files:**
- Create: `src/lib/finance/internal-types.ts`
- Create: `src/lib/finance/internal-rules.ts`
- Create: `src/tests/lib/finance-internal-rules.test.ts`

**Interfaces:**
- Consumes: `FinanceRuleVersion.definition` after Zod validation and confirmed `Payment` snapshots supplied by the server layer。
- Produces: `validateRuleDefinition()`、`calculateInternalAllocation()`、`assertAllocationInvariant()`。

- [ ] **Step 1: Write failing tests for the approved initial rules**

```ts
import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { calculateInternalAllocation, financeRuleDefinitionSchema } from "@/lib/finance/internal-rules";

const d = (value: string) => new Prisma.Decimal(value);

describe("内部财务分配规则", () => {
  it("渠道案件按 20/45/35 分成并保持金额守恒", () => {
    const result = calculateInternalAllocation({
      sourceId: "payment-1", matterId: "matter-1", grossAmount: d("100000.00"),
      origin: "CHANNEL", lawyerLevel: null,
      commissionPlans: [{ userId: "lawyer-1", percent: d("60") }, { userId: "lawyer-2", percent: d("40") }],
      rule: { channel: { channelPercent: "20", firmPercent: "45", lawyerPoolPercent: "35" }, residualRecipient: "FIRM" }
    });
    expect(result.lines.map((line) => [line.kind, line.amount.toFixed(2)])).toEqual([
      ["CHANNEL_COMMISSION", "20000.00"], ["FIRM_RETAINED", "45000.00"],
      ["LAWYER_POOL", "35000.00"], ["LAWYER_SHARE", "21000.00"], ["LAWYER_SHARE", "14000.00"]
    ]);
    expect(result.totalOutput.toFixed(2)).toBe("100000.00");
    expect(result.residual.toFixed(2)).toBe("0.00");
  });

  it("自拓案件按身份取规则比例，不能把比例写死在算法里", () => {
    const result = calculateInternalAllocation({
      sourceId: "payment-2", matterId: "matter-2", grossAmount: d("10000.00"),
      origin: "SELF_SOURCED", lawyerLevel: "INDEPENDENT_LAWYER", commissionPlans: [],
      rule: { selfSourced: { roleRates: { INDEPENDENT_LAWYER: "17.5" } }, residualRecipient: "FIRM" }
    });
    expect(result.lines.find((line) => line.kind === "FIRM_RETAINED")?.amount.toFixed(2)).toBe("1750.00");
    expect(result.lines.find((line) => line.kind === "NET_DISTRIBUTABLE")?.amount.toFixed(2)).toBe("8250.00");
  });

  it("拒绝比例超过 100%、缺失身份比例和负金额", () => {
    expect(() => financeRuleDefinitionSchema.parse({ channel: { channelPercent: "50", firmPercent: "60", lawyerPoolPercent: "0" }, residualRecipient: "FIRM" })).toThrow();
    expect(() => calculateInternalAllocation({ sourceId: "p", matterId: "m", grossAmount: d("-1"), origin: "CHANNEL", lawyerLevel: null, commissionPlans: [], rule: { channel: { channelPercent: "20", firmPercent: "45", lawyerPoolPercent: "35" }, residualRecipient: "FIRM" } })).toThrow("金额");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:run -- src/tests/lib/finance-internal-rules.test.ts`

Expected: FAIL because the rule module and exported functions do not exist.

- [ ] **Step 3: Define the pure types and versioned rule schema**

`src/lib/finance/internal-types.ts` 至少导出：

```ts
import { Prisma } from "@prisma/client";

export type DecimalLike = Prisma.Decimal;
export type AllocationOrigin = "CHANNEL" | "SELF_SOURCED" | "OTHER";
export type AllocationLineKind =
  | "CHANNEL_COMMISSION" | "FIRM_RETAINED" | "LAWYER_POOL" | "LAWYER_SHARE"
  | "ASSISTANCE_SHARE" | "REIMBURSEMENT" | "SOCIAL_INSURANCE" | "TAX_RESERVE"
  | "NET_DISTRIBUTABLE" | "UNALLOCATED";

export type AllocationInput = {
  sourceId: string;
  matterId: string;
  grossAmount: DecimalLike;
  origin: AllocationOrigin;
  lawyerLevel: string | null;
  commissionPlans: { userId: string; percent: DecimalLike }[];
  rule: unknown;
};

export type AllocationLine = {
  kind: AllocationLineKind;
  amount: DecimalLike;
  baseAmount: DecimalLike;
  beneficiaryUserId?: string;
  note?: string;
};

export type AllocationResult = {
  lines: AllocationLine[];
  totalInput: DecimalLike;
  totalOutput: DecimalLike;
  residual: DecimalLike;
};
```

`src/lib/finance/internal-rules.ts` 的 schema 必须约束所有比例为 0—100、最多两位小数；渠道三项合计不超过 100%；自拓身份必须能找到对应比例；`residualRecipient` 只允许 `FIRM` 或 `UNALLOCATED`。

- [ ] **Step 4: Implement Decimal-only allocation and invariant checks**

实现时使用以下算法边界：金额先 `toDecimalPlaces(2)`；比例乘法先保留 Decimal 精度；分配到人时按分向下取整，再按余数降序、`userId` 升序分配尾差；任何分配结果不得为负；`totalOutput + residual === totalInput`。

```ts
export function calculateInternalAllocation(input: AllocationInput): AllocationResult {
  const rule = financeRuleDefinitionSchema.parse(input.rule);
  if (!input.grossAmount.isFinite() || input.grossAmount.lt(0)) throw new ActionError("金额必须为非负数");
  const gross = input.grossAmount.toDecimalPlaces(2);
  const lines: AllocationLine[] = [];

  if (input.origin === "CHANNEL") {
    const channel = rule.channel;
    if (!channel) throw new ActionError("缺少渠道案件规则");
    const channelAmount = percentOf(gross, channel.channelPercent);
    const firmAmount = percentOf(gross, channel.firmPercent);
    const poolAmount = percentOf(gross, channel.lawyerPoolPercent);
    lines.push(line("CHANNEL_COMMISSION", channelAmount, gross));
    lines.push(line("FIRM_RETAINED", firmAmount, gross));
    lines.push(line("LAWYER_POOL", poolAmount, gross));
    lines.push(...allocatePool(poolAmount, input.commissionPlans));
  } else if (input.origin === "SELF_SOURCED") {
    const rate = rule.selfSourced?.roleRates[input.lawyerLevel ?? ""];
    if (rate === undefined) throw new ActionError("缺少当前律师身份的自拓案件规则");
    const firmAmount = percentOf(gross, rate);
    lines.push(line("FIRM_RETAINED", firmAmount, gross));
    lines.push(line("NET_DISTRIBUTABLE", gross.minus(firmAmount), gross));
  } else {
    lines.push(line("UNALLOCATED", gross, gross, "案件来源待确认"));
  }

  return finalizeAllocation(lines, gross, rule.residualRecipient);
}
```

具体实现必须补齐 `percentOf`、`allocatePool`、`finalizeAllocation` 和 `assertAllocationInvariant`，并让每个函数都返回 Decimal，不得把金额转换成 JavaScript `number`。

- [ ] **Step 5: Run focused tests and commit**

Run: `npm run test:run -- src/tests/lib/finance-internal-rules.test.ts src/tests/lib/finance-allocation.test.ts`

Expected: PASS; existing `finance-allocation` tests remain unchanged and continue通过。

Commit: `git add src/lib/finance/internal-types.ts src/lib/finance/internal-rules.ts src/tests/lib/finance-internal-rules.test.ts && git commit -m "feat: add versioned internal finance rules"`

## Task 3: 实现 CSV/XLS/XLSX 导入与标准化

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/lib/finance/import-parser.ts`
- Create: `src/tests/lib/finance-import-parser.test.ts`

**Interfaces:**
- Consumes: `File` 的字节、导入类型和用户选择的 canonical column mapping。
- Produces: `readFinanceWorkbook()`、`normalizeFinanceRows()`、`financeImportMappingSchema`，不访问数据库、不写文件。

- [ ] **Step 1: Add the workbook reader dependency**

Run: `npm install --save-exact xlsx@0.18.5`

Expected: `package.json` 和 `package-lock.json` 只增加 `xlsx`，不升级现有依赖；安装后 `npm ls xlsx` 显示 `xlsx@0.18.5`。

- [ ] **Step 2: Write parser tests for all supported file types**

```ts
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { normalizeFinanceRows, readFinanceWorkbook } from "@/lib/finance/import-parser";

const mapping = {
  occurredAt: "交易日期", amount: "金额", direction: "收支", counterparty: "对方户名",
  description: "摘要", accountRef: "流水号"
} as const;

describe("财务资料导入标准化", () => {
  it.each(["csv", "xlsx", "xls"] as const)("读取 %s 并统一上海日期与金额", (kind) => {
    const rows = [["交易日期", "金额", "收支", "对方户名", "摘要", "流水号"], ["2026-08-01", "1,234.50", "收入", "合成客户", "案件收款", "TX-1"]];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "流水");
    const bytes = kind === "csv" ? Buffer.from(XLSX.utils.sheet_to_csv(workbook.Sheets["流水"])) : Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: kind === "xls" ? "biff8" : "xlsx" }));
    const parsed = readFinanceWorkbook(`sample.${kind}`, bytes);
    const normalized = normalizeFinanceRows("BANK_STATEMENT", parsed, mapping);
    expect(normalized.errors).toEqual([]);
    expect(normalized.rows[0]).toMatchObject({ amount: "1234.50", direction: "IN", externalReference: "TX-1" });
  });

  it("拒绝缺失金额、非法方向、超大文件和公式结果", () => {
    expect(() => normalizeFinanceRows("BANK_STATEMENT", { headers: ["金额"], rows: [["-1"]] }, { amount: "金额" })).toThrow();
    expect(() => readFinanceWorkbook("bad.txt", Buffer.from("x"))).toThrow("仅支持");
  });
});
```

- [ ] **Step 3: Implement bounded workbook reading**

`readFinanceWorkbook(fileName, bytes)` 必须：

```ts
export function readFinanceWorkbook(fileName: string, bytes: Buffer): FinanceWorkbook {
  if (bytes.byteLength > 20 * 1024 * 1024) throw new ActionError("文件不能超过 20 MB");
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".csv") return parseCsv(bytes);
  if (ext !== ".xlsx" && ext !== ".xls") throw new ActionError("仅支持 CSV、XLSX 或 XLS 文件");
  const workbook = XLSX.read(bytes, { type: "buffer", cellFormula: false, cellHTML: false, cellNF: false, dense: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new ActionError("文件中没有工作表");
  const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "" });
  if (rows.length < 2 || rows.length > 20000) throw new ActionError("数据行数必须在 1—20000 行之间");
  return { headers: rows[0].map(String), rows: rows.slice(1).map(row => row.map(value => String(value ?? ""))) };
}
```

CSV 解析不能用 `split(",")`，要处理双引号、换行和 UTF-8 BOM。标准字段为 `occurredAt`、`amount`、`direction`、`counterparty`、`description`、`accountRef`、`externalReference`、`category`；映射中至少要求日期、金额和收支方向。方向只接受“收入/支出/收/付/入/出”及英文 `IN/OUT`。

- [ ] **Step 4: Implement normalization and fingerprints**

`normalizeFinanceRows()` 输出 `{ rows, errors, duplicateFingerprints }`；金额统一为字符串形式的两位小数，日期使用上海日键转成 UTC 边界，指纹由 `kind + occurredAt + amount + direction + accountRef + externalReference + description` 的规范化文本 SHA-256 生成。错误只能使用字段名和错误码，不把完整对方名称或摘要写入异常日志。

- [ ] **Step 5: Run parser tests and commit**

Run: `npm run test:run -- src/tests/lib/finance-import-parser.test.ts`

Expected: PASS for CSV/XLSX/XLS and all malformed-input tests。

Commit: `git add package.json package-lock.json src/lib/finance/import-parser.ts src/tests/lib/finance-import-parser.test.ts && git commit -m "feat: parse internal finance source files"`

## Task 4: 建立导入批次、私有原文件和 Server Actions

**Files:**
- Create: `src/server/finance/internal-schemas.ts`
- Create: `src/server/finance/internal-imports.ts`
- Create: `src/server/finance/internal-actions.ts`
- Create: `src/app/api/finance/imports/[id]/source/route.ts`
- Create: `src/tests/server/finance-internal-imports.test.ts`

**Interfaces:**
- `previewFinanceImport(formData: FormData): Promise<FinanceImportPreview>`：解析并校验，不写数据库，不写存储。
- `commitFinanceImport(formData: FormData): Promise<{ ok: true; batchId: string }>`：二次解析、哈希去重、写私有文件和事务落库。
- `listFinanceImportBatches(): Promise<FinanceImportBatchSummary[]>`：只返回财务用户可见的批次元数据。
- `downloadFinanceImportSource(id: string, userId: string): Promise<{ path: string; mimeType: string; name: string }>`：只返回已经过权限检查的元数据给 Route Handler。

- [ ] **Step 1: Write failing action tests**

测试 mock `@/lib/prisma`、`@/lib/storage`、`@/lib/auth/session`、`@/server/audit` 和 `next/cache`，覆盖：

```ts
it("预览不产生数据库或存储写入", async () => {
  const result = await previewFinanceImport(formDataFor("sample.xlsx"));
  expect(result.validCount).toBe(1);
  expect(db.financeImportBatch.create).not.toHaveBeenCalled();
  expect(storage.writeFile).not.toHaveBeenCalled();
});

it("同一 sha256 的已提交批次幂等返回原 batchId", async () => {
  db.financeImportBatch.findUnique.mockResolvedValue({ id: "batch-old", status: "COMMITTED" });
  await expect(commitFinanceImport(formDataFor("same.xlsx"))).resolves.toEqual({ ok: true, batchId: "batch-old" });
  expect(storage.writeFile).not.toHaveBeenCalled();
});

it("事务失败时删除已经写入的原文件", async () => {
  db.financeImportBatch.findUnique.mockResolvedValue(null);
  db.$transaction.mockRejectedValue(new Error("db failed"));
  await expect(commitFinanceImport(formDataFor("sample.xlsx"))).rejects.toThrow("db failed");
  expect(storage.deleteFile).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:run -- src/tests/server/finance-internal-imports.test.ts`

Expected: FAIL because the actions and Prisma model accessors do not exist.

- [ ] **Step 3: Implement server input schemas and preview**

`internal-schemas.ts` 至少导出：

```ts
export const financeImportKindSchema = z.enum(["BANK_STATEMENT", "PAYROLL", "EXTERNAL_STATEMENT"]);
export const financeImportMappingSchema = z.record(z.enum([
  "occurredAt", "amount", "direction", "counterparty", "description", "accountRef", "externalReference", "category"
]), z.string().min(1));
export const commitFinanceImportSchema = z.object({
  kind: financeImportKindSchema,
  mapping: financeImportMappingSchema,
  periodStart: z.coerce.date().optional(),
  periodEnd: z.coerce.date().optional()
});
```

`previewFinanceImport` 用 `requireSession("finance.import")`，读取 `File`、解析工作簿、执行标准化和数据库中的 fingerprint 查询；返回列名、可映射字段、逐行错误码、总数、有效数和重复数。预览结果不能返回完整原始行，只返回必要的字段值和行号。

- [ ] **Step 4: Implement atomic commit and private storage**

提交顺序固定为：读字节 → 解析并二次校验 → 计算 SHA-256 → 查询已提交同 hash → `storage.writeFile("finance-imports", bytes)` → Prisma transaction 创建 batch/rows → 审计。`storage.writeFile` 成功后任何数据库失败都必须调用 `storage.deleteFile(path)`；删除失败只记录无 PII 的错误代码并继续抛出原数据库异常。

批次只有在所有行有效或明确标记为已存在重复时才能进入 `COMMITTED`；含有字段错误的提交直接拒绝，不创建部分有效的正式批次。批次写入的 `counterparty` 和 `description` 仅供财务域权限用户查看。

- [ ] **Step 5: Implement protected source download route**

`route.ts` 用 `getServerSession(authOptions)` 校验登录，再用 `customOrLegacy(session.user, "finance.read", ...)` 或 `finance.import` 通过后读取批次。响应头使用 `Content-Disposition: attachment`，不得返回公开 URL；审计只写 batch id、文件类型和字节数。

- [ ] **Step 6: Run tests and commit**

Run: `npm run test:run -- src/tests/server/finance-internal-imports.test.ts`

Expected: PASS;预览无副作用、重复导入幂等、数据库失败可清理原文件。

Commit: `git add src/server/finance/internal-schemas.ts src/server/finance/internal-imports.ts src/server/finance/internal-actions.ts src/app/api/finance/imports src/tests/server/finance-internal-imports.test.ts && git commit -m "feat: add audited finance import batches"`

## Task 5: 实现确定性收款勾稽与差异工作流

**Files:**
- Create: `src/lib/finance/internal-matching.ts`
- Create: `src/tests/lib/finance-internal-matching.test.ts`
- Create: `src/server/finance/internal-reconciliation.ts`
- Modify: `src/server/finance/internal-actions.ts`
- Create: `src/tests/server/finance-internal-reconciliation.test.ts`

**Interfaces:**
- `rankPaymentCandidates(row, candidates): MatchSuggestion[]`：纯函数，返回分数、理由和是否允许自动建议。
- `suggestFinanceMatches(batchId): Promise<{ caseCount: number; suggestedCount: number }>`。
- `confirmFinanceMatch(input): Promise<{ ok: true; caseId: string }>`。
- `resolveFinanceException(input): Promise<{ ok: true }>`。

- [ ] **Step 1: Write matching tests before implementation**

```ts
it("同金额同上海日期优先于仅金额相同的候选", () => {
  const result = rankPaymentCandidates(row("2026-08-01", "100.00"), [
    payment("p-same-day", "2026-08-01", "100.00"),
    payment("p-window", "2026-08-03", "100.00")
  ]);
  expect(result[0]).toMatchObject({ paymentId: "p-same-day", confidence: "HIGH" });
});

it("同分候选不自动建议，进入 EXCEPTION", () => {
  const result = rankPaymentCandidates(row("2026-08-01", "100.00"), [
    payment("p-1", "2026-08-01", "100.00"), payment("p-2", "2026-08-01", "100.00")
  ]);
  expect(result.every((item) => item.autoConfirm === false)).toBe(true);
});

it("金额不同即使摘要相同也不能自动匹配", () => {
  expect(rankPaymentCandidates(row("2026-08-01", "100.01"), [payment("p", "2026-08-01", "100.00")])).toEqual([]);
});
```

- [ ] **Step 2: Implement deterministic candidate ranking**

候选规则固定为：金额精确相等且流水号/发票引用相同为 100 分；金额相等且同上海自然日为 90 分；金额相等且 ±3 上海自然日为 70 分；其余不产生候选。最高分唯一且至少 90 分才是 `SUGGESTED`，同分或目标已被其他已确认案例占用则是 `EXCEPTION`。不做模糊金额匹配，不根据客户姓名单独确认。

- [ ] **Step 3: Implement server query and transactional decisions**

候选只查询 `Payment` 的来源 `FeeEntry.confirmState = CONFIRMED`，并按 `Payment.moneyKind = LAWYER_FEE` 与财务可见范围过滤；不读取待确认收款。`confirmFinanceMatch` 使用 `finance.reconcile`，事务内检查案例仍为 `SUGGESTED/EXCEPTION`、目标未被其他案例占用，然后更新状态、审核人、审核时间和理由，不修改 `Payment`、`Receivable` 或原始流水金额。

`resolveFinanceException` 必须要求非空理由；`IGNORE` 和关闭差异都要写审计；重复请求使用 `where: { id, status: { in: [...] } }` 防止并发二次确认。

- [ ] **Step 4: Run tests and commit**

Run: `npm run test:run -- src/tests/lib/finance-internal-matching.test.ts src/tests/server/finance-internal-reconciliation.test.ts`

Expected: PASS;待确认实收不会出现在候选中，歧义候选不会自动确认。

Commit: `git add src/lib/finance/internal-matching.ts src/tests/lib/finance-internal-matching.test.ts src/server/finance/internal-reconciliation.ts src/server/finance/internal-actions.ts src/tests/server/finance-internal-reconciliation.test.ts && git commit -m "feat: add finance reconciliation workflow"`

## Task 6: 实现规则版本、案件来源档案和分配快照

**Files:**
- Create: `src/server/finance/internal-rules-actions.ts`
- Create: `src/server/finance/internal-allocation.ts`
- Create: `src/tests/server/finance-internal-rules.test.ts`
- Create: `src/tests/server/finance-internal-allocation.test.ts`
- Modify: `src/server/finance/internal-actions.ts`

**Interfaces:**
- `createFinanceRuleVersion(input): Promise<{ id: string; version: number }>`。
- `updateFinanceRuleVersion(id: string, input): Promise<{ ok: true }>`：仅允许更新 `DRAFT` 版本。
- `publishFinanceRuleVersion(id): Promise<{ ok: true }>`。
- `setFinanceMatterProfile(input): Promise<{ ok: true }>`。
- `previewInternalAllocation(input): Promise<AllocationPreview>`。
- `commitInternalAllocation(runId): Promise<{ ok: true; runId: string }>`。

- [ ] **Step 1: Write versioning and allocation tests**

```ts
it("已发布规则不能原地编辑，重叠生效期不能发布", async () => {
  db.financeRuleVersion.findFirst.mockResolvedValue({ id: "v1", status: "PUBLISHED", effectiveFrom: new Date("2026-01-01"), effectiveTo: null });
  await expect(publishFinanceRuleVersion("v2")).rejects.toThrow("生效期重叠");
  await expect(updateFinanceRuleVersion("v1", { effectiveTo: new Date("2026-12-31") })).rejects.toThrow("已发布规则不可修改");
});

it("缺少案件来源档案或律师分成方案时只允许预览，不允许提交", async () => {
  const preview = await previewInternalAllocation({ periodStart: start, periodEnd: end });
  expect(preview.blockingIssues).toEqual(expect.arrayContaining(["MISSING_MATTER_PROFILE", "MISSING_COMMISSION_PLAN"]));
  await expect(commitInternalAllocation("run-preview")).rejects.toThrow("存在未解决配置");
});

it("同一期间和来源快照重复提交是幂等的", async () => {
  db.financeAllocationRun.findFirst.mockResolvedValue({ id: "run-existing", status: "COMMITTED" });
  await expect(commitInternalAllocation("run-new")).resolves.toEqual({ ok: true, runId: "run-existing" });
});
```

- [ ] **Step 2: Implement rule CRUD with immutable published versions**

所有动作先 `requireSession("finance.rules")`，规则定义交给 `financeRuleDefinitionSchema`；新版本号按 rule set 内最大版本加一。发布前在同一事务中检查：规则集 active、`effectiveFrom < effectiveTo`、同一 rule kind 的 published 版本生效区间不重叠、比例和身份配置完整。发布写 `publishedById/publishedAt` 和审计，已经发布的行不提供 update/delete 动作。

- [ ] **Step 3: Implement matter origin profile actions**

`setFinanceMatterProfile` 使用 `finance.rules`，只保存 `matterId`、`origin`、`lawyerLevel`、可选 `channelLabel` 和内部说明；先确认案件存在且未删除，再使用 `upsert`。改变来源档案必须写审计；案件正文和客户字段不复制到财务表。

- [ ] **Step 4: Implement allocation preview and commit**

读取指定上海账期内的已确认 `Payment`，通过 `sourceEntry` 反查 `FeeEntry` 和 `Billing`，限定 `moneyKind = LAWYER_FEE`。对每笔收款加载 `FinanceMatterProfile`、有效规则版本和 active `CommissionPlan`，调用 Task 2 的纯函数。

预览创建 `FinanceAllocationRun(status=PREVIEW)` 和行快照；缺少案件档案、规则、分成方案或存在非法比例时记录 blocking issue，不能直接标记 `COMMITTED`。提交时用事务锁定 preview run，重新读取来源并重新计算，只有输入摘要未变化、没有 blocking issue 且 run 仍为 `PREVIEW` 才写入行并改为 `COMMITTED`。计算结果只追加，不改 `Payment` 或 `FeeEntry`。

- [ ] **Step 5: Run tests and commit**

Run: `npm run test:run -- src/tests/server/finance-internal-rules.test.ts src/tests/server/finance-internal-allocation.test.ts src/tests/lib/finance-internal-rules.test.ts`

Expected: PASS;规则不可变、缺配置阻断提交、重试幂等、历史快照不随新规则变化。

Commit: `git add src/server/finance/internal-rules-actions.ts src/server/finance/internal-allocation.ts src/server/finance/internal-actions.ts src/tests/server/finance-internal-rules.test.ts src/tests/server/finance-internal-allocation.test.ts && git commit -m "feat: persist internal finance allocation snapshots"`

## Task 7: 实现核对报表与 Excel 导出

**Files:**
- Create: `src/server/finance/internal-reports.ts`
- Create: `src/server/finance/internal-export.ts`
- Create: `src/app/api/finance/internal/export/route.ts`
- Create: `src/tests/server/finance-internal-reports.test.ts`

**Interfaces:**
- `getInternalFinanceSummary(input): Promise<InternalFinanceSummary>`。
- `getReconciliationQueue(input): Promise<ReconciliationQueue>`。
- `buildInternalFinanceWorkbook(input): Promise<Buffer>`。

- [ ] **Step 1: Write aggregation tests**

```ts
it("按案件、律师、月份汇总时只统计 COMMITTED 快照", async () => {
  db.financeAllocationRun.findMany.mockResolvedValue([
    committedRunWithLines({ month: "2026-08", amount: "100.00" }),
    previewRunWithLines({ month: "2026-08", amount: "999.00" })
  ]);
  const result = await getInternalFinanceSummary({ start, end, groupBy: "LAWYER" });
  expect(result.total).toBe("100.00");
});

it("财务导出权限不足时不生成工作簿", async () => {
  session.user.role = "LAWYER";
  await expect(buildInternalFinanceWorkbook({ start, end })).rejects.toThrow("无权");
});
```

- [ ] **Step 2: Implement report queries**

所有查询只接受 `start/end`、`matterId?`、`userId?`、`kind?` 等 Zod 参数；只读取 `FinanceAllocationRun.status = COMMITTED`、`FinanceReconciliationCase.status != IGNORED` 和 `FinanceImportBatch.status = COMMITTED`。输出按案件、律师、渠道、月份和差异状态聚合，金额用 Decimal 字符串返回给页面。

- [ ] **Step 3: Implement Excel workbook and protected route**

工作簿固定包含“导入批次”“银行流水勾稽”“案件分配”“律师结算”“外部账表差异”五个 sheet。第一行写中文表头，金额列使用 `#,##0.00`，日期使用 `shDayKey`，不把原始完整银行账号写入导出。Route Handler 使用 `finance.export`，审计记录期间、筛选条件、字节数和当前用户，不记录客户名称或摘要全文。

- [ ] **Step 4: Run tests and commit**

Run: `npm run test:run -- src/tests/server/finance-internal-reports.test.ts`

Expected: PASS;预览/失败批次不进入结果，导出无权拒绝，工作簿 sheet 与中文表头固定。

Commit: `git add src/server/finance/internal-reports.ts src/server/finance/internal-export.ts src/app/api/finance/internal/export src/tests/server/finance-internal-reports.test.ts && git commit -m "feat: export internal finance reconciliation reports"`

## Task 8: 增加财务域页面和现有财务入口

**Files:**
- Create: `src/app/(app)/finance/_components/internal-finance-links.tsx`
- Create: `src/app/(app)/finance/imports/page.tsx`
- Create: `src/app/(app)/finance/imports/_components/import-workspace.tsx`
- Create: `src/app/(app)/finance/firm-reconciliation/page.tsx`
- Create: `src/app/(app)/finance/firm-reconciliation/_components/firm-reconciliation-workspace.tsx`
- Create: `src/app/(app)/finance/rules/page.tsx`
- Create: `src/app/(app)/finance/rules/_components/rules-workspace.tsx`
- Create: `src/app/(app)/finance/internal-ledger/page.tsx`
- Create: `src/app/(app)/finance/internal-ledger/_components/internal-ledger-workspace.tsx`
- Modify: `src/app/(app)/finance/page.tsx`
- Create: `src/tests/app/finance-internal-workspaces.test.tsx`

**Interfaces:**
- Server pages use `requireSession("finance.read")` before loading any finance-domain data。
- Client workspaces receive serialized Decimal strings and explicit `canImport`、`canReconcile`、`canManageRules`、`canExport` flags。

- [ ] **Step 1: Write component tests for permissions and empty states**

```tsx
it("没有导入权限时不渲染上传按钮", () => {
  render(<ImportWorkspace batches={[]} canImport={false} />);
  expect(screen.queryByRole("button", { name: "上传并预览" })).not.toBeInTheDocument();
});

it("空批次显示中文引导而不是假数据", () => {
  render(<ImportWorkspace batches={[]} canImport={true} />);
  expect(screen.getByText("暂无财务导入批次")).toBeInTheDocument();
});
```

- [ ] **Step 2: Implement upload preview and mapping flow**

上传界面先选择资料类型，再上传文件；解析返回的表头进入列映射步骤；只有日期、金额、收支方向映射完成且所有行无阻断错误时才显示“提交导入”。预览表只展示行号、日期、金额、方向、错误状态和必要摘要；提交动作再次上传并由服务端重新解析，不信任客户端预览。

- [ ] **Step 3: Implement reconciliation workspace**

页面默认显示待处理案例，提供“接受建议”“改选目标”“标记疑点”“忽略并说明”四种动作；每行显示匹配理由、金额差额、来源批次和流水行号，不展示未授权案件正文。确认动作成功后刷新队列，不使用原生 `confirm/alert/prompt`。

- [ ] **Step 4: Implement rules and internal ledger workspaces**

规则页面只允许财务规则权限用户创建草稿、查看版本、发布版本；已发布版本显示只读徽标。内部账页面支持账期、案件、律师、来源和分配类型筛选，显示“预览/已提交/存在阻断项”状态；所有金额来自服务器快照，不在客户端重算。

- [ ] **Step 5: Add links without changing existing finance view semantics**

在现有 `FinancePage` 的 `FinanceViewV4` 上方增加 `InternalFinanceLinks`，只根据 `finance.read` 渲染入口；原有案件财务指标、待确认实收和 `/finance/reconciliation` 的案件应收分配保持不变。

- [ ] **Step 6: Run UI tests and commit**

Run: `npm run test:run -- src/tests/app/finance-internal-workspaces.test.tsx`

Expected: PASS;无权限用户看不到写操作，空状态无假数据，中文按钮和错误提示完整。

Commit: `git add src/app/(app)/finance src/tests/app/finance-internal-workspaces.test.tsx && git commit -m "feat: add internal finance workspaces"`

## Task 9: 操作文档、回归验证和合成数据验收

**Files:**
- Create: `docs/FINANCE-INTERNAL-OPERATIONS.md`
- Create: `src/tests/server/finance-internal-acceptance.test.ts`
- Modify: `docs/PRD.md`（仅补充已实现的第一期入口和边界，不写未来承诺）

- [ ] **Step 1: Add a synthetic end-to-end acceptance fixture**

测试使用以下固定合成事实：一笔 100000.00 元渠道案件已确认收款、两名律师分成计划 60%/40%、20/45/35 规则、同日银行收入 100000.00 元、一笔同金额不同日支出。断言导入幂等、收款唯一建议、分配金额 100000.00 守恒、支出进入差异队列、预览 run 不进入报表、提交 run 可导出。

- [ ] **Step 2: Write the operations document**

文档说明导入模板字段、日期和金额口径、重复导入处理、建议匹配的依据、人工差异处理、规则版本发布、导出权限和“第一期不等同法定三表”的边界。不得写真实客户、账号、服务器密码或测试数据。

- [ ] **Step 3: Run the complete verification suite**

Run in order:

```powershell
npm run test:run
npm run lint
npm run typecheck
npm run prisma:validate
npm run build
```

Expected: all commands exit 0；测试输出不出现真实业务数据或密码；生产数据库和 170 VPS 不被连接或修改。

- [ ] **Step 4: Review the final diff and commit documentation**

Run: `git diff --check HEAD~1..HEAD`、`git status --short --branch`、`rg -n "Sofos@|BEGIN .*PRIVATE KEY" docs src/tests`

Expected: 没有密钥和真实业务数据；预存的 `next-env.d.ts` 仍保持未提交，不出现在财务功能提交中。

Commit: `git add docs/FINANCE-INTERNAL-OPERATIONS.md docs/PRD.md src/tests/server/finance-internal-acceptance.test.ts && git commit -m "docs: document internal finance operations"`

## 执行顺序与检查点

按 Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 顺序执行。每个 Task 单独提交并运行该 Task 的聚焦测试；Task 1 的 Prisma 迁移和 Task 6 的财务快照在独立测试数据库中演练后，才允许进入 UI。

第一阶段完成后，必须由用户和外部财务老师共同核对至少一个月的合成/脱敏账：银行收入、LawLink 已确认收款、内部三层分配和外部三表差异逐项解释清楚，再决定是否单独设计正式总账域。
