# 财务企微摘要通知实施计划

> **安全约束：** 新配置独立于通用提醒 webhook；默认关闭，URL 加密且从不回显。任何消息必须先预览，发送时二次确认；不自动推送、不自动重试、不包含客户/案件/个人薪资分配/银行账号/公开文件链接。

**设计依据：** `docs/superpowers/specs/2026-09-25-law-firm-finance-completion.md`

## 当前代码与最小改动边界

- `src/server/settings/webhook.ts` 将通用 `notifyWebhook` 明文保存在 `SystemSetting`；不能用于财务 webhook。
- 复用 `SystemSetting` 存储接口、`src/lib/storage/crypto.ts` 加密设施、`assertSafeHttpUrl`/`safeFetch`、现有审计记录和月结状态。
- 不在 worker/cron 里添加财务定时发送；不保存消息请求体或 webhook URL 到审计/日志。

## 任务 1：先写配置与消息内容安全测试

**文件：** 新建 `src/tests/server/finance-wecom.test.ts`。

1. 测试缺省配置为 disabled；保存后读出的管理 DTO 仅含 `hasWebhook`/目标群标签，不含 URL/密文。
2. 测试 URL 加密后数据库内容不可读出明文；缺少 `STORAGE_ENCRYPTION_KEY` 时拒绝启用，不降级明文。
3. 测试摘要严格不包含案件/客户/人员/工资/分配/银行账号/公网文件链接，仅含期间、月结状态、阻断项数量及系统内工作区路径。
4. 测试预览不会发送；未配置/未启用或未二次确认不能发送；未经授权角色不能读配置、预览或发送；发送失败/成功写审计且不会排队重试。
5. 运行 `npm run test:run -- src/tests/server/finance-wecom.test.ts` 并确认 RED。

## 任务 2：安全配置与权限 API

**文件：** 新建 `src/server/finance/finance-wecom.ts`、`src/app/api/finance/internal/wecom/settings/route.ts`、`src/app/api/finance/internal/wecom/preview/route.ts`、`src/app/api/finance/internal/wecom/send/route.ts`，复用 `src/lib/storage/crypto.ts`、`src/lib/net/safe-url.ts` 与 `src/server/audit.ts`。

1. 定义独立设置类型 `{ enabled, encryptedWebhook, groupLabel }`，持久化到 `SystemSetting` 独立 key；配置密钥走 `STORAGE_ENCRYPTION_KEY` 的现有 AES-GCM 设施。读取接口不回显 webhook URL；日志只给出错误类别。
2. 配置读取/写入只允许 FINANCE 或具备全局财务管理权限的自定义角色；Zod 限制 HTTPS 地址、群标签长度与字符、开关值。
3. 生成确定性消息 `buildFinanceCloseMessage(period, closeStatus)`；在服务端再次检查禁止字段与 URL，消息不含金额、姓名、文件名、客户/案件资料、账号或下载链接。
4. `POST /preview` 返回目标群标签、期间和完整消息预览，无外部副作用；每次读取/更改均做适量审计，不写密钥。
5. `POST /send` 只接收期间及 `confirmed: true`，服务端重新计算预览内容并以 `assertSafeHttpUrl` + `safeFetch` 做 HTTPS/SSRF/不跟随重定向校验；发送失败原样本仅在用户界面显示通用错误，不进队列、不自动重试。审计仅记录期间、目标群标签、结果码和调用者。
6. 跑 RED 测试至 GREEN，并增加对 URL 日志、消息敏感字段和未授权的专项断言。

## 任务 3：财务设置与逐次预览/确认界面

**文件：** 新建 `src/app/(app)/finance/internal/notifications/page.tsx`、`src/app/(app)/finance/internal/_components/finance-wecom-settings.tsx`、`src/app/(app)/finance/internal/_components/finance-wecom-preview.tsx`、`src/app/(app)/finance/internal/_components/internal-finance-nav.tsx`、新建 `src/tests/app/finance-wecom.test.tsx`。

1. 仅对有管理权限者渲染设置表单。保存后仅显示“已配置”状态；Webhook 输入始终空白，不能由 GET 回填。
2. 创建消息时要求指定期间；展示目标群名称、完整消息与“发送到目标群”确认复选/按钮。确认态默认未勾选。
3. 发送请求不接受浏览器提交的任意正文/目标 URL；服务端按期间和当前配置重新生成。配置或期间改变后清除已确认状态。
4. 发送成功/失败回执不得显示敏感 URL/响应体；失败可手动再预览与确认，但不自动重发。
5. 跑 `npm run test:run -- src/tests/server/finance-wecom.test.ts src/tests/app/finance-wecom.test.tsx`、`npm run typecheck`、`npm run lint`。

## 任务 4：部署安全验证

1. 170 预览环境默认不开启且不配置 webhook；部署后读取设置 API 应为关闭/未配置。
2. 确认日志、Docker inspect 和审计中无 webhook 明文；确认预览路由不出站，发送路由缺确认返回 400，未授权用户返回 403。
3. 只有在用户之后主动配置了目标群和 webhook，且逐次检查预览后，才允许真实群发送；本次任务不自行配置或发送到真实群。

## 最终验收

`npm run test:run -- src/tests/server/finance-wecom.test.ts src/tests/app/finance-wecom.test.tsx`、`npm run typecheck`、`npm run lint`；部署健康检查确认该模块关闭且密钥未配置/未泄漏。
