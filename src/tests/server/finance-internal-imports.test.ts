import ExcelJS from "exceljs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeSyntheticFinanceFixture } from "@/tests/fixtures/finance-synthetic";
import type { FinanceNormalizedRow } from "@/lib/finance/internal-types";
import { financeTypedRecordFingerprint, rowFingerprint } from "@/lib/finance/source-fingerprint";
import type { FinancePreprocessedUpload } from "@/server/finance/finance-preprocessor-client";
import {
  canReadFinanceImport,
  commitFinanceImport,
  downloadFinanceImportSource,
  previewFinanceImportSource,
  previewFinanceImport,
  type FinanceImportDependencies
} from "@/server/finance/internal-imports";

afterEach(() => vi.unstubAllEnvs());

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

async function twoSheetBankBytes(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const [name, day, amount] of [["银行A", "2026-08-01", "100"], ["银行B", "2026-08-02", "200"]]) {
    const sheet = workbook.addWorksheet(name);
    sheet.addRow(["日期", "对方户名", "贷方发生额"]);
    sheet.addRow([day, "合成客户", amount]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function twoSheetOtherArchiveBytes(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("登记A").addRows([["编号", "说明"], ["A-1", "synthetic one"], ["A-2", "synthetic two"]]);
  workbook.addWorksheet("登记B").addRows([["编号", "说明"], ["B-1", "synthetic three"]]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
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
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([])
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit-new" })
    }
  };
  const db = {
    financeImportBatch: {
      findUnique: vi.fn()
    },
    financeSourceRow: {
      findMany: vi.fn().mockResolvedValue([])
    },
    financeImportRecord: {
      findMany: vi.fn().mockResolvedValue([])
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

  it("工资预览对姓名真实脱敏", async () => {
    const form = new FormData();
    form.set("kind", "PAYROLL");
    form.set("file", new File([
      "月份,姓名,申报工资,实际支付,自担社保\n2026-08,合成人员甲,15000.00,12000.00,800.00"
    ], "synthetic-payroll.csv", { type: "text/csv" }));
    const { db } = transactionDb();

    const preview = await previewFinanceImport(form, depsFor(db, storageMock()));

    expect(preview.rows).toMatchObject([{ displayName: "合****" }]);
    expect(JSON.stringify(preview)).not.toContain("合成人员甲");
  });

  it("花名册重复预检使用截至日期推导出的账期", async () => {
    vi.stubEnv("STORAGE_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    const { db } = transactionDb();
    db.financeImportBatch.findUnique.mockResolvedValue(null);
    const storage = storageMock();
    const bytes = Buffer.from("姓名,岗位\n合成人员甲,律师", "utf8");

    await commitFinanceImport({
      fileName: "synthetic-roster.csv",
      kind: "ROSTER",
      bytes,
      asOfDay: "2026-08-31"
    }, depsFor(db, storage));

    expect(db.financeImportRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ kind: "ROSTER", period: { in: ["2026-08"] } })
    }));
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

  it("PDF 预览保留页码表格来源，并把无法结构化的页标为不可提交候选", async () => {
    const { db } = transactionDb();
    const storage = storageMock();
    const document = {
      version: 1 as const,
      pages: [
        { pageNumber: 1, extraction: "TEXT_TABLE" as const, tables: [[ ["日期", "贷方发生额"], ["2026-08-01", "100.00"] ]], ocrWords: [] },
        { pageNumber: 2, extraction: "OCR_CANDIDATE" as const, tables: [], ocrWords: [{ text: "合成候选", confidence: 70, bbox: [1, 2, 3, 4] as [number, number, number, number] }] }
      ]
    };
    const preprocess = vi.fn().mockResolvedValue({ kind: "PDF", document } satisfies FinancePreprocessedUpload);
    const form = new FormData();
    form.set("kind", "BANK_STATEMENT");
    form.set("file", new File(["synthetic-pdf"], "synthetic.pdf", { type: "application/pdf" }));

    const result = await previewFinanceImport(form, { ...depsFor(db, storage), preprocess });

    expect(result.rows).toMatchObject([{ sourceSheet: "PDF第1页-表1", sourceRowNumber: 2, amount: "100.00" }]);
    expect(result.pdfCandidates).toEqual([{ pageNumber: 2, extraction: "OCR_CANDIDATE", wordCount: 1 }]);
    expect(result.canCommitStructuredRows).toBe(false);
    expect(JSON.stringify(result)).not.toContain("合成候选");
    expect(storage.writeFile).not.toHaveBeenCalled();
  });

  it("其他来源可在账期未知时只归档原件并统计所有工作表行", async () => {
    const { db, tx } = transactionDb();
    db.financeImportBatch.findUnique.mockResolvedValue(null);
    const storage = storageMock();

    await expect(commitFinanceImport({
      fileName: "case-register-snapshot.xlsm",
      kind: "OTHER",
      bytes: await twoSheetOtherArchiveBytes()
    }, depsFor(db, storage))).resolves.toMatchObject({ duplicate: false, batchId: "batch-new" });

    expect(tx.financeImportBatch.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ rowCount: 3, periodStart: null, periodEnd: null, kind: "OTHER" })
    }));
    expect(tx.financeSourceRow.createMany).not.toHaveBeenCalled();
    expect(tx.financeImportRecord.createMany).not.toHaveBeenCalled();
    expect(storage.writeFile).toHaveBeenCalledTimes(1);
  });

  it("有财务读取权限的人可分页查看只读来源表格且审计不记录单元格内容", async () => {
    const bytes = await twoSheetOtherArchiveBytes();
    const batch = {
      id: "batch-source",
      kind: "OTHER",
      status: "COMMITTED",
      createdById: "finance-user",
      sourceFile: {
        fileName: "case-register-snapshot.xlsm",
        storagePath: "finance-imports/202609/source.bin",
        mimeType: "application/vnd.ms-excel.sheet.macroEnabled.12",
        byteSize: bytes.byteLength
      }
    };
    const db = { financeImportBatch: { findUnique: vi.fn().mockResolvedValue(batch) } };
    const storage = { ...storageMock(), readFile: vi.fn().mockResolvedValue(bytes) };
    const auditStrict = vi.fn().mockResolvedValue(undefined);

    const result = await previewFinanceImportSource("batch-source", { id: "finance-user", role: "FINANCE" }, { sheetIndex: 1, page: 1 }, {
      db: db as never,
      storage,
      auditStrict
    });

    expect(result).toMatchObject({
      kind: "OTHER",
      extension: "xlsm",
      available: true,
      selectedSheet: {
        index: 1,
        name: "登记B",
        totalRows: 2,
        page: 1,
        rows: [{ sourceRow: 1, cells: ["编号", "说明"] }, { sourceRow: 2, cells: ["B-1", "synthetic three"] }]
      }
    });
    expect(storage.readFile).toHaveBeenCalledTimes(1);
    expect(auditStrict).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(auditStrict.mock.calls)).not.toContain("synthetic");
  });

  it("没有来源读取权限时不读取私有原件", async () => {
    const bytes = await twoSheetOtherArchiveBytes();
    const db = { financeImportBatch: { findUnique: vi.fn().mockResolvedValue({
      id: "batch-source", kind: "OTHER", status: "COMMITTED", createdById: "finance-user",
      sourceFile: { fileName: "private.xlsx", storagePath: "private.bin", mimeType: "application/octet-stream", byteSize: bytes.byteLength }
    }) } };
    const storage = { ...storageMock(), readFile: vi.fn().mockResolvedValue(bytes) };

    await expect(previewFinanceImportSource("batch-source", { id: "other-user", role: "USER" }, {}, {
      db: db as never,
      storage
    })).rejects.toThrow("无权访问该来源文件");
    expect(storage.readFile).not.toHaveBeenCalled();
  });

  it("不支持在线预览的来源也记录访问审计，且不读取原件", async () => {
    const db = { financeImportBatch: { findUnique: vi.fn().mockResolvedValue({
      id: "batch-source", kind: "OTHER", status: "COMMITTED", createdById: "finance-user",
      sourceFile: { fileName: "private.bin", storagePath: "private.bin", mimeType: "application/octet-stream", byteSize: 8 }
    }) } };
    const storage = { ...storageMock(), readFile: vi.fn() };
    const auditStrict = vi.fn().mockResolvedValue(undefined);

    const result = await previewFinanceImportSource("batch-source", { id: "finance-user", role: "FINANCE" }, {}, {
      db: db as never,
      storage,
      auditStrict
    });

    expect(result).toMatchObject({ available: false, extension: "bin" });
    expect(storage.readFile).not.toHaveBeenCalled();
    expect(auditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "FINANCE_INTERNAL_IMPORT_SOURCE_PREVIEW",
      detail: expect.objectContaining({ fileExtension: "bin" })
    }));
  });

  it("拒绝跨文件重复银行行，且不写原件或数据库", async () => {
    const { db } = transactionDb();
    db.financeImportBatch.findUnique.mockResolvedValue(null);
    const fixture = makeSyntheticFinanceFixture();
    const bytes = Buffer.from([
      "日期,对方户名,贷方发生额,账号,摘要,无关列",
      `${fixture.bankRow.occurredAt},${fixture.bankRow.counterparty},${fixture.bankRow.amount},6222000000000001,${fixture.bankRow.description},different-copy`
    ].join("\n"), "utf8");
    const preview = await previewFinanceImport(formDataFor("duplicate-row.csv"), depsFor(db, storageMock()));
    db.financeSourceRow.findMany.mockResolvedValue([{ metadata: { rowFingerprint: rowFingerprint(preview.rows[0] as FinanceNormalizedRow) } }]);
    const storage = storageMock();

    await expect(commitFinanceImport({ fileName: "second-copy.csv", kind: "BANK_STATEMENT", bytes }, depsFor(db, storage)))
      .rejects.toThrow("包含已导入的重复流水行");

    expect(storage.writeFile).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("拒绝同一工资记录重复进入另一来源文件", async () => {
    vi.stubEnv("STORAGE_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    const { db } = transactionDb();
    db.financeImportBatch.findUnique.mockResolvedValue(null);
    const bytes = Buffer.from(
      "月份,姓名,申报工资,实际支付,自担社保\n2026-08,合成人员甲,15000.00,12000.00,800.00",
      "utf8"
    );
    const duplicateDigest = financeTypedRecordFingerprint("PAYROLL", {
      displayName: "合成人员甲",
      period: "2026-08",
      declaredSalary: "15000.00",
      actualCashPaid: "12000.00",
      selfCostDue: "800.00"
    }, Buffer.alloc(32, 7));
    db.financeImportRecord.findMany.mockResolvedValue([{ normalizedDigest: duplicateDigest }]);
    const storage = storageMock();

    await expect(commitFinanceImport({ fileName: "same-payroll-different-copy.csv", kind: "PAYROLL", bytes }, depsFor(db, storage)))
      .rejects.toThrow("包含已导入的重复财务记录");

    expect(storage.writeFile).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("相同金额和账期的不同工资人员不会被误判为重复", async () => {
    vi.stubEnv("STORAGE_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    const { db, tx } = transactionDb();
    db.financeImportBatch.findUnique.mockResolvedValue(null);
    db.financeImportRecord.findMany.mockResolvedValue([{
      normalizedDigest: financeTypedRecordFingerprint("PAYROLL", {
        displayName: "合成人员甲",
        period: "2026-08",
        declaredSalary: "15000.00",
        actualCashPaid: "12000.00",
        selfCostDue: "800.00"
      }, Buffer.alloc(32, 7))
    }]);
    const bytes = Buffer.from(
      "月份,姓名,申报工资,实际支付,自担社保\n2026-08,合成人员乙,15000.00,12000.00,800.00",
      "utf8"
    );

    await expect(commitFinanceImport({ fileName: "synthetic-payroll-other-person.csv", kind: "PAYROLL", bytes }, depsFor(db, storageMock())))
      .resolves.toMatchObject({ duplicate: false });

    expect(tx.financeImportRecord.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({ displayName: "合成人员乙" })]
    }));
  });

  it("多账期银行流水在写私有原件前被拒绝", async () => {
    const { db } = transactionDb();
    db.financeImportBatch.findUnique.mockResolvedValue(null);
    const bytes = Buffer.from("日期,对方户名,贷方发生额\n2026-07-31,合成甲,100\n2026-08-01,合成乙,200", "utf8");
    const storage = storageMock();

    await expect(commitFinanceImport({ fileName: "multi-period.csv", kind: "BANK_STATEMENT", bytes }, depsFor(db, storage)))
      .rejects.toThrow("包含多个账期");

    expect(storage.writeFile).not.toHaveBeenCalled();
  });

  it("预览应用工作表列索引映射且只返回表头与摘要，不保存原始样例", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("账户流水");
    sheet.addRow(["入账日期", "收付数"]);
    sheet.addRow(["2026-08-03", "250.00"]);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const form = new FormData();
    form.set("kind", "BANK_STATEMENT");
    form.set("columnMappingsBySheet", JSON.stringify({ "账户流水": { occurredAt: 0, amount: 1 } }));
    form.set("file", new File([bytes], "synthetic.xlsx"));
    const { db } = transactionDb();
    const storage = storageMock();

    const result = await previewFinanceImport(form, depsFor(db, storage));

    expect(result.rows).toMatchObject([{ sourceSheet: "账户流水", sourceRowNumber: 2, occurredAt: "2026-08-03", amount: "250.00" }]);
    expect(result.sheets).toMatchObject([{ sourceSheet: "账户流水", headerRowNumber: 1, mapping: { occurredAt: 0, amount: 1 } }]);
    expect(JSON.stringify(result.sheets)).not.toContain("250.00");
    expect(storage.writeFile).not.toHaveBeenCalled();
  });

  it("PDF 含未结构化页面时拒绝归档任何结构化行", async () => {
    const { db } = transactionDb();
    const storage = storageMock();
    const document = {
      version: 1 as const,
      pages: [{ pageNumber: 1, extraction: "TEXT_CANDIDATE" as const, tables: [], ocrWords: [] }]
    };
    const preprocess = vi.fn().mockResolvedValue({ kind: "PDF", document } satisfies FinancePreprocessedUpload);

    await expect(commitFinanceImport({ fileName: "synthetic.pdf", kind: "BANK_STATEMENT", bytes: Buffer.from("pdf") }, { ...depsFor(db, storage), preprocess }))
      .rejects.toThrow("PDF 页面未能形成稳定表格");
    expect(storage.writeFile).not.toHaveBeenCalled();
    expect(db.financeImportBatch.findUnique).not.toHaveBeenCalled();
  });

  it("工资表只归档类型化记录，不制造银行流水或待认领案件", async () => {
    vi.stubEnv("STORAGE_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
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
        sourceSheet: "CSV",
        sourceRow: 2,
        kind: "PAYROLL",
        displayName: "合成人员甲",
        period: "2026-08",
        declaredSalary: "15000.00",
        actualCashPaid: "12000.00",
        selfCostDue: "800.00"
      })]
    });
    const storedRecord = tx.financeImportRecord.createMany.mock.calls[0][0].data[0];
    expect(storedRecord.displayName).toBe("合成人员甲");
    expect(storedRecord).not.toHaveProperty("displayNameDigest");
    expect(tx.financeSourceRow.createMany).not.toHaveBeenCalled();
    expect(tx.financeReconciliationCase.createMany).not.toHaveBeenCalled();
  });

  it("银行来源行以工作表和行号共同定位，不把不同表的第 2 行冲突", async () => {
    const { db, tx } = transactionDb();
    db.financeImportBatch.findUnique.mockResolvedValue(null);
    const storage = storageMock();

    await commitFinanceImport(
      { fileName: "synthetic-bank.xlsx", kind: "BANK_STATEMENT", bytes: await twoSheetBankBytes() },
      depsFor(db, storage)
    );

    const sourceRows = tx.financeSourceRow.createMany.mock.calls[0][0].data as Array<{ sourceSheet?: string; sourceRow: number }>;
    expect(sourceRows.map((row) => [row.sourceSheet, row.sourceRow])).toEqual([["银行A", 2], ["银行B", 2]]);
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

  it("读取来源原件前先审计下载尝试，存储读取失败仍留有审计记录", async () => {
    const { db } = transactionDb();
    db.financeImportBatch.findUnique.mockResolvedValue({
      id: "batch-old",
      kind: "OTHER",
      createdById: "synthetic-user-2",
      status: "COMMITTED",
      sourceFile: {
        fileName: "synthetic.csv",
        storagePath: "finance-imports/202609/source.bin",
        mimeType: "text/csv",
        byteSize: 12
      }
    });
    const readFile = vi.fn().mockRejectedValue(new Error("synthetic storage failure"));
    const storage = { ...storageMock(), readFile };
    const auditStrict = vi.fn().mockResolvedValue(undefined);
    const deps = depsFor(db, storage);
    deps.auditStrict = auditStrict;
    storage.readFile = readFile;

    await expect(downloadFinanceImportSource(
      "batch-old",
      { id: "synthetic-user-2", role: "FINANCE" },
      deps
    )).rejects.toThrow("synthetic storage failure");

    expect(auditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "FINANCE_INTERNAL_IMPORT_SOURCE_DOWNLOAD_ATTEMPT",
      targetId: "batch-old",
      detail: expect.objectContaining({ kind: "OTHER", fileExtension: "csv" })
    }));
    expect(auditStrict.mock.invocationCallOrder[0]).toBeLessThan(readFile.mock.invocationCallOrder[0]);
  });
});
