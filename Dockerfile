# LawLink 应用容器
# 多阶段构建：deps → builder → runner

FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# 自动备份链依赖（2026-09-20 第六轮体检 P1-1）：backup.sh 以 bash 运行并调用
# pg_dump。postgresql16-client 对齐 db 服务的 postgres:16（pg_dump 客户端主版本
# 须等于或高于服务器）。缺了这两样，镜像里备份每天失败。
RUN apk add --no-cache bash openssl postgresql16-client

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next-build ./.next-build
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
# 备份脚本必须进镜像：cron job 通过 process.cwd()/scripts/backup.sh 调用
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts

# backups 目录预先建好并授权：命名卷首次挂载会继承镜像内目录属主，
# 运行用户 nextjs 才能写入（BACKUP_DIR 默认 /app/backups）
RUN mkdir -p /app/storage /app/backups && chown -R nextjs:nodejs /app/storage /app/backups

USER nextjs
EXPOSE 3000
CMD ["npm", "run", "start"]
