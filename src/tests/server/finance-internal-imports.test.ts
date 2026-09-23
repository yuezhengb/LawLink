import { describe, expect, it, vi } from "vitest";
import { makeSyntheticFinanceFixture } from "@/tests/fixtures/finance-synthetic";
import type { FinanceNormalizedRow } from "@/lib/finance/internal-types";
import {
  canReadFinanceImport,
  commitFinanceImport,
  downloadFinanceImportSource,
  previewFinanceImport,
  type FinanceImportDependencies
} from "@/server/finance/internal-imports";

function formDataFor(fileName: string): FormData {
  const fixture = makeSyntheticFinanceFixture();
  const csv = [
    ["日期", "对方户名", "贷方发生额", "账号", "摘要"],
    [fixture.bankRow.occurredAt, fixture.bankRow.counterparty, fixture.bankRow.amount, "6222000000000001", fixture.bankRow.description]
  ]
    .map((row) => row.join(","))
    .join("\r\n");
  const formData = new FormData();
  formData.set("kind", "BANK_STATEMENT");
  formData.set("file", new File([csv], fileName, { type: "text/csv" }));
  return formData;
}

async function bytesFor(fileName: string): Promise<Buffer> {
  const file = formDataFor(fileName).get("file") as File;
  return Buffer.from(await file.arrayBuffer());
}

function transactionDb() {
  const tx = {
    financeImportBatch: {
      create: vi.fn().mockResolvedValue({ id: "batch-new" })
    },
    financeSourceFile: {
      create: vi.fn().mockResolvedValue({ id: "source-file-new" })
    },
    financeSourceRow: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([{ id: "source-row-new" }])
    },
    financeReconciliationCase: {
      createMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    financeImportRecord: {
      createMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit-new" })
    }
  };
  const db = {
    financeImportBatch: {
      findUnique: vi.fn()
    },
    $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx))
  };
  return { db, tx };
}

function storageMock() {
  return {
    writeFile: vi.fn().mockResolvedValue("finance-imports/202609/source.bin"),
    readFile: vi.fn().mockResolvedValue(Buffer.from("source-bytes")),
    deleteFile: vi.fn().mockResolvedValue(undefined)
  };
}

function depsFor(
  db: ReturnType<typeof transactionDb>["db"],
  storage: ReturnType<typeof storageMock>
): FinanceImportDependencies {
  return {
    db: db as never,
    storage,
    actorId: "synthetic-user-2",
    auditStrict: vi.fn().mockResolvedValue(undefined)
  };
}

describe("内部财务资料导入", () => {
  it("预览不写数据库和私有存储", async () => {
    const { db } = transactionDb();
    const storage = storageMock();
    const result = await previewFinanceImport(formDataFor("synthetic.csv"), depsFor(db, storage));

    expect(result.validCount).toBe(1);
    expect((result.rows[0] as FinanceNormalizedRow).accountMasked).toBe("****0001");
    expect(db.financeImportBatch.findUnique).not.toHaveBeenCalled();
    expect(storage.writeFile).not.toHaveBeenCalled();
  });

  it("同一 sha256 的已提交批次幂等返回原批次", async () => {
    const { db } = transactionDb();
    db.financeImportBatch.findUnique.mockResolvedValue({ id: "batch-old", status: "COMMITTED" });
    const storage = storageMock();

    await expect(
      commitFinanceImport(
        {
          fileName: "same.csv",
          kind: "BANK_STATEMENT",
          bytes: await bytesFor("same.csv")
        },
        depsFor(db, storage)
      )
    ).resolves.toEqual({ batchId: "batch-old", duplicate: true });
    expect(storage.writeFile).not.toHaveBeenCalled();
  });

  it("数据库事务失败时删除已写入的原文件", async () => {
    const { db } = transactionDb();
    db.financeImportBatch.findUnique.mockResolvedValue(null);
    db.$transaction.mockRejectedValue(new Error("db failed"));
    const storage = storageMock();

    await expect(
      commitFinanceImport(
        {
          fileName: "synthetic.csv",
          kind: "BANK_STATEMENT",
          bytes: await bytesFor("synthetic.csv")
        },
        depsFor(db, storage)
      )
    ).rejects.toThrow("db failed");
    expect(storage.writeFile).toHaveBeenCalledOnce();
    expect(storage.deleteFile).toHaveBeenCalledWith("finance-imports/202609/source.bin");
  });

  it("工资表只归档类型化记录，不制造银行流水或待认领案件", async () => {
    const { db, tx } = transactionDb();
    db.financeImportBatch.findUnique.mockResolvedValue(null);
    const storage = storageMock();
    const bytes = Buffer.from(
      "月份,姓名,申报工资,实际支付,自担社保\n2026-08,合成人员甲,15000.00,12000.00,800.00",
      "utf8"
    );

    await expect(
      commitFinanceImport({ fileName: "synthetic-payroll.csv", kind: "PAYROLL", bytes }, depsFor(db, storage))
    ).resolves.toEqual({ batchId: "batch-new", duplicate: false });

    expect(tx.financeImportRecord.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        batchId: "batch-new",
        sourceRow: 2,
        kind: "PAYROLL",
        period: "2026-08",
        declaredSalary: "15000.00",
        actualCashPaid: "12000.00",
        selfCostDue: "800.00"
      })]
    });
    const storedRecord = tx.financeImportRecord.createMany.mock.calls[0][0].data[0];
    expect(storedRecord).not.toHaveProperty("displayName");
    expect(storedRecord).not.toHaveProperty("displayNameDigest");
    expect(tx.financeSourceRow.createMany).not.toHaveBeenCalled();
    expect(tx.financeReconciliationCase.createMany).not.toHaveBeenCalled();
  });

  it("没有财务权限的自定义角色不能读取其他人的来源文件", () => {
    expect(
      canReadFinanceImport(
        { id: "user-other", role: "CUSTOM", rolePermissions: [] },
        { createdById: "synthetic-user-2" }
      )
    ).toBe(false);
    expect(
      canReadFinanceImport(
        {
          id: "user-self",
          role: "CUSTOM",
          rolePermissions: [{ permissionKey: "finance.read", scope: "OWN" }]
        },
        { createdById: "user-self" }
      )
    ).toBe(true);
  });

  it("读取来源文件时返回字节并写严格审计", async () => {
    const { db } = transactionDb();
    db.financeImportBatch.findUnique.mockResolvedValue({
      id: "batch-old",
      createdById: "synthetic-user-2",
      status: "COMMITTED",
      sourceFile: {
        fileName: "synthetic.csv",
        storagePath: "finance-imports/202609/source.bin",
        mimeType: "text/csv",
        byteSize: 12
      }
    });
    const storage = storageMock();
    const deps = depsFor(db, storage);
    const result = await downloadFinanceImportSource(
      "batch-old",
      { id: "synthetic-user-2", role: "FINANCE" },
      deps
    );

    expect(result).toMatchObject({ fileName: "synthetic.csv", mimeType: "text/csv" });
    expect(result.bytes.toString()).toBe("source-bytes");
    expect(deps.auditStrict).toHaveBeenCalledWith(
      expect.objectContaining({ action: "FINANCE_INTERNAL_IMPORT_SOURCE_DOWNLOAD", targetId: "batch-old" })
    );
  });
});
