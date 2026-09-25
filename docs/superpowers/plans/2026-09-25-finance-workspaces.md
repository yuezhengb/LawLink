# 律所财务工作区补全实施计划

> **执行约定：** 仅复用 `COMMITTED` 计算快照与现有财务事实；草稿/导入候选不得被呈现为已确认金额。所有演示和自动化样本均为合成数据。

**设计依据：** `docs/superpowers/specs/2026-09-25-law-firm-finance-completion.md`

## 当前代码与边界

- `src/server/finance/internal-reports.ts` 的 `getInternalFinanceSummary()` 已校验财务查看权限，只读 `COMMITTED` 批次，并提供律所/律师/项目视角。
- `src/server/finance/internal-export.ts` 的 `buildCloseWorkbook("PERSONAL", runId)` 目前把所有律师写入一份个人双余额表；月结总包继续保留，不改分成规则。
- `FinanceSourceRow` 有对方指纹、方向、金额和认领关系；透视必须区分银行来源总额与已确认案件收款，不能按相似名称合并。

## 任务 1：先写资金总览与往来单位查询失败测试

**文件：** 新建 `src/tests/server/finance-internal-workspaces.test.ts`、扩展 `src/tests/app/finance-internal-workspaces.test.tsx`。

1. 用合成数据测试无正式快照、成本未登记、待认领资金、存在正式快照四种状态。无快照/未知成本必须显示“未生成/待核对”，不得呈现为金额零。
2. 对同名但不同 `counterpartyDigest` 的合成往来单位，测试结果分开；测试银行来源金额与已确认款项是独立字段且不会双计。
3. 测试分页/期间筛选、收付方向筛选、普通律师/无权用户不可读全所透视。
4. 运行 `npm run test:run -- src/tests/server/finance-internal-workspaces.test.ts src/tests/app/finance-internal-workspaces.test.tsx`，确认新增断言在实现前失败。

## 任务 2：实现只读资金经营总览与往来单位透视

**文件：** `src/server/finance/internal-workspaces.ts`、`src/server/finance/internal-reports.ts`（仅在需要时）、新增 `src/app/(app)/finance/internal/counterparties/page.tsx`、`src/app/(app)/finance/internal/_components/counterparty-workspace.tsx`、`src/app/(app)/finance/internal/_components/types.ts`、`src/app/(app)/finance/internal/_components/internal-finance-nav.tsx`。

1. 新增 `getInternalFinanceOverview(period, actor)`，组合原月结状态与 `getInternalFinanceSummary()`；只显示已提交批次的律师费收入、律所留存、律师分配和已有成本/经营结果，并单独标记银行来源、已认领、开票和外部三表口径。
2. 没有快照显示无正式快照；`operatingResult` 或成本覆盖为 null 时显示待核对/未登记，不以 `0` 代替未知；案件标的额不并入收入。
3. 新增 `listFinanceCounterparties({period,direction,status,page,pageSize}, actor)`，在服务端校验 `finance.read` 全局范围，按 digest 聚合，使用数据库分页；展示字段按既有财务权限裁剪，不返回账号、原始摘要或未经授权姓名。
4. 每个透视项分别返回银行来源笔数/金额、未认领笔数/金额和可追踪的已确认款项数/金额；确认态从既有认领关系读取，不由名称/金额推断。
5. 在工作区导航和页面引入上述数据；新增空态、筛选、翻页和来源口径说明。
6. 运行 RED 测试转 GREEN：`npm run test:run -- src/tests/server/finance-internal-workspaces.test.ts src/tests/app/finance-internal-workspaces.test.tsx`，并运行 `npm run typecheck`。

## 任务 3：律师个人结算工作簿与受限 ZIP

**文件：** 新建 `src/server/finance/personal-settlement.ts`、新建 `src/app/api/finance/internal/personal-settlements/route.ts`、扩展 `src/tests/server/finance-close-workbooks.test.ts`、新建 `src/tests/server/finance-personal-settlements.test.ts`。

1. 先写失败测试：正式 `runId` 可为单名合成人员生成工作簿；工作簿只含此人快照/分配，不含另一人的姓名、金额或项目；PREVIEW/不存在批次拒绝；ZIP 成员一人一份并有期间、批次、指纹 manifest。工作簿数据通过 ExcelJS 解析断言，不检查原始 ZIP 字节文本。
2. 实现 `buildLawyerSettlementWorkbook(runId, userId, actor)`，校验该批次 `COMMITTED`、指定人员存在于该快照；仅读取/过滤已批准该人员的正式分配与余额，工作簿标注期间、批次、来源指纹与待复核项。
3. 权限：FINANCE 或具有 `finance.export:ALL` 的自定义财务角色可生成全体 ZIP；个人 scope 只能为当前登录者生成自己的文件；客户端传他人 ID 必须被拒绝。所有下载写审计，仅记批次/范围/行数和字节数，不记文件内容。
4. 实现 `buildLawyerSettlementZip(runId, actor)`，将每位律师独立 XLSX 打包；已有月结 `PERSONAL` 工作簿和 CLOSE ZIP 的既有使用保持兼容。
5. route 校验输入、权限、`Cache-Control: private, no-store` 与文件名；加测试确保无法通过 URL 横向越权。
6. 运行 `npm run test:run -- src/tests/server/finance-close-workbooks.test.ts src/tests/server/finance-personal-settlements.test.ts`、`npm run typecheck`。

## 任务 4：页面接线、权限与回归

**文件：** `src/app/(app)/finance/internal/page.tsx`、`src/app/(app)/finance/internal/_components/internal-finance-nav.tsx`、`src/app/(app)/finance/internal/_components/ledger-workspace.tsx`（若需要）、`src/tests/app/finance-internal-workspaces.test.tsx`、`src/tests/server/finance-internal-workspaces.test.ts`。

1. 把首页从单纯月结状态卡扩展为本期资金概览；数额仅取正式快照/登记事实，明确展示期间、来源口径和未知状态。
2. 添加律师结算入口；根据当前用户权限传递范围，服务端仍独立重新授权。
3. 添加往来单位工作区入口，确保权限不足时服务端 403/页面重定向，不只依赖隐藏按钮。
4. 运行 `npm run test:run -- src/tests/server/finance-internal-workspaces.test.ts src/tests/server/finance-internal-reports.test.ts src/tests/server/finance-close-workbooks.test.ts src/tests/server/finance-personal-settlements.test.ts src/tests/app/finance-internal-workspaces.test.tsx`、`npm run typecheck`、`npm run lint`。

## 验收

金额按正式快照与现有来源分别汇总；空态不伪造零；不同指纹不合并；普通用户无法读全所透视或导出他人结算；老月结导出不回归；所有 UI 使用合成样本测试。真实数据/生产数据库不得用于快照测试。
