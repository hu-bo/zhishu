# Repository Guide

工程使用 pnpm workspace，后端位于 `apps/server`，数据库位于内部目录 `apps/server/database`，Compose 位于 `deploy/compose.yaml`。目前仅包含后端。

## Architecture

feature 在 src/modules 内组装 repository 与 service；业务层不依赖 Fastify。
Zod route contract 驱动 validation 和 OpenAPI；domain-error 由 root handler 映射。
OpenAPI 离线导出不连接数据库，正常启动先检查数据库。database 与 src 一起编译，入口为 dist/src/server.js。

## Commands

使用 `pnpm format` 格式化，`pnpm check` 检查格式、lint、类型、build 与 OpenAPI。
`pnpm db:generate` 生成 migration，`pnpm db:migrate` 显式执行；已发布 migration 不回写。
根目录 .env 由 server 和 Drizzle 共用，环境变量优先。
