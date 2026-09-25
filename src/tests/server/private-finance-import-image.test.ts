import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("受控财务导入运行镜像依赖", () => {
  it("包含导入服务运行时会加载的认证模块源码", () => {
    const dockerfile = readFileSync(resolve(process.cwd(), "Dockerfile"), "utf8");

    expect(dockerfile).toContain(
      "COPY --from=builder --chown=nextjs:nodejs /app/src/server/auth/totp-login.ts ./src/server/auth/totp-login.ts"
    );
    expect(dockerfile).toContain("&& test -f src/server/auth/totp-login.ts");
  });
});
