# 财务资料导入补全实施计划

> **执行约定：** 按 TDD 顺序逐项执行。所有测试使用合成数据；真实资料只在本机受控暂存区与授权的 170 预览环境处理。不要把真实行、文件名、账户、人员、案件或金额写入 Git、测试、截图或普通日志。

**设计依据：** `docs/superpowers/specs/2026-09-25-law-firm-finance-completion.md`

## 当前代码与最小改动边界

- `src/server/finance/internal-imports.ts` 已有 SHA-256/来源类型去重、私有附件写入、事务写批次/行/审计；预览不写入。
- `src/lib/finance/import-parser.ts` 已解析银行 CSV/XLSX；`typed-import-utils.ts` 与薪资、花名册、外账解析器当前只取一个工作表，旧 XLS 明确不支持。
- `FinanceImportRecord` 与 `FinanceSourceRow` 以 `[batchId, sourceRow]` 唯一；需要补工作表维度，不能将多表行号合并或伪造。
- 本次 11 份 PDF 均已有可抽取的数字文本与表格；必须先走 PDF 表格抽取。OCRmyPDF/Tesseract 只作为无文本层页面的本地隔离回退，不为当前数字版 PDF 强行 OCR。
- 复用现有导入页面、权限、原件存储和审计；不创建案件/客户/员工、收付款或法定凭证。

## 任务 1：先为多工作表和来源定位写失败测试

**文件：** `src/tests/lib/finance-import-parser.test.ts`、新建 `src/lib/finance/import-mapping.ts`、新建 `src/lib/finance/pdf-table-parser.ts`、新建 `src/tests/lib/finance-typed-import.test.ts`、新建 `src/tests/lib/finance-pdf-parser.test.ts`。

1. 用 ExcelJS 在测试中生成两张表、非首行表头、格式化尾列的合成 xlsx；先增加测试，断言薪资/花名册/外账/银行解析都保留 `sourceSheet` 与工作表内真实行号。
2. 增加合成表头映射测试：默认别名能自动建议列；显式映射优先；缺期间、金额或必需字段时报可读错误而非猜测。
3. 增加纯字段映射建议/显式映射测试；增加 PDF 表格/ OCR 候选测试：PDF 页码进入来源定位；OCR 候选带页码、词框和置信信息，但不能转成可提交银行事实。
4. 先运行 `npm run test:run -- src/tests/lib/finance-import-parser.test.ts src/tests/lib/finance-typed-import.test.ts src/tests/lib/finance-pdf-parser.test.ts`，确认新断言因尚无多表/映射能力而失败。

## 任务 2：为工作表级行身份添加向后兼容迁移

**文件：** `prisma/schema.prisma`、`prisma/migrations/20260925000001_finance_source_sheet_and_mapping_template/migration.sql`、`src/lib/finance/internal-types.ts`、`src/server/finance/internal-import-review.ts`、相关测试。

1. 先在 `finance-internal-imports.test.ts` 与 `finance-internal-import-review.test.ts` 写失败测试：同一批次不同 sheet 的第 2 行能同时保存、列表显示 sheet+行号；旧记录使用空 sheet 名且继续可读。
2. 在 `FinanceSourceRow` 与 `FinanceImportRecord` 新增非空 `sourceSheet`，数据库默认值为空字符串；把复合唯一键改为 `[batchId, sourceSheet, sourceRow]`。迁移只加列/索引，保留既有行与批次，不重建、不清空数据。
3. 解析类型、Review DTO 和界面显示都增加 `sourceSheet`；不存在 sheet 的旧记录仍显示原行号。
4. 新增 `FinanceImportMappingTemplate`：`id`、`kind`、`headersDigest`、仅含系统字段到列索引的 `mapping` JSON、`createdById` 和时间戳；`[kind, headersDigest]` 唯一。另在 `User` 增加反向关系。表内不保存原始表头、行值或文件名。
5. 运行 `npm run prisma:validate`、`npm run prisma:generate` 及上述两组 Vitest。

## 任务 3：解析全部工作表并支持显式字段映射

**文件：** `src/lib/finance/typed-import-utils.ts`、`src/lib/finance/import-parser.ts`、`src/lib/finance/payroll-parser.ts`、`src/lib/finance/roster-parser.ts`、`src/lib/finance/external-statements-parser.ts`、`src/lib/finance/finance-source-parser.ts`、`src/lib/finance/internal-types.ts`、新建 `src/lib/finance/import-mapping.ts` 及其测试。

1. 让工作簿读取返回有界的 sheet/header/row 结构（使用 ExcelJS 实际 populated cells；不按虚报的 maxColumn 扫描空白列）。每个来源行保留原工作表名和物理行号。
2. 实现纯函数 `suggestFinanceColumnMapping(kind, headers)` 与 `applyFinanceColumnMapping(table, mapping)`；映射键为系统字段，值为列索引。默认别名只作为建议，必需字段缺失、日期/金额无效时阻止该行进入可提交集合。
3. 每张表分别识别银行、工资、花名册、外部三表；不兼容 sheet 产生明确的未识别项，不默默忽略。工资申报额、实际现金、个人成本及花名册截至日继续区分未知与零。
4. 为重复导入保留现有 `(SHA-256, kind)` 幂等；类型化行指纹改用 `STORAGE_ENCRYPTION_KEY` 域分隔 HMAC，按姓名及业务字段识别语义重复，不纳入工作表/行号，也不保存可字典反查的姓名哈希。
5. 运行 `npm run test:run -- src/tests/lib/finance-import-parser.test.ts src/tests/lib/finance-typed-import.test.ts`，确认先前 RED 测试通过。

## 任务 4：建立无数据库、无公网端口的文件预处理工作者

**文件：** `services/finance-preprocessor/Dockerfile`、`services/finance-preprocessor/requirements.txt`、`services/finance-preprocessor/app.py`、`services/finance-preprocessor/tests/test_app.py`、`services/finance-preprocessor/README.md`、`docker-compose.yml`、`.env.example`、`src/server/finance/finance-preprocessor-client.ts`、`src/tests/server/finance-preprocessor-client.test.ts`。

1. 预处理接口仅接受 `POST /v1/preprocess` 原始文件 body，使用 `Authorization: Bearer <token>`、base64url 的 `X-Source-Name-Base64` 与 `X-Source-Kind`；XLS 成功返回 XLSX bytes，PDF 返回 `{version, pages:[{pageNumber,tables,extraction,ocrWords}]}` JSON。用独立 token、25 MiB 大小、受限文件名和允许的来源类型校验。健康检查不泄密；拒绝路径、伪造扩展名、损坏/加密文件与超限页数。
2. XLS 使用 LibreOffice headless 在一次性临时目录转换为 XLSX；PDF 先以 pdfplumber 提取数字文本表格；仅在页面没有可用文本表格时调用 OCRmyPDF/Tesseract `chi_sim`，返回页码、表格及词级文字/置信度/坐标。若 OCR 后仍不能提取稳定表格，则阻止结构化提交，显示“人工整理后再导入”；不得凭空拼成银行交易行。OCR 内容始终是待复核候选。
3. 固定 Python/系统包版本并记录各组件上游与许可证（LibreOffice、OCRmyPDF、Tesseract、pdfplumber）；设置单任务、内存/CPU/PID、临时空间、页数、总时长限制，完成/异常均清除任务目录。Docker Compose 用 `finance-preprocessor` profile 与 `internal: true` 专用网络；工作者无数据库环境变量、不挂载持久数据、不映射 host 端口，只通过该网络供 app 调用。
4. TypeScript 客户端在预览阶段调用工作者，永不记录 body、token、完整文件名或 webhook/原件路径；未配置工作者时对 XLS/PDF 明确返回“预处理不可用”，不假装成功。预览行来源定位编码为 sheet 名或 `PDF第N页-表M` 与该表物理行号。
5. 增加合成 PDF/XLS 输入的 Python unittest 与客户端错误/超时/权限测试；先运行 `docker compose --profile finance-preprocessor build finance-preprocessor`、`docker compose --profile finance-preprocessor run --rm finance-preprocessor python -m unittest discover -s tests` 和 `npm run test:run -- src/tests/server/finance-preprocessor-client.test.ts`，通过后再连接解析器。

## 任务 5：把映射、预处理、预览与事务提交接入现有流程

**文件：** `src/server/finance/internal-imports.ts`、`src/server/finance/internal-schemas.ts`、`src/server/finance/internal-import-review.ts`、`src/app/api/finance/internal/imports/preview/route.ts`、`src/app/api/finance/internal/imports/commit/route.ts`、新建 `src/app/api/finance/internal/imports/mappings/route.ts`、`src/app/(app)/finance/internal/_components/import-workspace.tsx`、`src/app/(app)/finance/internal/_components/types.ts`、`src/tests/server/finance-internal-imports.test.ts`、新建 `src/tests/server/finance-import-mappings.test.ts`、`src/tests/app/finance-internal-workspaces.test.tsx`。

1. 先写失败集成测试：映射仅用于本次预览/提交；未处理硬错误时不可提交；多 sheet 行身份进入批次；预览不写 DB/存储；事务失败会清理刚写原件；银行仍仅建待认领行；类型化行保持 `NEEDS_REVIEW`。
2. 预览返回每张表的表头/列映射建议、期间候选、计数、逐页/逐表未识别原因和受权限保护的脱敏样例。PDF 页码与工作表行号均可追溯；工资/花名册预览中的姓名必须实际掩码。类型化复核列表只在 `finance.read` 范围内返回已归档来源姓名，且只供人工关联，不自动匹配账号。映射模板仅保存来源类型、规范化表头指纹和字段到列索引，不保存行值或原件内容。
3. 增加管理员可复用/删除的映射模板端点：只用 `[kind, normalizedHeadersDigest]` 查找；只保存字段到列索引，写入/删除都校验 `finance.import`、事务审计并可追溯操作者。用户可在预览中改字段映射，重新预览后才能提交。
4. UI 扩展 XLS/PDF 上传提示、sheet/页码、映射选择、错误与重复批次提示；原件仍只通过已有独立授权下载，不把原件嵌入页面。
5. 执行 `npm run test:run -- src/tests/server/finance-internal-imports.test.ts src/tests/server/finance-internal-import-review.test.ts src/tests/app/finance-internal-workspaces.test.tsx`、`npm run typecheck`、`npm run prisma:validate`。

## 任务 6：案件登记清单只读差异比对

**文件：** 新建 `src/lib/finance/case-register-reconciliation.ts`、新建 `src/app/api/finance/internal/imports/case-register-preview/route.ts`、`src/app/(app)/finance/internal/_components/import-workspace.tsx`、新建 `src/tests/lib/finance-case-register-reconciliation.test.ts`、新建 `src/tests/server/finance-case-register-preview.test.ts`。

1. 先写合成 XLSX 测试：读取用户提供的合同/所内案号清单表头映射，和现有 Matter/合同编号只按精确标准化编号比对，生成仅内存的“系统有/清单有/字段不一致”计数与差异行。
2. API 仅允许财务导入权限，文件大小/扩展名校验；不存附件、不创建或更新 Matter、客户、合同、Billing、Invoice、Payment，不把差异清单写入库。审计只记操作者、总数与差异计数，不记编号、客户或案件名。
3. 页面提供映射、预览和脱敏结果；差异详情按现有保密权限裁剪。重新访问需重新选择来源文件。
4. 运行 `npm run test:run -- src/tests/lib/finance-case-register-reconciliation.test.ts src/tests/server/finance-case-register-preview.test.ts src/tests/app/finance-internal-workspaces.test.tsx`。

## 任务 7：部署前真实来源本地清点与 170 预览导入

**文件：** 新增仅在本机暂存目录使用的 `scripts/finance-import-private-staging.ts`；不得将原件、清单文件名、明文记录或导入报告加入仓库。

1. 使用本机受控临时目录（不固定用户名路径、不可提交至仓库），读取本地文件时只输出按扩展名/来源类型的数量、页数/行数、期间候选、重复/错误计数；禁止输出文件名和行内容。
2. 对 34 个既有已归档来源按 hash/kind 对账；旧 `OTHER` 留存，新类型化批次追加，不覆盖、不删除。不确定来源类型/期间的资料只列为阻断待处理，不擅自猜测。
3. 170 部署前按共享 VPS 规则检查登记 SSH 别名、数据库与附件备份、迁移回滚点；先在 170 预览端逐批预览，只有可无歧义解析的来源才追加为待复核批次；所有原件继续私有保存。
4. 导入后以无敏感内容的统计校验批次数、类型、行数、重复数、错误数、`NEEDS_REVIEW`/待认领数、审计数；确认既有批次仍在且银行来源没有变成已确认收款。
5. 只在本机打印聚合清单；临时传输副本验证系统私有原件写入成功后做精确路径复核与清理，并报告保留范围。数据恢复/导入计数未核验前不称“全部导入完成”。

## 最终验收

`docker compose --profile finance-preprocessor build finance-preprocessor`；`docker compose --profile finance-preprocessor run --rm finance-preprocessor python -m unittest discover -s tests`；`npm run test:run -- src/tests/lib/finance-import-parser.test.ts src/tests/lib/finance-typed-import.test.ts src/tests/lib/finance-case-register-reconciliation.test.ts src/tests/server/finance-preprocessor-client.test.ts src/tests/server/finance-case-register-preview.test.ts src/tests/server/finance-internal-imports.test.ts src/tests/server/finance-internal-import-review.test.ts src/tests/app/finance-internal-workspaces.test.tsx`；`npm run typecheck`；`npm run prisma:validate`；`npm run lint`。最后在 170 预览站做受控真实预览/导入并检查外部健康请求、审计、私有存储与回滚点。
