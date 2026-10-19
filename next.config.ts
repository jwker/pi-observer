import type { NextConfig } from "next";

const config: NextConfig = {
  // 本仓库已有 AGENT.md；关掉 Next 16 自动生成的 AGENTS.md，避免两份规则文件
  agentRules: false,
  // 本机 home 目录下还有别的 lockfile，Turbopack 会往上找并误判工程根，显式锁定
  turbopack: { root: import.meta.dirname },
};

export default config;
