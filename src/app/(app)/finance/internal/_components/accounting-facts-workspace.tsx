"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { BadgeCheck, FilePlus2, Landmark, WalletCards } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/patterns/moan";

type PersonOption = { id: string; name: string };
type FormKind = "opening" | "payroll" | "cost" | "ledger";

const moneyFields = [
  ["grossSalary", "申报工资"], ["commission", "申报分成"], ["socialPersonal", "个人社保"],
  ["socialCompany", "单位社保参考"], ["fundPersonal", "个人公积金"], ["fundCompany", "单位公积金参考"],
  ["incomeTax", "个人所得税"], ["otherDeduction", "其他扣款"], ["reimbursement", "报销"],
  ["selfCostDue", "个人自担成本"], ["firmSalaryCost", "律所承担工资成本"],
  ["firmSocialCost", "律所承担社保成本"], ["firmFundCost", "律所承担公积金成本"]
] as const;

export function AccountingFactsWorkspace({ period, people, canManage }: { period: string; people: PersonOption[]; canManage: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<FormKind | null>(null);
  const [message, setMessage] = useState<{ kind: FormKind; text: string; error: boolean } | null>(null);
  const [deemedWage, setDeemedWage] = useState(false);
  const [actualCashPaid, setActualCashPaid] = useState("0.00");

  async function save(kind: FormKind, endpoint: string, body: Record<string, unknown>) {
    setBusy(kind);
    setMessage(null);
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        setMessage({ kind, text: payload.error ?? "保存失败，请检查信息后重试。", error: true });
        return false;
      }
      setMessage({ kind, text: "已保存；历史计算批次不会被改写。", error: false });
      router.refresh();
      return true;
    } catch {
      setMessage({ kind, text: "暂时无法连接，请检查网络后重试。", error: true });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function submitOpening(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await save("opening", "/api/finance/internal/opening-balances", {
      userId: form.get("userId"), firstPeriod: period, distributable: form.get("distributable"),
      reserve: form.get("reserve"), evidenceRef: form.get("evidenceRef")
    });
  }

  async function submitPayroll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body: Record<string, unknown> = {
      userId: form.get("userId"), period,
      isDeemedWage: deemedWage,
      actualCashPaid: deemedWage ? "0.00" : actualCashPaid,
      treatmentReviewed: form.get("treatmentReviewed") === "on",
      actualPaymentPeriod: form.get("actualPaymentPeriod") || null,
      treatmentNote: form.get("treatmentNote") || null
    };
    for (const [name] of moneyFields) body[name] = form.get(name) || "0.00";
    await save("payroll", "/api/finance/internal/payroll", body);
  }

  async function submitCost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await save("cost", "/api/finance/internal/operating-costs", {
      period, category: form.get("category"), amount: form.get("amount"),
      evidenceRef: form.get("evidenceRef"), description: form.get("description")
    });
  }

  async function submitPersonalLedger(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await save("ledger", "/api/finance/internal/ledger-entries", {
      targetUserId: form.get("userId"), period, kind: form.get("kind"), amount: form.get("amount"),
      sourceRef: form.get("sourceRef"), note: form.get("note")
    });
  }

  const personSelect = (id: string) => (
    <label className="block space-y-1.5 text-[12px] font-[550] text-[var(--t-secondary)]">
      <span>人员 <span className="text-[var(--danger)]">*</span></span>
      <select id={id} name="userId" required defaultValue="" className="ll-form-control h-11 w-full rounded-[8px] border border-input bg-card px-3 text-[14px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--teal)]">
        <option value="" disabled>选择人员</option>
        {people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
      </select>
    </label>
  );

  const feedback = (kind: FormKind) => message?.kind === kind ? (
    <p className={message.error ? "text-[12px] text-[var(--danger)]" : "text-[12px] text-[var(--teal)]"} role={message.error ? "alert" : "status"} aria-live="polite">{message.text}</p>
  ) : null;

  return (
    <Panel title="期初、工资与成本确认" icon={FilePlus2}>
      {!canManage ? <p className="text-[13px] leading-6 text-[var(--t-muted)]">当前账号只有查看权限；维护这些内部财务事实需要财务调整权限。</p> : people.length === 0 ? <p className="text-[13px] leading-6 text-[var(--t-muted)]">当前没有可选的在职人员，请先确认人员状态。</p> : (
        <div className="grid gap-3 xl:grid-cols-2">
          <form className="space-y-3 rounded-[10px] border border-[var(--bd-subtle)] bg-[var(--bg-sunken)] p-3.5" onSubmit={(event) => void submitOpening(event)}>
            <div className="flex items-start gap-2"><WalletCards className="mt-0.5 h-4 w-4 text-[var(--teal)]" aria-hidden="true" /><div><h3 className="text-[13px] font-[650]">个人期初余额</h3><p className="mt-1 text-[11.5px] leading-5 text-[var(--t-muted)]">仅首次账期填写；后续月份自动接续上期正式余额。已确认期初不可覆盖。</p></div></div>
            {personSelect("opening-user")}
            <Field label="期初可分配余额" name="distributable" required defaultValue="0.00" />
            <Field label="期初预存余额" name="reserve" required defaultValue="0.00" min="0" />
            <Field label="凭据引用" name="evidenceRef" required placeholder="如：内部盘点单编号" />
            {feedback("opening")}
            <Button type="submit" disabled={busy !== null} className="min-h-11 w-full">{busy === "opening" ? "保存中…" : "确认期初余额"}</Button>
          </form>

          <form className="space-y-3 rounded-[10px] border border-[var(--bd-subtle)] bg-[var(--bg-sunken)] p-3.5" onSubmit={(event) => void submitPayroll(event)}>
            <div className="flex items-start gap-2"><BadgeCheck className="mt-0.5 h-4 w-4 text-[var(--teal)]" aria-hidden="true" /><div><h3 className="text-[13px] font-[650]">本期工资与承担口径</h3><p className="mt-1 text-[11.5px] leading-5 text-[var(--t-muted)]">申报额、实付额和最终由谁承担分别记录；核对完成后勾选确认。</p></div></div>
            {personSelect("payroll-user")}
            <div className="grid gap-2 sm:grid-cols-2">{moneyFields.map(([name, label]) => <Field key={name} label={label} name={name} defaultValue="0.00" min="0" />)}</div>
            <label className="flex min-h-11 items-center gap-2 text-[12px] text-[var(--t-secondary)]"><input type="checkbox" checked={deemedWage} onChange={(event) => { setDeemedWage(event.target.checked); if (event.target.checked) setActualCashPaid("0.00"); }} />视同工资（实际支付额固定为 0）</label>
            <Field label="实际支付现金" name="actualCashPaid" value={deemedWage ? "0.00" : actualCashPaid} onChange={setActualCashPaid} min="0" />
            <Field label="实际支付期间" name="actualPaymentPeriod" type="month" />
            <label className="flex min-h-11 items-center gap-2 text-[12px] text-[var(--t-secondary)]"><input type="checkbox" name="treatmentReviewed" />我已核对本期工资及承担口径</label>
            <label className="block space-y-1.5 text-[12px] font-[550] text-[var(--t-secondary)]"><span>核对说明</span><textarea name="treatmentNote" maxLength={1000} rows={2} className="ll-form-control w-full rounded-[8px] border border-input bg-card px-3 py-2 text-[14px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--teal)]" /></label>
            {feedback("payroll")}
            <Button type="submit" disabled={busy !== null} className="min-h-11 w-full">{busy === "payroll" ? "保存中…" : "保存工资确认"}</Button>
          </form>

          <form className="space-y-3 rounded-[10px] border border-[var(--bd-subtle)] bg-[var(--bg-sunken)] p-3.5" onSubmit={(event) => void submitCost(event)}>
            <div className="flex items-start gap-2"><Landmark className="mt-0.5 h-4 w-4 text-[var(--teal)]" aria-hidden="true" /><div><h3 className="text-[13px] font-[650]">律所经营成本</h3><p className="mt-1 text-[11.5px] leading-5 text-[var(--t-muted)]">个人自担成本不要录在这里；没有银行流水关联时须保留凭据引用。</p></div></div>
            <label className="block space-y-1.5 text-[12px] font-[550] text-[var(--t-secondary)]"><span>成本类别 <span className="text-[var(--danger)]">*</span></span><select name="category" required defaultValue="RENT" className="ll-form-control h-11 w-full rounded-[8px] border border-input bg-card px-3 text-[14px]"><option value="RENT">房租</option><option value="OFFICE">办公</option><option value="TURNOVER_TAX">流转税费</option><option value="OTHER">其他经营成本</option></select></label>
            <Field label="金额（元）" name="amount" required min="0.01" />
            <Field label="凭据引用" name="evidenceRef" required placeholder="凭证或单据编号" />
            <label className="block space-y-1.5 text-[12px] font-[550] text-[var(--t-secondary)]"><span>用途说明 <span className="text-[var(--danger)]">*</span></span><textarea name="description" required maxLength={1000} rows={3} className="ll-form-control w-full rounded-[8px] border border-input bg-card px-3 py-2 text-[14px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--teal)]" /></label>
            {feedback("cost")}
            <Button type="submit" disabled={busy !== null} className="min-h-11 w-full">{busy === "cost" ? "保存中…" : "保存经营成本"}</Button>
          </form>

          <form className="space-y-3 rounded-[10px] border border-[var(--bd-subtle)] bg-[var(--bg-sunken)] p-3.5" onSubmit={(event) => void submitPersonalLedger(event)}>
            <div className="flex items-start gap-2"><WalletCards className="mt-0.5 h-4 w-4 text-[var(--teal)]" aria-hidden="true" /><div><h3 className="text-[13px] font-[650]">个人预存与提款</h3><p className="mt-1 text-[11.5px] leading-5 text-[var(--t-muted)]">每笔都要使用唯一的流水或凭据引用；律师所得由分配快照自动带入，无需重复登记。</p></div></div>
            {personSelect("ledger-user")}
            <label className="block space-y-1.5 text-[12px] font-[550] text-[var(--t-secondary)]"><span>事件类型 <span className="text-[var(--danger)]">*</span></span><select name="kind" required defaultValue="SELF_FUNDING_IN" className="ll-form-control h-11 w-full rounded-[8px] border border-input bg-card px-3 text-[14px]"><option value="SELF_FUNDING_IN">个人预存</option><option value="INCOME_WITHDRAWAL">从可分配余额提款</option></select></label>
            <Field label="金额（元）" name="amount" required min="0.01" />
            <Field label="流水或凭据引用" name="sourceRef" required placeholder="使用可回查的唯一编号" type="text" />
            <label className="block space-y-1.5 text-[12px] font-[550] text-[var(--t-secondary)]"><span>说明</span><textarea name="note" maxLength={1000} rows={2} className="ll-form-control w-full rounded-[8px] border border-input bg-card px-3 py-2 text-[14px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--teal)]" /></label>
            {feedback("ledger")}
            <Button type="submit" disabled={busy !== null} className="min-h-11 w-full">{busy === "ledger" ? "保存中…" : "保存个人内账事件"}</Button>
          </form>
        </div>
      )}
    </Panel>
  );
}

function Field({ label, name, required = false, defaultValue, value, onChange, min, type = "number", placeholder }: {
  label: string; name: string; required?: boolean; defaultValue?: string; value?: string; onChange?: (value: string) => void; min?: string; type?: string; placeholder?: string;
}) {
  return (
    <label className="block space-y-1.5 text-[12px] font-[550] text-[var(--t-secondary)]">
      <span>{label}{required ? <span className="ml-1 text-[var(--danger)]">*</span> : null}</span>
      <input name={name} type={type} inputMode={type === "number" ? "decimal" : undefined} step={type === "number" ? "0.01" : undefined} min={min} required={required} defaultValue={defaultValue} value={value} onChange={onChange ? (event) => onChange(event.target.value) : undefined} placeholder={placeholder} className="ll-form-control h-11 w-full rounded-[8px] border border-input bg-card px-3 text-[14px] font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--teal)]" />
    </label>
  );
}
