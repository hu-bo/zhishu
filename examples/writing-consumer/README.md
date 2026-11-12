# DSH 独立消费者

`pnpm start` 使用构建入口和明确的官方依赖运行真实 Agent Loop。host.mjs 是显式内存测试宿主，没有生产耐久性保证；模型为确定性 adapter，没有收费调用。生产宿主必须提供实际持久化、授权、预算和资源 owner。
