import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { PrismaClient } from "@prisma/client";

export const PRIVATE_FINANCE_IMPORT_ACTOR_EMAIL = "lawlink-finance-import@invalid.invalid";
export const PRIVATE_FINANCE_IMPORT_ACTOR_NAME = "受控财务资料导入服务";

type PrivateImportActorDatabase = Pick<PrismaClient, "user">;
type PasswordHasher = (secret: string) => Promise<string>;

export async function ensurePrivateFinanceImportActor(
  db: PrivateImportActorDatabase,
  hashPassword: PasswordHasher = (secret) => bcrypt.hash(secret, 12)
): Promise<{ id: string }> {
  const existing = await db.user.findUnique({
    where: { email: PRIVATE_FINANCE_IMPORT_ACTOR_EMAIL },
    select: { id: true, name: true, role: true, roleDefinitionId: true, systemRole: true, active: true }
  });

  if (existing) {
    if (
      existing.name !== PRIVATE_FINANCE_IMPORT_ACTOR_NAME ||
      existing.role !== "CUSTOM" ||
      existing.roleDefinitionId !== null ||
      existing.systemRole !== "NONE" ||
      existing.active
    ) {
      throw new Error("受控导入审计账户身份不符");
    }
    return { id: existing.id };
  }

  const passwordHash = await hashPassword(randomBytes(48).toString("base64url"));
  const actor = await db.user.create({
    data: {
      name: PRIVATE_FINANCE_IMPORT_ACTOR_NAME,
      email: PRIVATE_FINANCE_IMPORT_ACTOR_EMAIL,
      passwordHash,
      role: "CUSTOM",
      roleDefinitionId: null,
      systemRole: "NONE",
      active: false
    },
    select: { id: true }
  });

  return { id: actor.id };
}
