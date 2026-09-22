# LawLink 产品需求文档（PRD）

> 2026-09-19 业务流程修复已获确认，当前增量规则以 [修复方案](BUSINESS-WORKFLOW-REPAIR-PLAN-20260919.md) 为准：应收与核销统一、合同变更分类、财务更正、收案轮次、责任交接、动态冲突复核和归档收尾。先实施无需迁移的批次 0；A/B 共同设计后依次实施，旧账核对通过前不切换正式统计。顾问续约/成果交付后置。此为批准的目标范围，不代表全部已实现；数据库迁移须另行批准。

> **公开版本阅读入口（2026-09-13）**：当前 v1.3.x 功能与首次配置以[本版使用与升级说明](./RELEASE-GUIDE-v1.3.md)为准，字段以同标签 `prisma/schema.prisma` 和迁移文件为准。本文保留历史设计章节，章内 `ADMIN`、旧 `/settings/*`、按岗位直接审批等描述均不作为当前授权规则。原始版本号和当时验证状态只说明对应阶段，不代表本文全部已与本版同步。

## v1.3.x 当前差异摘要

- 系统管理使用 `SystemRole.SUPER_ADMIN`，业务岗位与审批权限组各自独立；超级管理员无业务/审批自动授权。
- 管理入口为 `/admin/*`，个人资料为 `/settings/profile`，统一审批为 `/approvals`。
- 岗位、常设团队、案件成员、事项审批分别决定各自范围；团队只读不扩大财务、下载或写入权限。
- 新增人员身份与证件照片管理；归档固定本所制度、材料快照和审阅结论。
- 当前说明不包含后续 P0/P1 与 v4 界面开发；下方按版本保留演进记录。

## 2026-09 内部经营财务闭环：已实现入口与边界

当前代码已增加一条与案件应收分离的内部经营财务工作线，入口为 `/finance/internal` 及其子路径：来源资料归档、人工认领与退款关联、版本化分成规则、正式计算快照、人员/项目/律所三视角、工资/税款/资本事实、月结阻断项、追加调整/冲销和受保护交付文件。所有关键写入和敏感下载均保留审计记录，来源文件与导出文件不进入 Git。

该工作线只输出律所内部经营管理核对结果，不替代法定会计账簿、纳税申报或外部财务老师的申报口径；原有 `/finance` 案件应收、收款分配和开票语义不变。当前迁移需在独立测试数据库演练并经负责人确认后再连接实际资料，合成验收不代表生产数据已经导入或口径已经完成确认。

---

> 版本：v0.5（程序优先收案 + 案件详情按程序为本位 + 发票工作流）
> 最后更新：2026-05-23
> 状态：已与叶森确认
>
> v0.5 变化：① 收案表单按"类别→程序→诉讼地位"联动，新增委托方性质/联系人/争议解决机构/标的额/律师费(5 种收费模式)/主办+共同律师 字段；删除"案源"字段。② 案件详情 tab 重构：基本信息（卡片墙，含合同+团队+近期日程）/ 案件资料（任务+沟通+材料+财务）/ 每个 ENGAGED 程序一个 tab / 时间线。③ 团队事后可编辑（主办+协办+助理）。④ 新增发票申请工作流（律师申请时上传开票依据，财务处理时查看申请信息和附件、批准/驳回并上传电子发票）。⑤ Sidebar logo 链首页；Bell 占位 toast；UI 视觉打磨（卡片墙、tab indicator、玻璃光晕）。⑥ LitigationStanding 枚举扩展，加上诉人/被上诉人/再审申请人/被申请人/申请执行人/被执行人 等。
>
> v0.4 变化：收案合并入"案件管理"按状态分 tab；利益冲突改为顶栏/首页工具按钮，不再占一级菜单；材料库不再单独菜单，材料随案件；收案表单委托方支持自由输入并自动建档；标题非必填可自动生成；收案支持合同上传 + 管理员/主任律师审批工作流；新增亮色主题切换。
>
> v0.3 变化：案件类型按民商事/刑事/行政三大体系区分；案由从规范案由库选择；新建案件抽屉字段按类型联动。

---

## 一、产品愿景

**给独立律师和小律所一个不臃肿、视觉舒服、能真正用起来的案件/项目管理系统。**

不和 iManage、华宇案管、Alpha 案管等大型律所产品比"全"，比的是：

- **开源自部署**：数据在律所自己服务器，不被 SaaS 厂商绑架。
- **现代视觉**：深色科技感，不是 Windows XP 风格的传统律所软件。
- **聚焦主线**：收案 → 跟进 → 结案 → 归档，每一步真有用，不是为了功能堆砌。
- **可拓展**：后续接元典 MCP、AI 摘要、向量检索都留好口子。

---

## 二、用户角色与典型场景

### 2.1 角色定义

| 角色 | 中文名 | 典型权限 | 数量级 |
|---|---|---|---|
| `PRINCIPAL_LAWYER` | 合伙人（原主办律师） | 全部案件可见，可分案 | 1-5 人 |
| `INDEPENDENT_LAWYER` | 独立律师 | 自己 + 团队案件可见，不可分案；权限与授薪律师一致 | 0-10 人 |
| `LAWYER` | 授薪律师（原经办律师） | 自己 + 团队案件可见，不可分案；可查看自己可见范围内的财务流水、分成和开票申请 | 3-20 人 |
| `ASSISTANT` | 律师助理 | 按案件成员授权可见，可录入沟通/材料/期限 | 1-10 人 |
| `FINANCE` | 财务 | 所有案件的财务字段可见可编辑，案件正文只读 | 1-2 人 |

> 系统管理身份另用 `SystemRole.SUPER_ADMIN` 表示，不属于业务岗位。它只开放 `/admin/*` 的系统配置与审计能力，不自动授予案件正文、财务、附件、导出或审批权限。新建用章、快递、保全、开票等业务单据时选择“关联案件”，以及手动把短信/案件互相关联时，必须限定为当前用户主办（Matter.ownerId / LEAD）或作为成员参与（CO_LEAD / ASSISTANT）的案件。

### 2.2 典型场景

**场景 A — 新案咨询到落地**
> 周二下午，叶森接到老客户电话，介绍朋友的公司有个合同纠纷。叶森打开 LawLink：
> ① 点"新建收案" → 录入客户、相对方、案由、标的额、来源；
> ② 系统自动跑冲突检索，提示"相对方'华东置业'与历史案件 M-2025-041 客户重名"，等级 BLOCKING；
> ③ 叶森确认是同一主体，标记冲突结论为"不接案"，关闭 Intake。
> 若无冲突，叶森点"转正式案件"→ 生成 `Matter`，自动套用诉讼案件阶段模板。

**场景 B — 开庭准备**
> 张律师下周一开庭。打开案件详情页：
> ① "近期期限"卡片顶部显示"举证期限 5-25"、"开庭 5-28"；
> ② 切到"材料"标签，按"证据材料"分类上传补充证据；
> ③ "沟通记录"录入今早和客户的电话内容；
> ④ 在"任务"勾选"提交补充证据目录"为已完成。

**场景 C — 月度账单**
> 月底，张律师切到"财务"模块：
> ① 按"经办律师=我"筛选，看到本月应收 32 万、实收 18 万；
> ② 点某案件，进入"结算单"，导出 PDF 给客户对账。

**场景 D — 结案归档**
> 案件判决生效满 60 天，叶森把案件状态切到"已结案"：
> ① 系统要求填"结案小结"；
> ② 检查"材料完整性"清单（裁判文书、送达回证、结算单是否齐备）；
> ③ 点"归档"，生成 `ArchiveRecord`，案件转入只读状态。

---

## 三、V1 功能范围（必做）

### M1 工作台 `/`
- 4 张概览卡片：办理中案件 / 待确认收案 / 近 7 天期限 / 本月实收
- 案件流水线（横向阶段图：收案→冲突→立案→开庭→判决→归档）
- "近期日程"列表（开庭、期限、任务）；关联对象显示客户名称/姓名，不展示完整案件名称
- "待我处理"列表（待审批 Intake、过期任务）

### M2 收案登记 `/intakes`
- 列表 + 详情（含状态：`INTAKE` / `PENDING_CONFIRMATION` / `CONVERTED` / `DECLINED`）
- **录入项（按案件类型动态联动）**：
  - 必选先选**案件类别**（民商事 / 刑事 / 行政 / 非诉 / 顾问 / 专项）—— 决定后续可见字段
  - 标题、案由（从规范库选 / 兜底自由文本）、来源、咨询日期、收案日期
  - 委托方（可加多个）、诉讼对方（可加多个）、第三人（可加多个）
  - 客户联系人（姓名 + 电话，必填，可加多个）
  - **代理程序**（按案件类别联动可选项）：
    - 民商事 / 行政：一审 / 二审 / 再审 / 仲裁 / 执行 / 检察监督 / 其他
    - 刑事：一审 / 二审 / 再审 / 死刑复核 / 侦查 / 审查起诉 / 其他
  - **诉讼地位**：原告 / 被告 / 第三人（刑事另含被告人 / 被害人 / 自诉人）
  - **反诉补充**（仅民商事）：反诉原告 / 反诉被告 复选
  - **办理机关**（刑事核心，按代理程序联动）：侦查机关 / 检察院 / 法院 / 监狱
  - 争议解决机构 / 法院（地区可搜索下拉）
  - 标的、备注
- 操作：发起冲突检索 / 转为正式案件 / 标记不接案

### M3 冲突检索 `/conflicts`
- 检索维度（V1 只做内部库）：
  - 当事人姓名 / 名称完全匹配 + 模糊匹配（Levenshtein < 阈值）
  - 身份证号、统一社会信用代码精确匹配
  - 历史相对方、关联实体
- 命中结果分级：`LOW` / `MEDIUM` / `HIGH` / `BLOCKING`
- 结果可标注"结论"（同一主体/不同主体/待补充信息）和"是否接案"

### M4 案件管理 `/matters`

**核心模型**：一个案件 (`Matter`) 属于六大类别之一（民商事 / 刑事 / 行政 / 非诉 / 顾问 / 专项），可以包含多个程序 (`MatterProcedure`)。程序之间按时间顺序串接，每个程序有独立案号、办理机关、立案日、结案结果。

**典型多程序示例（按案件类别）**：

民商事：
- 建设工程：`一审 → 二审 → 申请执行`
- 劳动争议：`劳动仲裁 → 不服仲裁起诉一审 → 二审`
- 仲裁纠纷：`民商事仲裁 → 强制执行 / 申请撤销仲裁裁决 / 不予执行仲裁审查`

刑事：
- 普通刑案：`侦查（公安）→ 审查起诉（检察院）→ 一审 → 二审 → 刑罚执行`
- 死刑案件：`一审 → 二审 → 死刑复核`
- 申诉再审：`再审审查 → 再审`

行政：
- 复议前置：`行政复议 → 一审 → 二审`
- 直接起诉：`一审 → 二审`
- 非诉执行：`非诉行政执行`

**程序自由选择 + 中途介入**：律师可能不是从一审开始代理（如客户拿着一审判决找律师做二审）。新建案件时律师**自选首次程序类型**，不强制从一审开始。可选择性把"前序程序"（如别人代理的一审）补录为 `INFORMATIONAL` 程序，只填案号/法院/判决日期/结果用于答辩参考，不进入日程和期限聚合。

**列表 `/matters`**
- 表头筛选：类型 / 状态 / 经办 / 客户 / 日期范围，TanStack Table 支持列宽自定义
- 案件编号自动生成：`LL-2026-L-0001`（L=诉讼 / N=非诉 / C=顾问 / S=专项）
- 行内展示"当前活跃程序"（如该案件正在二审，列内显示"二审 · (2026)沪01民终3520号"）

**详情 `/matters/[id]` 多标签**
- **概览**：基本信息、当事人列表（多原告/多被告/多第三人，可即时增减）、关联实体、客户列表、团队成员（主办/协办/助理）
- **程序阶段（核心）**：横向 tab 切换不同 `MatterProcedure`，每个 tab 内含该程序的：
  - 程序信息（案号、法院、立案日、结案日、结果）
  - 工作阶段流（立案 → 举证 → 开庭 → 判决，可勾选完成）—— 仅 ENGAGED 程序展示
  - 该程序的开庭、期限 —— 仅 ENGAGED 程序展示
  - "+ 添加程序"按钮：选择程序类型（一审/二审/再审/重审一审/重审二审/劳动仲裁/民商事仲裁/撤销仲裁/执行/自定义）+ 选择参与方式（我方代理 / 前序参考），新增一个 tab
  - INFORMATIONAL 程序 tab 灰显，详情只显示元数据表单（案号/法院/判决日期/结果摘要）
- **任务**：跨程序通用任务清单，可指派到团队成员
- **期限与开庭**：聚合所有程序下的 `Hearing` + `Deadline`，按时间倒序
- **沟通记录**：`Note` 按时间倒序，支持标签、关联材料
- **材料**：分类树（证据/文书/手续/裁判/合同/其他），版本追溯，可标记加密
- **财务**：结算单 (`Billing`)、应收/实收/退款/成本、自动分成预览
- **时间线**：所有事件聚合（系统自动 + 手动录入）

### M5 客户与联系人 `/clients`
- `Client`（客户主体：机构或自然人）
- `Contact`（机构客户的联系人，姓名、职位、电话、邮箱）
- 客户档案聚合：相关案件、累计创收、合作起止

### M5A 通讯录 `/contacts`
- 本所同事来自 `User`，展示头像、身份和联系方式。
- 外部联系人用于法院、检察院、公安、公证处、仲裁机构、他所律师、鉴定/评估专家等非客户联系人。
- 现有外部联系人默认为“已通过”，不影响当前通讯录展示。
- 普通律师新增外部联系人后默认进入“待审核”，普通通讯录不展示。
- `PRINCIPAL_LAWYER` 或具备 `contacts.review` 全所授权的自定义岗位可查看待审核联系人，并进行通过或驳回；通过后全所展示，驳回后不展示。
- 审核需记录审核人、审核时间、审核意见，并写入审计日志。

### M6 财务 `/finance`
- `Billing` 结算单（合同金额、阶段付款约定）
- `FeeEntry` 收付记录（应收/实收/退款/成本/分成）
- **内置分成计算**：案件级 `CommissionPlan`（合伙人 X 30% / 主办 Y 50% / 律所留存 20%），每笔实收自动生成对应 `COMMISSION` 子条目挂在受益人下
- 按案件 / 客户 / 经办律师 / 时间段筛选
- 月度统计图表（Recharts）：收入趋势、案件类型分布、Top 客户、个人创收
- 普通律师可进入财务页，但仅展示其可见案件范围内的流水、个人分成和相关开票申请；开票审批与执行资格按审批权限组及财务业务权限分别校验

### M7 日程 `/schedule`
- 视图：月历 + 列表；月历为默认主视图并全宽显示，列表仅用于快速顺序查看
- 月历日期格直接显示 2-4 条事项：类型标签 + 时间 + 事项名；关联对象优先显示客户名称/姓名，不展示完整案件名称
- 日期格事项超过可见数量时显示 `+N`；点击日期后在月历下方行内展开当天全部详情
- 来源聚合：所有 `Hearing` + `Deadline` + `Task.dueAt`
- 提醒：到期前 N 天高亮（V1 不做邮件/微信通知）

### M8 材料管理 `/documents`
- 跨案件材料检索
- 标签 / 分类 / 文件类型筛选
- 详情：版本列表、归属案件、上传者、审计追溯

### M9 归档 `/archive`
- 归档流程：结案小结 → 材料完整性检查 → 锁定为只读
- 导出：单案件 ZIP（含材料 + 结构化数据 JSON）

### M10 设置 `/settings`
- 用户管理（增删用户、改角色）
- 阶段模板编辑（诉讼/非诉/顾问/专项各一套默认，可改）
- 冲突规则开关
- 审计日志查看
- 数据导出 / 备份

---

## 四、V1.5 路线图（V1 上线后 2-3 个月）

| 项 | 说明 |
|---|---|
| 元典 MCP 集成 | 冲突检索时调用 `enterpriseSearch` 自动核对相对方风险；案件录入支持企业信息自动填充 |
| AI 摘要 | 案件材料 PDF/Word 上传后生成摘要，存到 `Document.summary` |
| 模板库 | 起诉状、答辩状、合同审查清单等常用模板，关联到阶段 |
| 邮件/微信通知 | 期限/开庭前提醒、Intake 待处理提醒 |
| 移动端适配 | 响应式优化，不做原生 App |

---

## 五、V2 远景（V1 上线 6+ 个月）

- 案件向量检索（语义相似案件推荐）
- 时间分析（律师工时统计、效率报表）
- 客户门户（客户可登录看自己的案件进度）
- 多机构 SaaS 模式（如果有外部需求再做）

---

## 六、非功能性需求

| 维度 | 要求 |
|---|---|
| 性能 | 案件列表 1000 条以内 < 500ms；冲突检索（10000 条历史）< 1.5s |
| 浏览器 | Chrome / Edge / Safari 近 2 个版本，不支持 IE |
| 部署 | `docker compose up` 一键起；不依赖云服务 |
| 备份 | 内置 `pg_dump` 备份脚本（cron 触发） |
| 国际化 | V1 只中文；预留 i18n 结构 |
| 可访问性 | 关键交互可键盘操作；色彩对比度 WCAG AA |
| 安全 | 密码 bcrypt；session JWT；下载链接短期 token |

---

## 七、设计原则

1. **不堆功能**。每加一个字段、一个开关，问"律师真用吗？" 用不上的删掉。
2. **关键操作 ≤ 2 次点击**。新建收案、找案件、看下次开庭，都要在首页点 1-2 次到位。
3. **从问题倒推交互**，不照搬其他案管软件的菜单结构。比如"开庭管理"不是一个独立大菜单，而是案件详情的一个标签。
4. **暗色优先 + 留白**。律师看屏幕时间长，深色护眼，间距大不挤。
5. **错误友好**。表单校验提示具体到字段，不弹"操作失败"这种无意义 toast。
6. **数据可导出**。所有列表、案件详情、财务报表都能导 CSV/PDF。律所跑路了数据要拿得走。

---

## 八、已锁定决策

| # | 决策 | 落实位置 |
|---|---|---|
| 1 | 案件编号自动生成：`LL-{YYYY}-{CC/CR/AD/NL/GC/SP}-{4位流水}` | DATA-MODEL §五 |
| 2 | 不做客户合并，以案件为中心 | DATA-MODEL §4.2 |
| 3 | 团队成员区分主办 / 协办 / 助理 | DATA-MODEL §4.4 `MatterMember` |
| 4 | 内置律师分成，按案件配置方案、实收自动生成分成条目 | DATA-MODEL §4.11 `CommissionPlan` |
| 5 | 支持一案多客户、多被告、多第三人，UI 可自由增减 | DATA-MODEL §4.4 / §4.6 |
| 6 | 同一案件支持多程序串接，且律师可**自由选择首次介入的程序类型**（如直接从二审开始），前序程序可选择性补录为 `INFORMATIONAL` 用于参考 | DATA-MODEL §4.5 `MatterProcedure` + `engagement` |
| 7 | 材料支持可选加密存储（AES-256-GCM） | DATA-MODEL §4.10 |
| 8 | 数据迁移：V1 不做，需要时单独评估 | — |
| 9 | UI 主题：默认深色 + 法理蓝主色，管理员可在 `/settings` 自定义主题色 | UI-DESIGN §二 |
| 10 | 新建用右侧抽屉、查看/编辑用整页 | UI-DESIGN §六 |
| 11 | 开源协议 MIT | LICENSE / package.json |
| 12 | Stage 1 直接覆盖现有 src/ 下的占位代码 | — |
| 13 | 案件按三大诉讼体系分类（民商事 / 刑事 / 行政）+ 非诉 / 顾问 / 专项 | DATA-MODEL §4.3 `MatterCategory` |
| 14 | 程序按案件类别动态可选；刑事独有侦查 / 审查起诉 / 死刑复核；行政独有行政复议 / 非诉行政执行 | DATA-MODEL §4.5 |
| 15 | 程序"办理机关"独立字段：刑事侦查 → 公安 / 审查起诉 → 检察院 / 审判 → 法院 / 刑罚执行 → 监狱 | DATA-MODEL §4.5 `handlingAgency` |
| 16 | 诉讼地位独立建模：原告 / 被告 / 第三人 / 反诉原告 / 反诉被告 / 刑事被告人 / 被害人 / 自诉人 / 仲裁申请人 等 | DATA-MODEL §4.4 `ourStanding` |
| 17 | **案由从规范库选**（最高法民事案由规定 + 刑法罪名 + 行政案由规定 seed）；不允许随手填字符串 | DATA-MODEL §4.14 `CauseOfAction` |
| 18 | `intakeDate`（律师收案日）与 `firstAcceptedAt`（首次立案日）拆开 | DATA-MODEL §4.4 |
| 19 | **导航重构（v0.4）**：一级菜单仅留 工作台 / 案件 / 客户 / 财务 / 日程 / 设置；收案合并入"案件"下的"待审批" tab，材料不再独立菜单（只在案件详情），利益冲突改为顶栏/首页工具按钮 | nav-config.ts / 本文 §九 |
| 20 | **收案表单（v0.4）**：① 委托方 Combobox 支持自由输入，无匹配则自动建 Client；② 标题非必填，留空按"{委托方} 与 {对方} {案由}纠纷"规则自动生成；③ 表单底部支持上传委托合同（多文件，加密存储）；④ 提交后状态 = `PENDING_CONFIRMATION` 进入审批流 | 本文 §九 |
| 21 | **审批工作流（v0.4）**：ADMIN + PRINCIPAL_LAWYER 可批准/拒绝 Intake；其他角色仅可提交。批准 → 自动转 Matter；拒绝 → 写 declinedReason；server action 必须做权限校验，不只是 UI 隐藏 | 本文 §九 |
| 22 | **利益冲突检索（v0.4）**：① 改名"利益冲突"；② 表单去掉角色字段，仅姓名/证件号至少一项；③ `/conflicts` 页保留可访问但不挂导航，主入口改为顶栏按钮 + Dialog | 本文 §九 |
| 23 | **亮色主题（v0.4）**：引入 next-themes，`:root` 为浅色变量，`.dark` 为深色变量；默认 dark；顶栏 Sun/Moon 切换 | UI-DESIGN §二 / globals.css |
| 24 | **收案字段补齐（v0.5）**：程序优先→诉讼地位联动；新增 委托方性质/联系人姓名+电话/争议解决机构/标的额/标的描述/律师费(5 种收费模式)/主办+共同律师/收案时间(默认今天)；删除"案源" | 本文 §十 |
| 25 | **LitigationStanding 扩展（v0.5）**：新增 APPELLANT / APPELLEE / RETRIAL_APPLICANT / RETRIAL_RESPONDENT / ENFORCEMENT_APPLICANT / EXECUTED_PERSON / COUNTERCLAIM_PLAINTIFF / COUNTERCLAIM_DEFENDANT / ADMIN_PLAINTIFF / ADMIN_DEFENDANT / ADMIN_RECONSIDERATION_APPLICANT / ADMIN_RECONSIDERATION_RESPONDENT。由 `procedureToStandingOptions(proc, side)` 决定可选项 | lib/enums.ts |
| 26 | **FeeType 枚举（v0.5）**：LUMP_SUM / INSTALLMENT / CONTINGENCY_FULL / CONTINGENCY_PARTIAL / HOURLY | Prisma + 本文 §十 |
| 27 | **案件详情 tab 重构（v0.5）**：① 基本信息（卡片墙：元信息 + 团队 + 当事人 + 近期期限/开庭 + 委托合同）② 案件资料（任务/沟通/材料/财务 子区，跨程序共享，可标筛选）③ 每个 ENGAGED 程序一个 tab（程序信息+期限+开庭）④ 时间线 | 本文 §十 |
| 28 | **团队可编辑（v0.5）**：基本信息 tab 的团队卡片可弹 Dialog 改主办+协办+助理。权限：ADMIN / PRINCIPAL_LAWYER / 当前 LEAD | server/matters/actions.ts updateMatterTeam |
| 29 | **发票工作流（v0.5）**：① 律师在案件资料·财务区点"申请开票"录入金额+抬头+开票依据附件+备注 → InvoiceRequest(PENDING)；② 财务/管理员/主任律师在 /finance 的"开票管理" tab 查看申请信息和依据附件，可驳回（写原因）或批准/开具（上传电子发票 → 状态 ISSUED，自动识别发票号/金额等信息）；③ 财务 KPI 加"本月已开票"+ 待处理数量徽章 | server/invoices + 本文 §十 |
| 30 | **InvoiceRequest 模型（v0.5）**：matterId / amount / status / requestedBy / processedBy / contractScanId(Document) / invoiceFileId(Document) / requestNote / processNote | DATA-MODEL §4.15 |

---

## 九、v0.4 修订详述

### 9.1 导航结构（变更）

**v0.3 → v0.4 一级菜单**

| v0.3 | v0.4 | 去向 |
|---|---|---|
| 首页 | 工作台 | 保留为首页入口 |
| 收案 | — | 合并到"案件 / 待审批 tab" |
| 冲突检索 | — | 改顶栏按钮 + Dialog；`/conflicts` 详情页保留 |
| 案件 | **案件** | 顶部加 3 个 tab：`待审批` / `进行中` / `已结案归档` |
| 客户 | 客户 | 保留 |
| 财务 | 财务 | 保留，header 加文案说明流水来源 |
| 日程 | 日程 | 保留 |
| 材料 | — | 完全删除，材料只在案件详情 tab |
| 设置 | 设置 | 保留 |

**理由**：v0.3 把 8 个一级菜单按数据模型切，律师心智上其实只有"做案子 / 看客户 / 看钱"三件事。收案是案件的一个状态；冲突是个工具；材料天然属于案件。

### 9.2 案件管理 `/matters` 三 tab

| tab | URL | 数据来源 | 用户视角 |
|---|---|---|---|
| 待审批 | `/matters?tab=intake` | `Intake` 表 status ∈ {INTAKE, PENDING_CONFIRMATION} | 等管理员批准的案子 |
| 进行中 | `/matters?tab=active`（默认） | `Matter` 表 status ∈ {PENDING_ACCEPTANCE, IN_PROGRESS, ON_HOLD} | 当前手上的案子 |
| 已结案归档 | `/matters?tab=closed` | `Matter` 表 status ∈ {CLOSED, ARCHIVED} | 历史档案 |

**新建收案按钮**：放在 `/matters` 右上角，复用 `IntakeSheet` 抽屉。`/intakes` 列表页保留可访问（兼容旧链接）但不挂导航；`/intakes/[id]` 详情页继续作为审批操作页。

### 9.3 收案表单字段变更

| 字段 | v0.3 | v0.4 |
|---|---|---|
| title | 必填 | **可选**；留空按 `{client.name} 与 {opposing[0].name}{[、对方2..]} {cause.name}纠纷` 生成 |
| clientId | select 现有客户 | **Combobox**：搜索现有 + 自由输入名字 |
| clientName（新增） | — | 自由输入时使用，无匹配则触发自动建档 |
| clientTypeHint（新增） | — | 自动建档时的类型推断/选择：`INDIVIDUAL` / `ORGANIZATION` |
| contracts（新增） | — | 多文件上传，存为 `Document.category=CONTRACT` 并 `intakeId=本 Intake` |

**自动建档规则**（提交时执行）：
1. 若用户从下拉选了已有客户 → 用 `clientId`
2. 若自由输入了 `clientName`：
   - 若任一 party 的 `idNumber` 是 18 位纯数字 → 自动判 `INDIVIDUAL`
   - 若 18 位含字母（统一社会信用代码格式）→ `ORGANIZATION`
   - 否则前端弹"个人 / 组织"选择 Dialog 让用户选
3. server action 创建 Client（仅 name + type，其他字段空，后续到客户详情完善），并把 `clientId` 关联到本次 Intake

### 9.4 审批工作流

```
[任何角色] 提交收案
  ↓ status = PENDING_CONFIRMATION
[ADMIN / PRINCIPAL_LAWYER 可见操作]
  ├─ 转为正式案件 → 创建 Matter（迁移合同 Document）+ Intake.status = CONVERTED
  └─ 不接案 → Intake.status = DECLINED + 写 declinedReason
```

- 权限校验必须在 server action 层（`convertIntakeToMatter` / `declineIntake`），不只是 UI 隐藏
- 其他角色看 Intake 详情页时显示"等待审批"提示，不显示操作按钮
- 合同迁移：Intake 关联的 Document 在 convert 时把 `matterId` 设为新 Matter，`intakeId` 保留（双向溯源）

### 9.5 利益冲突检索

- **入口**：顶栏按钮 `利益冲突`（图标 ShieldCheck）→ 弹 Dialog；首页 hero "发起利益冲突检索"按钮 → 同一 Dialog
- **表单**：删除"角色"字段；仅 姓名/名称 + 身份证/统一社会信用代码（至少填一项即可检索）
- **详情页 `/conflicts`**：保留，作为 Dialog 的"展开版"入口（Dialog 右上角"查看完整记录"链接过去）
- **底层 server action**：`runCheckAndSave` 的 `role` 参数改 optional，默认 `OPPOSING_PARTY`

### 9.6 首页 hero 按钮

| v0.3 | v0.4 |
|---|---|
| 新建收案（无效） | 新建收案 → `/matters?tab=intake&new=1` 自动打开抽屉 |
| 发起冲突检索（无效） | 发起利益冲突检索 → 同顶栏 Dialog |
| 录入开庭笔录（无效） | **删除** |

### 9.7 主题切换

- 引入 `next-themes`（attribute="class" / defaultTheme="dark" / enableSystem=true）
- `globals.css` 拆分：
  - `:root` → 浅色变量（背景 `#F8FAFC` / 卡 `#FFFFFF` / 前景 `#0F172A` / 主色保持法理蓝 `#5B8DEF`）
  - `.dark` → 现有深色变量
- 顶栏加 `ThemeToggle`（Sun/Moon），切换平滑过渡
- 关键组件（玻璃卡 `ll-glass` / 严重度色 `ll-sev-*`）在两套主题下都需可读

---

## 十、v0.5 修订详述

### 10.1 收案表单（重大重做）

**字段顺序（决定其他字段联动）**：① 案件类别 → ② 程序 + 我方诉讼地位 + 争议解决机构 → ③ 委托方性质 + 委托方（Combobox） + 联系人姓名/电话 → ④ 案由 + 标的额/描述 + 收案时间 → ⑤ 律师费(5 种模式) → ⑥ 主办 + 共同律师 → ⑦ 对方/第三人(各自诉讼地位) → ⑧ 标题(可空) + 描述 → ⑨ 合同上传。

**联动规则**：
- 程序变更后，"我方诉讼地位"和对方/第三人的"诉讼地位"可选项动态切换：
  - 一审 / 重审一审：原告 / 被告 / 第三人 / 反诉原告 / 反诉被告
  - 二审 / 重审二审：上诉人 / 被上诉人 / 第三人
  - 再审审查 / 再审：再审申请人 / 再审被申请人 / 第三人
  - 仲裁：仲裁申请人 / 仲裁被申请人 / 第三人
  - 执行：申请执行人 / 被执行人 / 第三人
  - 刑事各程序：被告人 / 被害人 / 自诉人 / 附带民事原告
  - 复议：复议申请人 / 复议被申请人 / 第三人
  - 非诉 / 顾问 / 专项：项目当事人
- 选定程序后自动填充建议"争议解决机构"（一审→法院 / 仲裁→仲裁委 / 复议→复议机关 / 执行→法院执行局 等）

**律师费 5 种模式**：一次性 / 分期支付 / 风险代理(纯后付) / 风险代理(部分后付) / 按小时计费。金额 + 付款节点(自由文本) + 备注。

**主办 + 共同**：主办默认当前用户，可改；共同可勾选多个；转化为 Matter 时主办成为 LEAD，共同成为 CO_LEAD。

### 10.2 案件详情 tab 结构

**一级 tab**：
1. **案件信息** — 基础信息与当前程序合并为一个模块：
   - 模块标题后以较弱样式展示所内案号（如有）；同一张信息表内展示：标的/项目金额、业务类型、立案时间、程序案号、管辖地、管辖机构、主审/仲裁员/执行法官、联系方式、诉讼/仲裁请求、关联案件。
   - 短字段按每行三项排列，标的/项目金额、立案时间与其他短字段同组排布；诉讼/仲裁请求、关联案件保持单独整行。
   - 该模块不展示：系统编号、案件类型、收案时间、案由、当前程序、主办律师、协办人员、客户、委托合同；收案时间放在详情页标题摘要区，团队、当事人、财务分别由独立模块承载，材料进入各环节的阶段材料区。
   - 该模块只保留一个"编辑"入口；编辑弹窗内部按"案件基础信息 / 当前程序信息"分区，不在模块头部拆成多个编辑按钮。
2. **案件资料** — 任务 / 沟通 / 财务（财务区底部含发票申请）；材料不再作为详情页独立模块展示，统一嵌入当前程序工作台的各环节。
3. **程序 tab × N** — 每个 ENGAGED 程序一个 tab，含：程序信息 + 期限 + 开庭。INFORMATIONAL 程序仍存数据但不显示为顶级 tab
4. **时间线** — 全案事件

**视觉**：tab indicator（激活态主色背景 + glow）、玻璃卡片墙、留白。

### 10.2.1 当前程序工作台

案件详情不再只作为信息流展示。`ProcedureChainBar` 下方直接呈现当前程序的环节切换卡片，不再重复显示"程序名 · 当前程序工作台"抬头。

- 左侧为环节导航：优先使用真实 `MatterStage`；若当前程序尚未建阶段，则只展示该程序的必备预设环节（如一审：代理授权、案情研判、起诉立案、举证质证、开庭审理、裁判签收、案件归档）。财产保全、管辖权异议、司法鉴定、庭前会议、模拟法庭、庭后补充等为可选预设环节，不默认占用每个案件流程。执行不作为普通诉讼/仲裁程序内的预设环节；需要执行时应新增独立执行程序。
- "添加环节"放在环节导航卡片下方并以整行强调按钮呈现；弹窗优先从尚未加入的预设环节中选择，并可指定插入到最前、最后或某一环节之后。只有预设环节覆盖不到时才走自定义名称。保存后写入当前程序的 `MatterStage`；若当前程序尚未有真实阶段，第一次新增或在推荐环节中新增任务时，先将必备预设环节物化为真实阶段，再按插入位置定位目标环节；"套用模板"只放在右侧当前环节的推荐文书/推荐动作区域，不作为程序级全局按钮。
- 可选预设环节和自定义环节可以从流程中移除；已有任务、材料或保全等专项记录时不能直接删除底层数据，后续应通过 `ACTIVE/HIDDEN` 状态实现隐藏。
- "案件信息"作为工作台内第一个卡片展示，但不直接嵌入旧表格式 `InfoPanel`；改为工作台原生的案件概览面板，聚焦案件身份、当前程序、请求与标的、关联案件等高频信息。当事人、裁判/裁决结果分别由独立当事人板块和程序工作台最后一个环节承载，不在案件信息汇总中重复展示。详情页主区不再在工作台下方重复展示独立案件信息模块。
- 右侧为环节内容：普通环节展示本环节事项、本环节记录、文书材料、关联材料；财产保全环节直接展示本案保全程序的操作内容，包括被保全人、财产、金额、到期倒计时、续保和解除入口，不再显示"保全案件数量"这类聚合统计。
- 普通环节必须体现该阶段真正应办事项，不用"未完成期限"作兜底。代理授权只聚合委托手续与客户交接材料；案情研判聚合法律检索、事实摘要、证据缺口和诉讼方案；立案聚合起诉/仲裁申请材料、管辖与缴费；管辖权异议聚合异议期限、异议申请/答辩、裁定签收和上诉衔接；司法鉴定聚合鉴定事项、样本材料、鉴定机构、鉴定意见质证；模拟法庭聚合争点清单、发问提纲、攻防演练和客户庭前沟通；庭后补充聚合庭后代理意见、补充材料、庭审报告和法官沟通；案件归档聚合结案报告、材料完整性、原件退还和归档申请。
- 每个环节都展示"阶段材料"面板，继承当前程序材料库的文件内容和上传能力；上传时仍写入同一套 `Document` / 程序材料体系，并通过阶段标签归集到当前环节。详情页主区不再另设独立"案件材料"模块。
- 财产保全作为程序内的专项工作包，不恢复为侧边栏一级入口；`/preservation` 仍保留为全局聚合视图。
- 阶段内生成或上传的文书仍进入同一套程序材料数据，不拆分第二套材料体系。
- 首页"待我处理"和日程中的保全提醒以 `PreservationProperty.expiryDate` 为准，不再读取旧 `Preservation` 单表。

### 10.3 发票工作流

```
[案件 LEAD/CO_LEAD/ADMIN] 在 /matters/[id] 案件资料·财务区点"申请开票"
  ↓ 录入金额 + 抬头 + 开票依据附件 + 备注
  ↓ InvoiceRequest(status=PENDING)

[FINANCE / ADMIN / PRINCIPAL_LAWYER] 在 /finance "开票管理" tab 看到
  ├─ 驳回 → 写原因 → status=REJECTED
  └─ 处理 → 查看申请信息 + 开票依据附件，批准或上传电子发票
     ├─ 仅批准 → status=APPROVED（等补传发票）
     └─ 上传电子发票 → OCR 自动识别发票号 / 金额等 → status=ISSUED（完成）

开票依据由申请人上传，记录在 InvoiceRequest.evidenceDocIds；
电子发票以 Document(encrypted=true) 入库，InvoiceRequest.invoiceFileId 关联。
```

### 10.4 团队编辑

`InfoPanel` 团队卡片右上角"编辑"按钮 → Dialog：
- 主办律师 Select（活跃 User 列表）
- 协办律师 Checkbox（多选）
- 助理 Checkbox（多选）
- 提交 → `updateMatterTeam` 覆盖式重建 MatterMember
- 权限：ADMIN / PRINCIPAL_LAWYER / 当前 LEAD

### 10.5 视觉打磨

- Sidebar logo 点击回首页（`<Link href="/">`）
- Topbar Bell 点击 toast 占位（V1.5 上线消息中心）
- 案件详情 tab 条：激活态背景主色 + glow，cluster 分隔线（基本信息/资料 | 程序 | 时间线）
- 基本信息卡片墙：`ll-glass` 玻璃质感 + 案件类别色光晕（右上角 blur 圆斑）
- 当事人列表：诉讼地位作为副标题展示在姓名下
- 委托合同：图标 + 文件名 + 大小 + 上传日期 + 下载按钮，下载经鉴权

---

## 十一、v0.8 规划：卷宗 + 文档模板系统（草案，待确认）

> v0.6 / v0.7 为视觉/主题层迭代（金米色第三套主题、editorial UI 重做、全局间距收紧），未引入新业务模块，详见 [UI-DESIGN.md](./UI-DESIGN.md)。
>
> 本节为 v0.8 功能规划，**尚未实施**，需要叶森确认后才进入已锁定决策表。

### 11.1 设计目标

把律所最常用的工作文书做成**模板**，律师在案件详情里选模板 → 自动填充案件字段（当事人/案号/法院/律师等）→ 生成 docx 下载，同时落到该案件的"卷宗"里归档管理。

**核心价值**：律师当前 80% 的文档准备时间花在重复填写当事人信息和文书抬头上，模板化后压到 5%。

**与现有模块的关系**：
- 卷宗 tab 是 Matter 详情页的**新一级 tab**（v0.5 的四 tab 扩为五 tab：基本信息 / 案件资料 / 卷宗 / 程序 tab × N / 时间线）
- 文档模板**独立于** v0.5 的"委托合同上传"和 v0.5 的"发票工作流上传"——后两者是**用户上传**已签字扫描件，前者是**系统生成**待签字稿
- 模板与 v1.5 路线图的"AI 摘要"互补，不冲突

### 11.2 数据模型新增

**新表 `DocumentTemplate`**（系统/律所级，不属于具体 Matter）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | String | cuid |
| `name` | String | 模板名（如"民事案件收案登记表"）|
| `category` | TemplateCategory | 见 §11.3 七大类 |
| `applicableMatterCategories` | MatterCategory[] | 适用案件类别（空数组=全适用）|
| `docxBlob` | Document FK | 模板 docx 文件（加密存储，复用 Document 模型）|
| `variables` | Json | 该模板用到的变量清单（用于缺失提示），如 `["client.name","matter.caseNumber","court.name"]` |
| `isBuiltIn` | Boolean | 系统内置（不可删）vs 律所自定义 |
| `enabled` | Boolean | 是否在选模板列表中展示 |
| `createdBy` / `createdAt` / `updatedAt` | — | 审计字段 |

**新表 `DocumentFolder`**（每个 Matter 的卷宗目录）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | String | cuid |
| `matterId` | String FK | 归属案件 |
| `name` | String | 卷宗名（如"立案卷"）|
| `orderIndex` | Int | 排序权重 |
| `isDefault` | Boolean | 是否系统预置（不可删）|

**`Document` 加字段**：
- `folderId`：String? FK → DocumentFolder（归属哪个卷宗，可空 = 散件）
- `templateId`：String? FK → DocumentTemplate（生成自哪个模板，可空 = 用户上传）
- `templateContextSnapshot`：Json?（生成时的变量快照，便于复核/重生成）

**新枚举 `TemplateCategory`**：`INTAKE` / `RETAINER` / `LITIGATION` / `HEARING` / `WORK_PRODUCT` / `ARCHIVE` / `CLOSING` / `BLANK`

### 11.3 模板分类与建议预置清单

| 大类 | 模板示例（首批预置 ★） |
|---|---|
| `INTAKE` 收案文书 | ★ 民事案件收案登记表 / ★ 刑事案件收案登记表 / ★ 法律服务风险告知书 / 质量反馈卡 |
| `RETAINER` 委托文书 | ★ 委托代理合同(个人) / ★ 委托代理合同(单位) / ★ 授权委托书(个人) / 授权委托书(法人) / 解除委托声明 |
| `LITIGATION` 诉讼文书 | ★ 民事起诉状 / ★ 民事答辩状 / 行政起诉状 / 上诉状 / 反诉状 / 仲裁申请书 / 行政复议申请书 |
| `HEARING` 庭审文书 | ★ 谈话笔录 / 庭审笔录 / 阅卷笔录 / 询问笔录(刑事) / 会见笔录(刑事) |
| `WORK_PRODUCT` 工作成果 | 办案小结 / 重大复杂疑难案件讨论笔录 / 法律意见书 / 代理意见 / 律师函 / 公函(法院) |
| `ARCHIVE` 卷宗文书 | 卷宗封皮 / 卷宗目录 / 备考表 / 证据目录及证据材料 |
| `CLOSING` 结案文书 | 结案登记表 / 结算单 |
| `BLANK` | 空白文档（套律所抬头）|

**首批预置（v0.8.0 ★ 8 个）**：覆盖收案到立案最高频场景，可让律师立刻用起来。后续每月迭代扩到 20+。

### 11.4 默认卷宗结构（按案件类别）

新建 Matter 时按类别**自动生成**对应的默认卷宗（用户可后续增删）：

| 案件类别 | 默认卷宗 |
|---|---|
| 民商事 / 行政 | 收案 / 立案 / 委托手续 / 证据 / 程序文书 / 庭审 / 裁判 / 结案 |
| 刑事 | 收案 / 委托手续 / 阅卷 / 会见 / 取证 / 庭前 / 庭审 / 判决与上诉 / 结案 |
| 仲裁 | 收案 / 委托手续 / 仲裁申请 / 证据 / 开庭 / 裁决 / 结案 |
| 非诉 / 顾问 / 专项 | 立项 / 调研 / 工作底稿 / 出具文件 / 归档 |

每个程序（`MatterProcedure`）增加 `defaultFolderName`：生成自模板的文书按"模板大类 → 程序"自动落到对应卷宗（如二审起诉状落到"二审 / 程序文书"）。

### 11.5 模板渲染机制

**引擎**：`docxtemplater` + `pizzip`（成熟方案，零依赖 LibreOffice，浏览器和 Node 都可用）

**变量语法**：`{{client.name}}` / `{{matter.caseNumber}}` / `{{#parties.plaintiffs}}{{name}}{{/parties.plaintiffs}}`（数组循环）

**变量来源（自动拼装上下文）**：
```ts
{
  firm: { name, address, phone },           // 律所抬头，从 Settings 读
  matter: { caseNumber, title, category, intakeDate, cause, amount, ... },
  client: { name, idNumber, address, ... }, // 委托方
  parties: { plaintiffs[], defendants[], thirds[] },
  proceeding: { caseNo, court, judge, hearingDate, ... }, // 当前 active proceeding
  team: { lead, coLeads[], assistants[] },
  today: '2026-05-23',
  lawyer: { name, certNo, ... },            // 主办律师
}
```

**缺失变量处理**：渲染前预扫，缺失的字段在 Dialog 列出（标红），用户可立即补全（保存回各源表）或选择"留空生成"。

**输出**：
1. 浏览器直接下载 docx
2. **同时**保存一份到该 Matter 的 Document 表（`templateId` + `templateContextSnapshot` 标识），自动归到对应卷宗

### 11.6 UI 设计

**卷宗 tab（Matter 详情页新增）**：

```
┌─────────────────────────────────────────────────────────────┐
│  ▸ 收案 (3)            │  ┌──────┐ ┌──────┐ ┌──────┐         │
│  ▸ 立案 (2)            │  │收案登 │ │风险告 │ │委托代 │         │
│  ▸ 委托手续 (4)        │  │记表  │ │知书  │ │理合同 │         │
│  ▸ 证据 (12)           │  │.docx │ │.docx │ │.docx │         │
│  ▸ 程序文书 (5)        │  └──────┘ └──────┘ └──────┘         │
│  ▸ 庭审 (2)            │                                      │
│  ▸ 裁判 (1)            │  + 从模板新建    + 上传文件          │
│  ▸ 结案 (0)            │                                      │
│  + 新建卷宗            │                                      │
└─────────────────────────────────────────────────────────────┘
```

- 左侧：卷宗树（默认结构 + 用户自定义），数字为文档数；右键菜单"重命名/删除"（默认卷宗不可删，可改名）
- 右侧：当前卷宗内的文档卡片墙（沿用 v0.7 hairline + Cormorant），点击预览/下载/编辑元信息
- 顶部三按钮：**从模板新建**（主按钮，主色）/ **上传文件** / **新建卷宗**

**"从模板新建" Dialog**：
1. 步骤 1 — 选模板：左侧 8 大类 tab，右侧模板列表（卡片：名称 + 适用类别标签 + 描述）
2. 步骤 2 — 变量预扫：列出该模板用到的字段，已自动填充的打钩，缺失的标红 + 行内补全
3. 步骤 3 — 选目标卷宗：默认按模板大类推荐，可改
4. 提交 → 后台渲染 → 下载 + 入库 + toast "已生成并归档至 [卷宗名]"

**视觉**：延续 v0.7 editorial 风格（hairline 边框、Cormorant Garamond 标题、ll-row hover、紧凑间距），**严禁** 套图 3 的 antd 蓝白配色。

### 11.7 权限

| 操作 | ADMIN | PRINCIPAL_LAWYER | LAWYER | ASSISTANT | FINANCE |
|---|---|---|---|---|---|
| 系统模板增删改（`/settings/templates`）| ✅ | ❌ | ❌ | ❌ | ❌ |
| 案件内使用模板生成 | ✅ | ✅ 全部 | ✅ 自己案件 | ✅ 按授权 | ❌ |
| 卷宗增删改 | ✅ | ✅ 全部 | ✅ 自己案件 | ❌ | ❌ |
| 文档归档/移动卷宗 | ✅ | ✅ 全部 | ✅ 自己案件 | ✅ 按授权 | ❌ |

### 11.8 实施分期

| 阶段 | 范围 | 估时 |
|---|---|---|
| **v0.8.0** | DocumentTemplate + DocumentFolder schema；默认卷宗自动生成；卷宗 tab UI；从模板新建 Dialog；**首批 8 个系统模板**（★ 标）；docxtemplater 渲染下载入库 | 2-3 天 |
| **v0.8.1** | 扩到 20+ 模板；缺失变量补全 Dialog；用户自定义卷宗增删；模板按案件类别过滤 | 1-2 天 |
| **v0.9** | `/settings/templates` 律所自定义模板上传（律所自带 docx）；变量自动识别（解析 `{{...}}`）；模板版本管理 | 2-3 天 |

### 11.9 已决策（2026-05-23）

1. **首批 8 个模板**的 docx 文件由 LawLink 实施时**用 docx 生成代码动态生成开源初版**（基于国内律所通用格式 + LawLink 抬头），叶森拿到部署后自行修改替换。  
   *理由：不卡 v0.8.0 进度；律所文书格式有共识基线；后续可逐步迭代。*
2. **在线编辑** v0.8 **不做**。律师工作流仍是"下载 docx → Word 桌面端修改 → 上传新版本"。  
   *理由：律师熟悉 Word；OnlyOffice/Collabora 自部署维护成本高、配置复杂；如有强需求作为 v1.5 独立模块单独评估。*
3. **变量补全 UI** = **Dialog 内行内补全**（即写即存到源表，如客户身份证号缺失直接在 Dialog 内填好回写 Client 表）。  
   *理由：操作链路最短，避免跳转打断生成文书的思路。*
4. **`folderId` 与 `Document.category` 正交保留**。`category` 用于跨案件检索分类（如"找所有合同"），`folderId` 是该案件内的物理归档位。  
   *理由：检索维度和归档维度本来就是两个独立轴。*
5. **模板预览** v0.8.0 **仅文字描述**（模板名 + 简介 + 字段需求），v0.9 加截图缩略图。  
   *理由：docx → 图工程量大，先把核心生成链路打通。*

---

## 十二、v0.8 规划：用章审批工作流（草案，待确认）

> 与 §十一 卷宗模板并列，是 v0.8 第二个独立模块。

### 12.1 设计目标

律所用章是合规重点：律师对外出具的法律意见书、律师函、所函、合同等都要加盖律所公章/合同专用章。当前线下流程是"律师写完 → 找合伙人/主任签字 → 行政盖章 → 寄出"，留痕分散、责任不清。

LawLink 把用章工作流线上化：**申请 → 审批 → 盖章确认 → 全所留档**。

**与现有审批的区别**：

| | v0.4 收案审批 | v0.5 发票审批 | v0.8 用章审批 |
|---|---|---|---|
| 触发 | 提交 Intake | 案件财务区点"申请开票" | 用章中心新建申请 |
| 关联 Matter | 强制 | 强制 | **可选**（所内行政可能无） |
| 上传 | 委托合同 | 申请人上传开票依据；财务处理时上传电子发票 | 待盖章稿（必传）+ 盖章后扫描件（事后补，必传） |
| 审批人 | ADMIN / PRINCIPAL_LAWYER | FINANCE / ADMIN / PRINCIPAL_LAWYER | **按章种类映射角色** |

### 12.2 章的种类（V1 内置 5 种）

| 编码 | 名称 | 典型用途 | 审批角色 |
|---|---|---|---|
| `OFFICIAL_SEAL` | 律师事务所公章 | 法律意见书、所函、律师函、对外正式文件 | 主任律师 (PRINCIPAL_LAWYER) |
| `CONTRACT_SEAL` | 合同专用章 | 律所对外签订的合同（顾问/转介） | 主任律师 |
| `FINANCE_SEAL` | 财务专用章 | 发票、收据、对账单 | FINANCE |
| `LEGAL_REP_SEAL` | 法定代表人章 | 工商/银行类文件 | **法定代表人本人**（Settings 指定 User）|
| `CONTRACT_REVIEW_SEAL` | 合同审核章 | 顾问单位送审合同盖审核章 | 主任律师 |

后续可在 `/settings/seals` 自定义增加新章种类（v0.9）。

### 12.3 数据模型

**新表 `SealRequest`**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` / `code` | String | `code` = `SEAL-2026-0001` 流水号 |
| `sealType` | SealType 枚举 | 章种类 |
| `matterId` | String? FK | 关联案件，可空 |
| `purpose` | String | 用章事由（如"出具法律意见书寄送 XX 公司"） |
| `documentTitle` | String | 待盖章文件标题 |
| `pageCount` | Int | 页数（统计/骑缝判断） |
| `requireCrossPageSeal` | Boolean | 是否需要骑缝章 |
| `copies` | Int | 份数（默认 1） |
| `urgency` | Urgency (NORMAL/URGENT) | 紧急程度 |
| `draftDocId` | FK → Document | 待盖章稿（必传，加密存储） |
| `stampedDocId` | FK → Document? | 盖章后扫描件（盖章后必补） |
| `requestNote` / `approveNote` | String? | 申请/审批备注 |
| `status` | SealRequestStatus | `PENDING` / `APPROVED` / `STAMPED` / `REJECTED` / `CANCELLED` |
| `requestedBy` / `approvedBy` / `stampedBy` | FK → User | 角色追踪 |
| `requestedAt` / `approvedAt` / `stampedAt` / `rejectedAt` | DateTime | 时间戳 |

**新枚举**：`SealType` / `SealRequestStatus` / `Urgency`

### 12.4 工作流

```
[任何律师] /seals → 新建用章申请
   章种类 + (可选)关联案件 + 事由 + 文件标题/页数/骑缝/份数/紧急
   + 上传待盖章稿(必传)
   ↓ status = PENDING

[对应审批人] /seals · 待我审批
   ├─ 驳回 → 原因 → REJECTED（申请人可补充再申请，引用旧 ID 形成追溯）
   └─ 通过 → 意见(可选) → APPROVED → 通知行政

[行政 / 审批人] 完成盖章后回填
   上传盖章后扫描件 → STAMPED → 申请人可下载完整记录

[申请人] 未审批前可撤销 → CANCELLED
```

### 12.5 UI 设计

**一级菜单新增 `/seals`**（图标 `Stamp`，位置：日程 之后、设置 之前）

**三 tab**：

| tab | 数据 | 谁能看 |
|---|---|---|
| 我的申请 | requestedBy = me | 所有有申请权的角色 |
| 待我审批 | status=PENDING 且 我是 sealType 对应审批人 | 审批人 |
| 全所流水 | 全部 | ADMIN / PRINCIPAL_LAWYER；FINANCE 仅看财务章 |

**新建申请抽屉**：右侧 Sheet，字段顺序按 §12.3。关联案件后自动从 Matter 拼"事由"提示。

**审批 Dialog**：左侧申请详情 + 待盖章稿内嵌预览/下载；右侧通过/驳回 + 意见 textarea。

**全所流水**：表格列 流水号 / 章种类 / 申请人 / 案件 / 事由 / 状态 / 时间。顶部 KPI：本月已盖章 / 待审批 / 待盖章。状态色码：PENDING 琥珀 / APPROVED 蓝 / STAMPED 绿 / REJECTED 红 / CANCELLED 灰。

**视觉**：延续 v0.7 editorial（hairline + Cormorant + ll-row），与卷宗 tab 风格统一。

### 12.6 权限矩阵

| 操作 | ADMIN | PRINCIPAL_LAWYER | LAWYER | ASSISTANT | FINANCE |
|---|---|---|---|---|---|
| 新建申请 | ✅ | ✅ | ✅ | ❌ | ❌ |
| 审批公章/合同章/合同审核章 | ✅ | ✅ | ❌ | ❌ | ❌ |
| 审批财务章 | ✅ | ❌ | ❌ | ❌ | ✅ |
| 审批法定代表人章 | ❌ | 仅 Settings 标记的法定代表人 | — | — | — |
| 确认盖章（回填扫描件） | ✅ | ✅ | ❌ | ❌ | 仅财务章 |
| 看全所流水 | ✅ | ✅ | 仅自己 | ❌ | 仅财务章 |
| 撤销未审批申请 | ✅ 全部 | ✅ 全部 | ✅ 仅自己 | — | ✅ 仅自己 |

**Settings 新增字段**：`firmLegalRepUserId`（律所法定代表人，唯一）

### 12.7 与卷宗模板的联动（重要）

§十一 模板生成的法律意见书/律师函等文档，可在卷宗页**右键 → "提交用章"** 一键创建 SealRequest，自动带上：
- `draftDocId` = 该文档
- `matterId` = 当前 Matter
- `documentTitle` = 文档名

这是 v0.8 两个模块联动的核心场景：**律师在卷宗内用模板生成文书 → 直接提交用章审批 → 盖章后扫描件回挂到卷宗**。一条流水线打通。

### 12.8 实施分期

| 阶段 | 范围 |
|---|---|
| **v0.8.x** | SealRequest schema + 5 种内置章 + 三 tab + 申请/审批/盖章工作流 + 与卷宗模板联动 |
| **v0.9** | `/settings/seals` 自定义章种类 + 用章月报导出 + 律师用章统计图表 |
| **v1.5** | 邮件/微信通知审批人和申请人 |

### 12.9 已决策（2026-05-23）

1. **章种类** = 5 种内置 + `requireCrossPageSeal` 作为**勾选项**（不做独立章 type）。  
   *理由：骑缝是盖章工艺不是章种类，独立 type 会引入概念冗余。*
2. **审批角色映射** = 用 `SealTypeConfig` 配置表存 `approverRoles: Role[]` **多角色 OR 关系**（按角色映射，不按 User，灵活但仍硬编码角色）。  
   *理由：律所常见"主任不在合伙人代审"场景；数组 vs 单值的 schema 区别极小、工程成本可忽略。*
3. **盖章后扫描件** = **强制必传**（status 从 APPROVED 进入 STAMPED 必须有 `stampedDocId`）。  
   *理由：合规留档关键，事后无法补的环节必须卡死。*
4. **关联案件** = **可选**（保持当前方案）。  
   *理由：所内行政、对外宣传、人事等用章场景确实可能没有关联案件，强制反而劝退。*

### 12.10 v0.8.0 实施前置（待用户启动）

下一步是**改 schema**（DocumentTemplate / DocumentFolder / SealRequest 三张新表 + Document 加 folderId/templateId + Settings 加 firmLegalRepUserId），属于 CLAUDE.md 红线"数据库 schema 变更"，需用户明确指令后启动。

---

## 十三、v0.9 规划：差异化生产力工具集（草案，待确认）

> 来源：2026-05-23 对照旧版「案件管理系统-Mac版」分析（13 个模块全扫），抽取出 LawLink 完全没做、对律师日常效率提升最大的 5 块功能。架构上不参考旧系统（旧系统 localStorage + 单 HTML，LawLink 已有更成熟的 Postgres + Next.js）。

### 13.1 设计目标

把 LawLink 从「案件管理系统」升级为「律师日常生产力工具」——区别于 Alpha 律所、无讼等同类系统的**差异化点**集中在：

1. **法院短信自动解析**：律师每天被 12368 / 法院 / 电子送达短信轰炸，手动登记到对应案件是最大消耗
2. **财产保全独立模块**：商事案件几乎每案必涉，漏续保 = 冻结失效 = 执业事故
3. **律师工具箱**：诉讼费 / 迟延履行金 / 大写金额等高频速算
4. **AI 基础设施**：统一接入 OpenAI 兼容协议（通义/DeepSeek/Kimi/智谱/Ollama），为短信 AI 解析 / 发票 OCR / 后续文书智能审查打底
5. **快递追踪**：寄出/收到的法院文书、当事人资料可视化跟踪

排除：旧系统的"通知中心聚合"先放放（壳子先建短信和保全两块内容再说）；ICS 日历导出顺手做。

### 13.2 模块一：法院短信解析 `/inbox`

**核心场景**：律师收到一条短信 → 复制粘贴到收件箱 → 系统自动解析出案号 / 法院 / 开庭时间 / 法官 / URL / 登录凭证 / 重要事项 → 按案号匹配 Matter → 一键落到该案 Deadline/Hearing；如短信含电子送达链接，系统先识别文书入口，并在已关联案件时尝试把直链或页面内可发现的 PDF/Word/图片/压缩包下载为案件材料。

**Schema 新增**：

```prisma
model SmsMessage {
  id              String          @id @default(cuid())
  rawText         String          // 原始短信文本
  receivedAt      DateTime        @default(now())
  receivedById    String
  receivedBy      User            @relation(fields: [receivedById], references: [id])

  // 解析结果（JSON 包含 caseNumbers / court / hearingDate / urls / judge ...）
  parsedJson      Json
  smsType         SmsType         @default(OTHER)

  // 关联匹配
  matchedMatterId String?
  matchedMatter   Matter?         @relation(fields: [matchedMatterId], references: [id])
  matchedBy       SmsMatchSource  @default(UNMATCHED)   // AUTO_CASE_NUMBER / MANUAL / UNMATCHED

  // 处理动作
  generatedHearingId  String?     // 一键生成的 Hearing
  generatedDeadlineId String?     // 一键生成的 Deadline
  processed       Boolean         @default(false)
  processedAt     DateTime?

  createdAt       DateTime        @default(now())

  @@index([receivedById, processed])
  @@index([matchedMatterId])
}

enum SmsType {
  HEARING_NOTICE      // 开庭通知
  SERVICE_NOTICE      // 送达通知
  FEE_NOTICE          // 缴费通知
  MEDIATION           // 调解通知
  ENFORCEMENT         // 执行通知
  FILING_NOTICE       // 立案通知
  JUDGMENT_NOTICE     // 判决通知
  EVIDENCE_SUBMIT     // 提交材料/举证
  OTHER
}

enum SmsMatchSource {
  AUTO_CASE_NUMBER    // 按案号自动匹配
  MANUAL              // 用户手动指派
  UNMATCHED
}
```

**实现**：

- `src/lib/sms-parser.ts`：直接搬旧系统 `server.py` 的正则规则（10+ 字段，已完整覆盖），改 TS
- 双路径：正则（无网络也可）+ AI 兜底（接 §13.5 统一 AI 客户端）
- 自动匹配：按解析出的 `caseNumber` 在 `MatterProcedure.caseNumber` 反查
- 批量解析：按空行分隔多条短信一次提交
- 电子送达附件：解析 URL、平台、账号、密码、验证码/提取码；普通文件直链或公开页面内文件链接可自动下载并落到 `Document`，需要网页登录、验证码、人机校验或专有流程的平台仅提示人工处理；卡片中只展示脱敏凭证，原始短信仍按审计需要保留。

**UI**：

- 左下角辅助导航区在"归档"上方固定展示 `/inbox`（图标 `Inbox`）—— 法院短信，并使用独立强调色区别于普通导航项
- 列表：未处理 / 已处理 / 全部 tab
- 卡片显示：短信类型徽 + 时间 + 摘要 + 重要事项/时间 + 电子送达入口 + 附件提取状态 + 匹配的案件链接 + 一键"生成开庭" / "生成期限" / "提取附件" / "标记已处理"
- 详情抽屉：原文 + 解析字段表 + 手动指派 Matter 按钮

**字段抽取覆盖**（直接搬旧系统正则）：

| 字段 | 来源正则模式 |
|---|---|
| 案号 | `(2024)京01民初123号` 类 |
| 法院 | 优先 `【XX法院】`，再贪婪匹配 |
| 开庭日期时间 | 多种格式（YYYY年M月D日 HH:MM / YYYY-MM-DD HH:MM 等） |
| 立案日 / 判决日 | 上下文关键词触发 |
| 上诉期限 | `15 日内提出上诉` 类 |
| 法庭 | `第三法庭 / 民事审判庭 / 调解室` |
| 法官 / 书记员 | `承办法官 XXX` / `XXX 法官` |
| 电话 | 手机 + 座机 |
| URL + 平台识别 | 智诉 / 12368 / 湖北法院 / 人民法院在线服务 等 8 个平台 |
| 登录凭证 / 提取码 | 账号、密码、验证码、提取码、查询码等 |
| 重要事项 | 围绕日期上下文识别开庭、举证、缴费、调解、送达、上诉、履行、执行等动作 |
| 金额 | `人民币 XXX 元` |

### 13.3 模块二：财产保全 `/preservation`

**核心场景**：律师立案/诉前/执行阶段办了保全 → 录入到期日 → 系统按 30/15/7/3/1 天分级提醒 → 续保流程留痕。

**Schema 新增**：

```prisma
model Preservation {
  id              String              @id @default(cuid())
  matterId        String
  matter          Matter              @relation(fields: [matterId], references: [id], onDelete: Cascade)

  type            PreservationType    // 诉前/诉中/执行
  propertyType    PropertyType        // 存款/房产/车辆/股权/知识产权/其他
  amount          Decimal?            // 保全金额
  respondent      String              // 被保全人
  guaranteeType   GuaranteeType?      // 保证金/保函/财产担保/无需担保

  appliedAt       DateTime?           // 申请日
  startDate       DateTime            // 生效日（必填）
  duration        Int                 // 保全期限（天）；默认按 propertyType 推荐 365/730/1095
  expiryDate      DateTime            // 到期日（startDate + duration，可手动覆盖）

  court           String?             // 保全法院
  rulingNumber    String?             // 裁定书编号
  propertyDetail  String?             // 财产细节描述
  note            String?

  ownerId         String?             // 跟进负责人
  owner           User?               @relation(fields: [ownerId], references: [id])

  remindDays      Int[]               // 提醒阈值，默认 [30, 15, 7, 3, 1]
  status          PreservationStatus  @default(ACTIVE)
  renewals        PreservationRenewal[]

  createdAt       DateTime            @default(now())
  updatedAt       DateTime            @updatedAt

  @@index([matterId])
  @@index([status, expiryDate])
}

model PreservationRenewal {
  id                String        @id @default(cuid())
  preservationId    String
  preservation      Preservation  @relation(fields: [preservationId], references: [id], onDelete: Cascade)
  renewedAt         DateTime
  oldExpiryDate     DateTime
  newExpiryDate     DateTime
  renewalDuration   Int           // 新增的天数
  note              String?
  performedById     String
  performedBy       User          @relation(fields: [performedById], references: [id])
  createdAt         DateTime      @default(now())

  @@index([preservationId])
}

enum PreservationType { PRE_LITIGATION; LITIGATION; ENFORCEMENT }
enum PropertyType { BANK_DEPOSIT; REAL_ESTATE; VEHICLE; EQUITY; IP; OTHER }
enum GuaranteeType { CASH_DEPOSIT; GUARANTEE_LETTER; PROPERTY; NONE }
enum PreservationStatus { ACTIVE; RENEWED; EXPIRED; LIFTED }   // 生效/已续/已到期/已解除
```

**保全期限默认值（法律依据写死）**：

| 财产类型 | 默认天数 | 法律依据 |
|---|---|---|
| 银行存款 | 365（1 年） | 民诉法第 244 条 |
| 动产（车辆、机器设备） | 730（2 年） | 同上 |
| 不动产、知识产权、股权 | 1095（3 年） | 同上 |

**UI**：

- 一级菜单加 `/preservation`（图标 `Shield`）
- 列表 + 状态筛选（生效/已续/已到期/已解除）+ 搜索（案件/被保全人/财产类型）
- 卡片显示：关联案件 + 保全类型 + 财产类型 + 金额 + 到期倒计时（红 ≤7d / 琥 ≤30d / 绿 >30d）
- Matter 详情加 "保全" sub tab（在卷宗 tab 旁边）
- 续保流程：独立 Dialog，记录 renewal 后自动更新 expiryDate + status=RENEWED
- 到期预警通过现有 `Deadline` 表派生条目（不重复存提醒逻辑）

### 13.4 模块三：律师工具箱 `/tools/calc`

**首批 3 个高频计算器**（其余推到 v0.9.2）：

1. **诉讼费计算器**：
   - 输入：案件类型（财产 / 离婚 / 劳动 / 知识产权 / 其他）+ 标的金额
   - 输出：诉讼费 + 简易程序减半值
   - 费率：《诉讼费用交纳办法》全国统一分段累进（旧系统 `tbCourt` 已完整实现，可直接 port）

2. **迟延履行金计算器**：
   - 输入：判决金额 + 应履行日 + 实际履行日 + LPR 1Y/5Y（默认从配置取）
   - 输出：迟延履行期间利息（年利率 LPR + 5% 计基础利率，再按民诉法解释 463 条规则）

3. **天数计算器**：
   - 两个日期间天数 + 排除周末选项
   - 从某日加/减 N 天得到目标日（举证期限、上诉期常用）

**实现**：

- 路由 `/tools/calc`，纯客户端，无 schema 改动
- `src/lib/legal-calc.ts` 封装算法（含旧系统 `numToCn` 大写金额转换）
- 案件详情页财务 tab 加"快速算诉讼费"按钮，输入标的额一键弹出结果

**v0.9.2 候选**：律师费指导价 / 违约金 / 利息 / 申请执行日期

### 13.5 模块四：AI 基础设施

**核心**：所有 AI 功能走 OpenAI 兼容协议，用户自由选 provider。

**Schema 新增**（SystemSetting 表已有，加 4 条 key）：

```
ai_api_key       String (加密存)
ai_base_url      String  默认 https://dashscope.aliyuncs.com/compatible-mode/v1
ai_text_model    String  默认 qwen-turbo
ai_vision_model  String  默认 qwen-vl-max
```

**实现**：

- `src/lib/ai/client.ts`：封装 `chat({ messages, model? })` 和 `vision({ image, prompt, model? })`
- 设置页 `/settings/ai` 配置 + 测试连接按钮
- API key 用现有 `encryptBuffer` 加密存（与文档加密复用同一密钥）

**首批接入功能**：

1. **发票 OCR**：用户在 InvoiceRequest 上传发票图 → 自动填发票号/销售方/购买方/金额/税额（旧系统 `recognize_invoice` prompt 直接搬）
2. **法院短信 AI 解析**：§13.2 双路径中的 AI 兜底
3. **预留**：v1.0 文书智能审查、案由推荐

### 13.6 模块五：快递追踪 `/express`

**核心**：律师寄出/收到法院文书、当事人材料的物流跟踪。

**Schema 新增**：

```prisma
model ExpressTracking {
  id              String      @id @default(cuid())
  matterId        String?
  matter          Matter?     @relation(fields: [matterId], references: [id])
  trackingNo      String
  companyCode     String?     // 中文公司名
  direction       ExpressDirection   // OUTBOUND（寄出）/ INBOUND（收到）
  purpose         String              // 用途说明（如：起诉状寄朝阳法院）
  recipient       String?             // 收件人/单位
  recipientPhone  String?

  lastState       String?             // 揽件 / 在途 / 已签收 / 退签
  lastUpdateAt    DateTime?
  tracesJson      Json?               // 完整轨迹缓存

  createdById     String
  createdBy       User                @relation(fields: [createdById], references: [id])
  createdAt       DateTime            @default(now())
  updatedAt       DateTime            @updatedAt

  @@index([matterId])
  @@index([trackingNo])
}

enum ExpressDirection { OUTBOUND; INBOUND }
```

**实现**：

- `src/server/express/actions.ts`：track / refresh / list
- 双 provider（快递鸟 + 快递100），API key 走 SystemSetting
- 单号前缀自动识别公司
- 案件详情卷宗 tab 加"寄送记录"区，显示该案的所有 ExpressTracking

### 13.7 实施分期

| 阶段 | 范围 | 估算 |
|---|---|---|
| **v0.9.0**（差异化主战场） | §13.2 短信解析（仅正则路径，无 AI 也可用）+ §13.3 财产保全完整模块 | 12-15 commit |
| **v0.9.1**（AI 基础设施） | §13.5 AI 客户端 + Settings + §13.2 短信 AI 兜底 + 发票 OCR 接入 InvoiceRequest | 5-7 commit |
| **v0.9.2**（工具箱 + 快递） | §13.4 三个计算器 + §13.6 快递追踪 + Matter 详情联动 | 5-7 commit |
| **v0.9.3**（提醒打通） | ICS 日历导出（保全/开庭/期限）+ 通知聚合中心壳 | 3-4 commit |

### 13.8 已决策（2026-05-23 深夜）

1. **短信解析** = **手动复制粘贴**（不做自动转发/SMS API 集成）。  
   *理由：律所运维成本最低；律师每天打开 /inbox 粘贴一次（30 秒），自动转发要用户去运营商/邮件服务商配，性价比低。SMS API 留作 v1.5 评估。*

2. **AI provider 默认预填通义千问 + 可改 DeepSeek 等**（base_url + model 字段用户随时改）。  
   *理由：阿里云百炼免费额度大，新用户上手最快；但 OpenAI 兼容协议本身就支持任意 provider，UI 上 4 字段（key/base_url/text_model/vision_model）独立可改即可，不需要硬绑通义。*

3. **诉前保全 Matter 关联 = 可选**（startDate 阶段可空 matterId，立案后回填）。  
   *理由：诉前保全 30 天内必须起诉，期间 Matter 可能尚未建立；强关联会逼用户先建空壳 Matter，反劝退。*

4. **保全到期提醒 = 站内**（dashboard 卡片 + 复用 Deadline 派生条目，不发邮件）。  
   *理由：律所自部署不强制配 SMTP；站内提醒已能命中每日工作流。邮件留作 v1.0 选项。*  
   *本条用户未直接回答，按 v0.9 起草人倾向走，v0.9.3 提醒打通阶段如需调整可再讨论。*

5. **诉讼费在 Matter 详情自动显示** = **自动**（标的额非空时在案件头部展示"诉讼费约 ¥X"小字）。  
   *理由：律师每次起诉都要算，自动显示价值大于占位成本。*  
   *本条用户未直接回答，按 v0.9 起草人倾向走，v0.9.2 工具箱实施时落地，如需调整可再讨论。*

### 13.9 v0.9.0 启动（2026-05-23 深夜）

§13.8 的 5 项决策已锁，下一步进入 v0.9.0 Phase 1：

| Commit 段 | 范围 |
|---|---|
| **C1 schema** | SmsMessage / Preservation / PreservationRenewal 三表 + 6 枚举 + Matter/User 反向关系 + migration + DATA-MODEL.md 更新 |
| **C2 短信解析** | `src/lib/sms-parser.ts`（正则全套）+ `src/server/sms/actions.ts`（parseAndSave/match/generateHearing/generateDeadline/markProcessed）+ `/inbox` UI + nav |
| **C3 财产保全** | `src/server/preservations/actions.ts`（CRUD + renew + listExpiring）+ `/preservation` UI + Matter 详情 sub tab + nav + dashboard 到期预警卡 |

---

## 十四、v0.10–v0.15 概要（已落地，详见 git log）

PRD 同步在 v0.10 起一度滞后；这一段以 commit 历史为准，本节仅记录每版主轴方便后人定位：

| 版本 | 主轴 |
|---|---|
| v0.10 | Topbar 三件套（NotificationPopover / SearchDialog ⌘K）+ 通知中心 + 全局搜索 + 权限层（visibility filter）+ 存储抽象 + 文档审批 + dashboard 真实预警 + 移动响应式 + vitest 27 测试 |
| v0.11 | 用户 12 条需求分 6 批：UI 微调 / 信息架构合并 / 律师费精简（migration v11_fee_simplify）/ 归档向导引用结案小结 / 起诉状 OCR 骨架（unpdf）/ 发票 PDF 上传 |
| v0.12 | 用户第二轮 10 条需求 + 案件详情瘦身 + 开票申请重构 + 日程月历视图 + 工具弹窗化 + 案由扩充 |
| v0.13 | 用户第三轮 10 条 + 全量案由 1729 条入库（Python 脚本生成）+ 案件列表卡片样式（4 tabs：待审批/进行中/待补正/已归档）+ AddTaskDialog 时间选择器 |
| v0.14 | NEEDS_REVISION 状态枚举 / InvoiceRequest.invoiceNo + issuedAt / 起诉状 OCR 支持 PDF |
| v0.15 | 对比度调优：page bg 浅灰 / border 加深 / tabs docking 风格 |

---

## 十五、v0.16 案件管理深化（已落地）

### 15.1 设计目标
2026-05-25 用户第四轮 11 条需求（A-H 八批合并 + 一些 schema 变更）。重点：
- 整站去 italic（律所文风偏端正）
- 删大事记 + 导出日历（使用率低）
- 案件协办（合并发起审批入口）
- 利益冲突不查同名（避免误报）
- "全部案件" tab 移最前 + MattersTable 改 divide-y 紧凑布局
- **归档审批流**（schema 变更）：律师提交归档不再立即结案，需 ADMIN 审批；ADMIN 自己提交自动通过
- 案由级联选择器重写（4 列展开，民事 1059 / 刑事 548）

### 15.2 数据模型新增
- `ArchiveRecord.status` 枚举：`PENDING_REVIEW` / `APPROVED` / `REJECTED`
- migration `v16_archive_review`
- 缺项材料警告色：黄 → 红（更醒目）

### 15.3 实施清单
- `1324baa` v0.15 对比度调优
- `691c551` 轮4 批 A+B+C：去 italic / 删大事记 / 协办
- `50535ea` 轮4 批 D+E+F：重要时限及提醒 + "全部案件" tab + MattersTable 紧凑布局
- `f388e32` 轮4 批 G：归档审批流（schema 变更）
- `ae89dd7` 轮4 批 H：CauseCombobox 4 列级联重写 + searchCauses cap 2000

---

## 十六、v0.17 闭合归档功能缺口（已落地）

### 16.1 设计目标
v0.16 加了归档审批流，但缺三块配套：admin 审批 UI / inline 上传归档材料 / S3 provider 真实化（之前是 stub）。

### 16.2 数据模型新增
- `Document.archiveChecklistItemId String?` —— 文档关联归档清单项（便于自动勾选）
- 索引 `(matterId, archiveChecklistItemId)`
- migration `v17_doc_checklist_link`
- `uploadDocument` action 新增 `archiveChecklistItemId` 参数

### 16.3 实施清单
- `9bad4cf` 加 `@aws-sdk/client-s3` 依赖 + .env.example 加 S3 配置注释
- `7f9df02` schema 变更 + uploadDocument 接受新参数
- `4207bd1` S3 provider 完整实现替换 stub（PutObject/GetObject/DeleteObject + stream→Buffer 兼容 MinIO/R2/阿里云 OSS）
- `158e879` admin 审批 UI：`/archive` 加 admin-only「待审批/已归档」tab / `listPendingArchiveRecords` / `PendingArchiveTable`（通过/驳回/查看 Dialog）/ 修复 `listArchivedMatters` 漏过滤 / 归档 wizard 每个 checklist item 旁加「上传」按钮 → 上传时关联 → 自动勾选 → 文件名 chip + 绿色"已上传 N 份"

---

## 十七、v0.18 归档驳回流转闭环（已落地）

### 17.1 设计目标
v0.17 后 admin 能驳回归档，但律师端没有反馈通路：被驳回后律师不知道、不知道为啥被驳、不知道怎么重新提交。本期闭合。

### 17.2 数据模型新增
- `ArchiveRecord.archivedById String?` —— 追踪申请人（之前只有 archivedBy 字符串）
- `NotificationType` 新增 `ARCHIVE_APPROVED` / `ARCHIVE_REJECTED`
- migration `v18_archive_feedback`

### 17.3 实施清单
- `82ca43c` 后端：`approveArchiveRecord` / `rejectArchiveRecord` 发通知给申请人 / `listRejectedArchiveRecords`（律师端查自己被驳回的）/ `getLatestArchiveRecord`
- `22a1ff4` 前端：案件详情页 `ArchiveStatusBanner` 组件显示驳回（红）/审批中（紫）状态 / 驳回时显示原因 + 上次缺项 + "重新归档"按钮 / 重用 `ArchiveWizardDialog`

---

## 十八、v0.19 AI 复用扩展三件套（已落地）

### 18.1 设计目标
依托 v0.9.1 AI 基础设施 + 元典开放平台 MCP，打开三个 AI 能力入口：案由推荐 / 文书智能审查 / 类案检索。差异化壁垒最强方向。

### 18.2 实施清单
- `b820764` **A1 案由推荐**：收案表单上传起诉状 OCR 完成后，自动把 cause + claimDescription + 对方当事人 + 法院信息送 LLM → 返回 3 个 4 级案由名 + 推荐理由 + 高/中/低置信 → `searchCauses` 反查兜底（过滤 level<3 笼统分类）→ Dialog 选用直接 `setValue causeId`；仅当 `!causeId && OCR 抽到内容` 时触发；后续在 CauseCombobox 旁加 ✨ 按钮做 manual 入口（见 §19.2）
- `c182559` **A2 文书智能审查**：案件详情→文档卡片 ✨ 按钮，`reviewDocument` server action 从 storage 读 + 解密 → 抽文本（PDF unpdf / DOCX mammoth 新依赖 / 纯文本）→ AI → 结构化清单（MISSING/RISK/ISSUE/SUGGESTION × HIGH/MEDIUM/LOW，4-10 条）；文本 6000 字符截断；解析逻辑抽到 `src/lib/ai/review-parser.ts`（"use server" 文件不能 export 同步函数）
- `632b5d4` **A3 类案检索**：案件详情新 tab"类案" → 调元典 `rh_ptal_search` HTTP API（POST `https://open.chineselaw.com/open/rh_ptal_search`，X-API-Key 鉴权，10 POINT/次）；默认案由从 `matter.cause` 带入；表单支持案由/全文关键词/省份/文书种类/日期/top_k；结果列表 + 详情外跳

### 18.3 数据模型变更
仅新增 SystemSetting 单 key `yuandianSettings`（apiKey 加密存，复用 STORAGE_ENCRYPTION_KEY；baseUrl 默认 `https://open.chineselaw.com/open`；caseDetailHost 默认 `https://www.chineselaw.com`）。无 prisma migration。

### 18.4 设置页扩展
设置 → AI 接入 增加"元典案例库 API" section：API key（脱敏显示）/ base URL / 案例详情前端域名 / 保存 + 测试连接（探活时扣 10 POINT）/ 清除 key。

### 18.5 测试
- recommend-cause.test.ts（7）：命中 / 反查丢失 / level 过滤 / 全丢错 / JSON 错 / 短输入 / 置信度规范化
- review-parser.test.ts（8）：排序 / 空数组 / 字段缺失丢弃 / 非法值回退 / 大小写规范化 / markdown 包裹 / 非数组错 / 无 JSON 错
- yuandian-client.test.ts（10）：未配置错 / 空 params 错 / body 构造 / data=null 未命中 / failed / HTTP 401 / top_k 边界 / 空白 qw / URL 拼接

---

## 十九、v0.20 admin 批量审批 + 律所报表 + 闭环系列（已落地）

### 19.1 设计目标
- **B**：归档申请量大时 admin 需要批量通过/驳回（含统一原因）
- **C**：律所首次拥有"年度统计"出口，KPI + xlsx 导出
- **A1/A2/A3 闭环**：三个 AI 入口各补齐手动入口 / 存档到本案 / 自定义时间范围等尾巴

### 19.2 实施清单
- `548ba92` **B 批量审批 UI**：待审批表格加全选 + 行 checkbox + 选中时顶部 toolbar；`batchApproveArchiveRecords` / `batchRejectArchiveRecords` 循环复用单条 action，逐条独立处理（失败不阻断），返回 `{ succeeded, failed[] }`；上限 100 条/次；批量通过 Dialog 列出有缺项的归档号；批量驳回必填统一原因
- `1c2ad8e` **C 律所报表 `/reports`**（admin / PRINCIPAL_LAWYER 可见）：4 KPI（本期新收 / 在办 / 已结 / 已归档 + 归档率）+ 类别分布纯 CSS 柱图 + 律师产出表 + 客户应收表；时间 chip 切换本月/本季/本年/上年；导出 xlsx 多 sheet（案件清单 / 收款明细 / 律师产出 / 客户应收，exceljs 新依赖）；GET `/api/reports/export` 写 `REPORT_EXPORT` audit；sidebar 加"报表"入口
- `bbaa202` **A3 闭环 类案存到本案**：类案检索结果旁加"存档"按钮 → `saveCaseToMatter` 把案号/法院/日期/案由/链接/正文片段拼 md → `storage.writeFile` → `Document.create(category=JUDGMENT, tags=[类案, 元典])`；归档案件拒写；写 `YUANDIAN_CASE_SAVE` audit
- `7c39bc6` **A1 闭环 案由 manual 入口**：CauseCombobox 旁 ✨ 按钮，弹 `CauseAiManualDialog`（tab 切换「用现有字段」/「自由输入」），intake-sheet 和 matter-sheet 都接入；复用 v0.19 `recommendCause`，无需改后端
- `004ea59` **D3 报表自定义时间范围**：时间 chip 加「自定义」选项，展开 date range picker，跳 `?period=custom&start=...&end=...`；导出同步支持；`customPeriod` 半开区间含 end 当天、上限 5 年跨度；非法时报错回退本年
- `d25e55c` **A2 闭环 审查结果存到本案**：DocumentReviewDialog 加"存到本案"按钮 → `saveReviewToMatter` 按 type 分组拼 md → `Document.create(category=OTHER, tags=[AI审查, 存档])`；文件名含审查时间戳，同份文档可多次审查留档

### 19.3 数据模型变更
无 schema 变更。所有"存到本案"功能复用现有 Document 表 + tags 机制；报表只读聚合不动表。

### 19.4 测试
- reports-period.test.ts（12）：periodPresets 6 个边界（Q1/Q4、跨年月、上年）+ customPeriod 6 个（合法/格式错/反序错/同一天/5 年/跨月）
- 累计 65 测试，typecheck ✓

### 19.5 后续候选
- **文书审查保存历史**（完整版）：新增 `ReviewRecord` 表保留历次审查，Dialog 打开时显示历史（v0.21 §20）
- **律师周报推送**：dashboard 加"本周摘要"卡 + admin 手动推送 Notification（不依赖 cron）
- **AI 复检按钮（案件详情顶部）**：已选过案由的案件也能重评估
- **批量审批审计回溯**：失败条目可单独重试

---

## 二十、v0.49 法定期限引擎（已落地）

> 来源：docs/ROADMAP.md P0。期限漏记是律师执业事故头号来源；此前 `Deadline` 全靠手填。

### 20.1 设计

- **新表 `DeadlineRule`**（法定期限规则库）：触发事件文案 + 期限数值/单位（日/月/年）+ 期限类别 + 法条依据 + 元典核验时间 + 适用程序/案件类别 + 建议提醒天数。内置规则 seed（`isBuiltIn`），支持 `enabled` 开关；律所自定义规则管理 UI 留 v0.50。
- **生成入口**：AddDeadlineDialog 顶部新增"按法定期限生成"区——选规则（按当前程序类型+案件类别过滤）→ 填触发日期 → 预览到期日 → 一键填入表单（名称/类型/到期日/依据/提醒天数），仍走原 `addDeadline` 提交，权限校验不变。
- **期间计算**（民诉法 2023 修正第 85 条，已核验）：按日的期间开始之日不计入（送达日 +N 日）；按月/年到期月对应日（无对应日取月末）。**系统不内置法定节假日表**，生成的到期日如遇法定休假日需人工顺延，UI 与 basis 文本中均有提示。

### 20.2 首批内置规则（12 条，2026-07-04 全部经元典核验、现行有效）

| code | 规则 | 期限 | 触发点 | 依据 |
|---|---|---|---|---|
| CIVIL_APPEAL_JUDGMENT | 民事上诉（不服判决） | 15 日 | 判决书送达之日 | 民事诉讼法(2023修正)第171条 |
| CIVIL_APPEAL_RULING | 民事上诉（不服裁定） | 10 日 | 裁定书送达之日 | 同上 |
| CIVIL_DEFENSE_FIRST | 一审答辩期 | 15 日 | 收到起诉状副本之日 | 第128条 |
| CIVIL_DEFENSE_SECOND | 二审答辩期 | 15 日 | 收到上诉状副本之日 | 第174条 |
| CIVIL_JURISDICTION_OBJECTION | 管辖权异议（答辩期内提出） | 15 日 | 收到起诉状副本之日 | 第130条 |
| CIVIL_RETRIAL_APPLY | 申请再审 | 6 个月 | 判决/裁定发生法律效力之日 | 第216条 |
| CIVIL_ENFORCEMENT_APPLY | 申请强制执行 | 2 年 | 履行期间最后一日 | 第250条 |
| PRE_LITIGATION_PRESERVATION_SUE | 诉前保全后起诉/申请仲裁 | 30 日 | 保全措施采取之日 | 第104条 |
| ARBITRATION_SET_ASIDE_APPLY | 申请撤销仲裁裁决 | **3 个月** | 收到裁决书之日 | 仲裁法(2025修订)第72条 ⚠️ 旧法为 6 个月，2026-03-01 起施行新法；旧裁决过渡期适用需个案判断 |
| LABOR_ARBITRATION_SUE | 不服劳动仲裁裁决起诉 | 15 日 | 收到仲裁裁决书之日 | 劳动争议调解仲裁法第50条 |
| ADMIN_APPEAL_JUDGMENT | 行政上诉（不服判决） | 15 日 | 判决书送达之日 | 行政诉讼法(2017修正)第85条 |
| ADMIN_APPEAL_RULING | 行政上诉（不服裁定） | 10 日 | 裁定书送达之日 | 同上 |

**核验说明**：旧 PRD §13.3 所记「保全期限依据民诉法第 244 条」已确认为错误引用（见 DATA-MODEL §4.20）。本批规则逐条经元典 `rh_ft_search` / `rh_ft_detail` 核验并存 `legalBasisUrl` + `verifiedAt`；举证期限因属法院指定期间（非固定天数）不入规则库。

### 20.3 决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | 规则生成走"填入表单"而非直接落库 | 律师需人工确认到期日（节假日顺延、送达日争议）；保留原 addDeadline 单一提交路径 |
| 2 | 不内置节假日表 | 法定节假日每年国务院调整，内置即过时；到期日临近的提醒机制已能兜底 |
| 3 | 月/年期间按到期月对应日计算 | 司法实践通行做法；无对应日取月末 |
| 4 | 规则库管理 UI（增删改）留 v0.50 | 首批内置规则已覆盖高频场景；enabled 开关可先用 DB 操作 |

## 二十一、v0.50 提醒触达（已落地）

> 来源：docs/ROADMAP.md P1。站内通知只对天天开系统的人有效；本期让提醒走出系统。

### 21.1 ICS 日历订阅（每用户）

- `User.calendarToken`（unique，URL 即凭证）；日程页右上角在「添加日程」旁提供「订阅日历」次级按钮，点击弹窗展示订阅说明、复制订阅链接 / 重置（作废旧链接）。仅打开弹窗时获取链接；个人设置不再展示订阅卡片。订阅为单向读取 LawLink 日程。
- `GET /api/calendar/{token}`（proxy 白名单放行）：返回该用户可见范围内 过去 7 天 ~ 未来 90 天 的开庭（带时间 + 提前 1 天/2 小时提醒）、期限 / 任务 / 保全到期（全天事件 + 提前 1 天提醒）
- 隐私：事项标题只带客户名/案件编号，不含完整案件名；token 生成与重置写审计
- 实现：`listScheduleItems` 的查询体抽到 `server/schedule/query.ts`（无 session 依赖），action 与 ICS 路由共用；复用 v0.9.3 的 `lib/ics.ts`

### 21.2 群机器人推送（企业微信 / 钉钉）

- SystemSetting 单 key `notifyWebhook`（enabled + url）；两家自定义机器人同用 `{"msgtype":"text","text":{...}}`，无需区分厂商
- 设置 → 提醒维护（管理员/主任律师）新增配置卡片：地址 + 启用开关 + 发送测试消息
- 每日 09:00 到期扫描产生新提醒时推一条汇总（≤20 行，只含事项标题与案件编号）；未配置静默跳过，失败写 audit 不中断扫描

### 21.3 备份 cron 化

- 每天 02:30 调 `scripts/backup.sh`（pg_dump + storage 打包）到 `BACKUP_DIR`（默认 ./backups），保留最近 `BACKUP_KEEP` 份（默认 14）
- 失败给所有有效 `SUPER_ADMIN` 发 HIGH 站内通知（备份静默失败等于没有备份）；`BACKUP_CRON_ENABLED=false` 可关（无 pg_dump 的部署环境）
- 补齐 PRD §六"内置 pg_dump 备份脚本（cron 触发）"的承诺

### 21.4 决策

| # | 决策 | 理由 |
|---|---|---|
| 1 | ICS 不做 Basic Auth，token 即凭证 | 日历客户端对带认证的订阅支持参差；token 可随时重置，与主流 SaaS 日历订阅一致 |
| 2 | webhook 推汇总不推单条 | 到期集中时逐条刷群会让人屏蔽群，一天一条汇总保住注意力 |
| 3 | 备份默认开启、失败通知 SUPER_ADMIN | 自部署用户不会主动配备份；失败可感知比默认关闭更安全 |

## 二十二、v0.51 收件箱闭环（已落地）

> 来源：docs/ROADMAP.md P2。"待人工队列"已在 v0.48 提前落地（needsManualAction + 待人工 tab）。

1. **案号回填**：立案/受理短信解析出案号后，已关联案件的卡片出现"回填案号"按钮（仅当案件存在缺案号的程序且案号未被占用）→ Dialog 选案号+目标程序 → 写入 `MatterProcedure.caseNumber`。约束：只能回填本条短信真实解析出的案号（防伪造）；已有案号的程序不覆盖（更正走程序信息编辑）；写时间线 + 审计。
2. **生成草稿预填增强**：开庭/期限弹窗的"关联程序"默认选中案号与短信一致的程序（原为第一个）；期限标题/类别/截止日优先取 v0.47 重要事项抽取结果（importantItems 分类比 smsType 更细），无命中再走原 smsType 推断。

## 二十三、v1.0 收口·政策项（已落地部分）

按 ROADMAP 伪需求清单执行（不删功能与数据，改默认值与呈现权重）：

1. **外部联系人审核流默认关闭**：新增 SystemSetting `workflowToggles.externalContactReview`（默认 false——新增联系人直接通过并全所可见）；管理后台“律所信息”页的“工作流开关”卡片可打开审核。原审核通道、通知、审计逻辑保留不动。
2. **分成降级为只读记录**：案件财务面板的"分成"卡仅在实际产生分成时展示；财务页"我的本月/本年分成"KPI 同理；实收录入的按钮与提示不再宣传"自动分成"（server 端有方案时仍自动计算，行为不变）。
3. **移动端**：v0.47 程序工作台自带 `grid-cols-1 md:*` 响应式栈叠，代码审查未发现横向溢出点；真机走查留待发布前人工验证。

4. **文书模板扩容（P3，已落地）**：内置模板 10 → 22。第二批 12 个：授权委托书(单位)、民事上诉状、仲裁申请书、财产保全申请书（依据民诉法 103/104 条，本会话已核验）、律师函、法律意见书、代理词、谈话笔录、会见笔录(刑事)、结案登记表、证据目录、空白文档(律所抬头)。全部经 docxtemplater 渲染实测；变量以 template-engine 渲染上下文为准。

至此 ROADMAP 分期全部完成，v1.0 达到"对外可推荐给同行"的收口标准（发布前建议：真机移动端走查 + 一轮完整金线人工验收）。


### 律师团队与成员案件汇总（2026-09-06）

- 系统超级管理员管理团队名称、负责人、成员和额外团队查看授权。负责人自动作为成员，支持一人多个团队；停用保留记录。
- 团队负责人登录后，在原案件列表自动看到本团队成员原始立案或当前主办的所有可用案件，覆盖历史、在办、结案、归档及收案阶段。按当前成员关系动态计算，不增加案件所属团队字段，不逐案分配。
- 普通团队成员不互相开放案件。额外查看人员由超级管理员指定。负责人不自动获得全所权限或业务修改权限。
- 案件页范围为全部可见、我经办的、团队案件，团队筛选仅显示获权团队；既有状态筛选继续生效。明确团队范围不等于导出、财务或材料下载授权。
- 协办选择优先展示我的团队律师，再展示全所其他律师；支持姓名搜索和多选，保留已选人员。
- 原始立案人从直接创建、收案创建和历史创建审计保留。管理员代审批不成为立案人；历史无法核实的创建人留空，仍可按当前主办汇总。
- 本期不包含工作量分案、团队财务、团队知识库或自动交接。
- 验收：团队成员既有案件自动可见，跨团队隔离，撤权/停用即时生效，只读团队用户无法通过接口写入或取得原无权下载/财务/导出内容；分页、搜索、统计使用一致范围。


## 2026-09-06 账号与审批授权扩展

按已确认的《LawLink-账号与审批权限改造方案》实施。基础角色继续控制业务操作，审批权限组独立分配给账号。规则包含操作、案件类别范围（全部案件/指定类别/非案件）、用章事项与印章范围，组间 OR、规则内 AND，空范围拒绝授权。所有账号（包括 `SUPER_ADMIN`）均按权限组取得审批和盖章回填资格；同时遵守本人审批开关及法定代表人章身份限制，并校验账号、事项、印章有效性及申请状态并记录审计。

新增 ApprovalPermissionGroup、ApprovalPermissionMember、ApprovalPermissionRule、SealPurposeConfig；User.sessionVersion 用于撤销会话；SealRequest 增加结构化事项关联和名称快照。权限组/事项只停用，不删除历史记录。系统设置 approvalAuthorization 仅控制是否允许本人审批；事项授权始终生效，历史 enabled 值不再决定鉴权。权限变更和审批审计须同事务。

配置步骤：完成已批准的数据库迁移 → 在管理后台配置用章事项、权限组和账号。无需另行启用新规则，不提供旧角色授权对照；未分类用章申请在提交时直接阻止。系统管理身份与审批资格、团队查看权限彼此独立。

## 个人身份与基本资料维护（2026-09-06）

已确认方案见 [PERSONAL-PROFILE-PLAN.md](PERSONAL-PROFILE-PLAN.md) 与 [IDENTITY-DOCUMENT-PLAN.md](IDENTITY-DOCUMENT-PLAN.md)。本人可登记、修改姓名、手机号、登录邮箱；邮箱变更验证当前密码并退出旧会话。身份使用“证件类型 + 规范化证件号码”，覆盖居民身份证、港澳台居民居住证、往来港澳通行证、回乡证、台胞证、护照、外国人永久居留身份证及其他证件。联系方式与身份更正均不改变历史业务的用户归属。

管理员新增用户时必须上传至少一张 JPG、PNG 或 WebP 证件照片，单张不超过 10MB，并确认最终证件号码。自动识别是管理员主动触发的辅助操作；调用非本地视觉服务前必须显示服务域名并逐次确认，识别失败可手工录入。系统不保存 AI 原始响应，也不把识别结果称为实名认证。

证件照片独立加密存储，不复用案件材料权限；只有本人和 `SUPER_ADMIN` 可以按需查看。明文号码、证件图片、自动识别和管理员更正均记录不含证件明文的审计。管理员更正保留已被替代的旧照片，普通用户不能凭团队、审批或财务权限查看他人证件。

## 归档材料审阅与完整性（2026-09-06）

按 [ARCHIVE-REVIEW-PLAN.md](ARCHIVE-REVIEW-PLAN.md) 实施。归档申请从“申请人勾选清单”改为“清单项关联实际文件并固定内容校验值”；审批工作台逐项展示制度版本、材料、缺项/不适用理由及人工核验事项。申请人确认不等于审批核验，审批人完成全部必需核验并明确接受缺项例外后才可批准。

归档制度由管理员在系统设置中确认名称、版本、生效日期和制度原文；未配置制度时不得提交正式申请。送审后文件范围固定，待审材料不可删除；驳回重提形成新记录，历史材料不推断。归档导出精确使用获批记录的文件快照，读取失败、缺失或内容校验值变化即阻止正式导出。复用 `ArchiveRecord.checklistJson`、`SystemSetting` 和 `AuditLog`，不新增数据库字段或迁移。


## 自定义角色管理（2026-09-06 批准）

新增设置角色管理，支持自定义名称、功能及数据范围、停用和用户分配。行政为第六个内置角色，全部内置角色可改显示名称和介绍，权限固定、不可停用或删除；名称不决定授权。岗位角色与审批权限组独立。详细边界、目录及验收见 `docs/ROLE-MANAGEMENT-PLAN.md`。
