/** 固定功能目录；普通角色不能获得账号、角色、授权和系统密钥管理权。 */
export const PERMISSIONS = [
  { key: "finance.tail", label: "归档后财务收尾", group: "财务", scopes: ["ALL"] },
  { key: "archive.supplement", label: "追加归档材料及补充归档", group: "归档与导出", scopes: ["OWN"] },
  { key: "matters.transfer", label: "应急接管与责任交接", group: "案件", scopes: ["ALL"] },
  { key: "matters.read", label: "查看案件与收案", group: "案件", scopes: ["OWN", "TEAM", "ALL"] },
  { key: "intakes.create", label: "收案登记", group: "案件", scopes: ["OWN"] },
  { key: "matters.write", label: "办理案件与收案", group: "案件", scopes: ["OWN"] },
  { key: "clients.read", label: "查看客户", group: "客户", scopes: ["OWN", "ALL"] },
  { key: "clients.write", label: "维护客户", group: "客户", scopes: ["OWN", "ALL"] },
  { key: "documents.read", label: "查看材料目录", group: "材料", scopes: ["OWN"] },
  { key: "documents.write", label: "上传及维护材料", group: "材料", scopes: ["OWN"] },
  { key: "documents.download", label: "下载及预览材料", group: "材料", scopes: ["OWN"] },
  { key: "schedule.read", label: "查看案件日程", group: "日程", scopes: ["OWN", "TEAM"] },
  { key: "schedule.write", label: "维护案件日程与记录", group: "日程", scopes: ["OWN"] },
  { key: "finance.read", label: "查看财务", group: "财务", scopes: ["OWN", "ALL"] },
  { key: "finance.write", label: "维护收付款", group: "财务", scopes: ["OWN", "ALL"] },
  { key: "finance.correct", label: "确认财务更正", group: "财务", scopes: ["ALL"] },
  { key: "finance.settle", label: "登记分成支付及扣回", group: "财务", scopes: ["ALL"] },
  { key: "finance.confirm", label: "确认实收到账", group: "财务", scopes: ["ALL"] },
  { key: "finance.import", label: "导入财务资料", group: "财务", scopes: ["ALL"] },
  { key: "finance.reconcile", label: "确认财务勾稽与差异", group: "财务", scopes: ["ALL"] },
  { key: "finance.rules", label: "维护内部核算规则", group: "财务", scopes: ["ALL"] },
  { key: "finance.adjust", label: "登记财务调整", group: "财务", scopes: ["ALL"] },
  { key: "finance.export", label: "导出经营财务资料", group: "财务", scopes: ["ALL"] },
  { key: "invoices.process", label: "执行开票", group: "财务", scopes: ["OWN", "ALL"] },
  { key: "archive.read", label: "查看归档", group: "归档与导出", scopes: ["OWN", "TEAM", "ALL"] },
  { key: "archive.submit", label: "提交归档", group: "归档与导出", scopes: ["OWN"] },
  { key: "matters.export", label: "导出案件及归档材料", group: "归档与导出", scopes: ["OWN"] },
  { key: "reports.read", label: "查看报表", group: "归档与导出", scopes: ["OWN", "ALL"] },
  { key: "reports.export", label: "导出报表", group: "归档与导出", scopes: ["OWN", "ALL"] },
  { key: "announcements.manage", label: "管理公告", group: "行政事务", scopes: ["ALL"] },
  { key: "firm-files.manage", label: "管理律所公共资料", group: "行政事务", scopes: ["ALL"] },
  { key: "express.manage", label: "登记及维护快递", group: "行政事务", scopes: ["OWN", "ALL"] },
  { key: "contacts.manage", label: "录入及维护外部联系人", group: "行政事务", scopes: ["OWN", "ALL"] },
  { key: "contacts.review", label: "审核外部联系人", group: "行政事务", scopes: ["ALL"] },
  { key: "seals.request", label: "发起用章申请", group: "行政事务", scopes: ["OWN"] },
] as const;
export type PermissionKey = typeof PERMISSIONS[number]["key"];
export type RoleScope = "OWN" | "TEAM" | "ALL";
export type RoleGrant = { permissionKey: PermissionKey; scope: RoleScope };
export type RoleUser = { role: string; rolePermissions?: RoleGrant[]; roleName?: string; managerAuthorized?: boolean };
export const SCOPE_LABELS: Record<RoleScope, string> = { OWN: "本人经办 / 本人记录", TEAM: "本人及已有团队查看授权", ALL: "全所" };
export const ADMINISTRATIVE_ROLE_ID = "cmrolesadministrative00001";
export const BUILTIN_ROLES = [
  { id: "PRINCIPAL_LAWYER", name: "合伙人", description: "全所查看与管理；审批另按事项授权。" },
  { id: "INDEPENDENT_LAWYER", name: "独立律师", description: "本人经办案件及已有团队查看授权；权限与授薪律师一致，审批另按事项授权。" },
  { id: "LAWYER", name: "授薪律师", description: "本人经办案件及已有团队查看授权；审批另按事项授权。" },
  { id: "ASSISTANT", name: "律师助理", description: "参与案件及已有团队查看授权；审批另按事项授权。" },
  { id: "FINANCE", name: "财务", description: "全所财务，含实收到账确认；案件正文及材料仍按个人经办关系授权。" },
  { id: ADMINISTRATIVE_ROLE_ID, name: "行政", description: "公告、律所公共资料、快递及外部联系人维护；审批另按事项授权。" },
] as const;
export type BuiltinRolePresentation = { id: string; name: string; description: string; version: number };
export const isBuiltinRole = (id: string) => BUILTIN_ROLES.some(role => role.id === id);
export const ADMINISTRATIVE_GRANTS: RoleGrant[] = [
  { permissionKey: "announcements.manage", scope: "ALL" }, { permissionKey: "firm-files.manage", scope: "ALL" },
  { permissionKey: "express.manage", scope: "OWN" }, { permissionKey: "contacts.manage", scope: "OWN" },
  { permissionKey: "seals.request", scope: "OWN" },
];
/**
 * 业务管理权（2026-09-19 与岗位解耦）：按人授予（User.managerAuthorized），
 * 授权者在可见性过滤层等同合伙人——全所案件/收案/客户/财务/归档只读范围。
 * 写入、审批、导出等仍走各自独立授权，不因管理权自动放大。
 */
export const MANAGER_GRANTS: RoleGrant[] = [
  { permissionKey: "matters.read", scope: "ALL" },
  { permissionKey: "clients.read", scope: "ALL" },
  { permissionKey: "finance.read", scope: "ALL" },
  { permissionKey: "archive.read", scope: "ALL" }
];
export function validGrants(rows: { permissionKey: string; scope: string }[]): RoleGrant[] {
  return rows.filter(row => PERMISSIONS.some(p => p.key === row.permissionKey && (p.scopes as readonly string[]).includes(row.scope))) as RoleGrant[];
}
/**
 * 读取授权范围。
 *
 * ⚠️ 2026-09-19 起 rolePermissions 不再等价于「自定义角色」：内置岗位若被授予业务管理权
 * （User.managerAuthorized），会话里会合成 MANAGER_GRANTS。因此：
 * - 想判断「这个人在这件事上的有效范围」→ 直接用本函数；
 * - 想判断「这是不是自定义角色的配置」→ 必须先判 user.role === "CUSTOM"，不能只看 rolePermissions 有没有值。
 * 新增调用点时请明确属于哪一种，否则内置授权用户会静默拿到 ALL。
 */
export function scopeFor(user: RoleUser, key: PermissionKey): RoleScope | undefined {
  return user.rolePermissions?.find(p => p.permissionKey === key && PERMISSIONS.some(def => def.key === key && (def.scopes as readonly string[]).includes(p.scope)))?.scope;
}
/** 内置角色仍由既有业务规则进一步限制；此函数的放行不能替代旧业务断言。 */
export function hasCustomPermission(user: RoleUser, key: PermissionKey): boolean {
  return user.role !== "CUSTOM" || Boolean(scopeFor(user, key));
}
export function customOrLegacy(user: RoleUser, key: PermissionKey, legacy: boolean): boolean {
  return user.role === "CUSTOM" ? Boolean(scopeFor(user, key)) : legacy;
}
export function roleDisplayName(user: RoleUser): string {
  return user.roleName || (user.role === "CUSTOM" ? "自定义角色" : BUILTIN_ROLES.find(r => r.id === user.role)?.name || "未知角色");
}
/**
 * M-2b（2026-09-20 C 批）：独立执业组合模板——可审阅、由管理员显式授予。
 * 覆盖单人全链：律师业务全项＋财务登记/确认（两步留痕仍保留）＋开票执行＋归档提交与收尾。
 * 不含 finance.correct/settle（更正与分成结算是独立 ALL 权限，按需另配）。
 */
export const SOLE_PRACTICE_GRANTS: RoleGrant[] = [
  { permissionKey: "matters.read", scope: "ALL" },
  { permissionKey: "intakes.create", scope: "OWN" },
  { permissionKey: "matters.write", scope: "OWN" },
  { permissionKey: "clients.read", scope: "OWN" },
  { permissionKey: "clients.write", scope: "OWN" },
  { permissionKey: "documents.read", scope: "OWN" },
  { permissionKey: "documents.write", scope: "OWN" },
  { permissionKey: "documents.download", scope: "OWN" },
  { permissionKey: "schedule.read", scope: "OWN" },
  { permissionKey: "schedule.write", scope: "OWN" },
  { permissionKey: "archive.read", scope: "OWN" },
  { permissionKey: "archive.submit", scope: "OWN" },
  { permissionKey: "seals.request", scope: "OWN" },
  { permissionKey: "finance.read", scope: "ALL" },
  { permissionKey: "finance.write", scope: "ALL" },
  { permissionKey: "finance.confirm", scope: "ALL" },
  { permissionKey: "finance.tail", scope: "ALL" },
  { permissionKey: "invoices.process", scope: "OWN" }
];

/** 复制提供明确列出的普通业务权限，不复制任何隐式系统管理权。 */
export function copyBuiltinGrants(role: string): RoleGrant[] {
  if (role === ADMINISTRATIVE_ROLE_ID) return ADMINISTRATIVE_GRANTS.map(grant => ({ ...grant }));
  const keys: PermissionKey[] = role === "FINANCE"
    ? ["finance.read", "finance.write", "finance.confirm", "finance.correct", "finance.settle", "finance.import", "finance.reconcile", "finance.rules", "finance.adjust", "finance.export", "invoices.process"]
    : ["matters.read", "intakes.create", "matters.write", "clients.read", "clients.write", "documents.read", "documents.write", "documents.download", "schedule.read", "schedule.write", "archive.read", "archive.submit", "seals.request"];
  return keys.map(permissionKey => ({ permissionKey, scope: (role === "FINANCE" ? "ALL" : permissionKey === "matters.read" && role === "PRINCIPAL_LAWYER" ? "ALL" : "OWN") as RoleScope }));
}

export const normalizeRoleName = (name: string) => name.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");

/** 独立财务执行资格；系统身份及管理权不参与授权。 */
export function canExecuteFinance(user: RoleUser, key: "finance.correct" | "finance.settle") {
  return user.role === "FINANCE" || (user.role === "CUSTOM" && scopeFor(user, key) === "ALL");
}

/** 经营财务写入资格；系统管理员身份和业务管理权不能替代显式授权。 */
export function canManageInternalFinance(user: RoleUser, key: "finance.rules" | "finance.adjust") {
  return user.role === "FINANCE" || (user.role === "CUSTOM" && scopeFor(user, key) === "ALL");
}
