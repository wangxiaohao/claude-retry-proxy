#!/usr/bin/env node
'use strict';
// CLI 入口：解析配置并启动重试代理。

const { buildConfig } = require('../src/config');
const { start } = require('../src/server');

const HELP = `
claude-retry-proxy — 本地反向代理，遇到 403 等可重试状态自动重试。

用法:
  claude-retry-proxy [port] [upstreamProxy] [选项]

位置参数（兼容简写）:
  port              本地监听端口（默认 7892）
  upstreamProxy     出站代理 URL，如 http://127.0.0.1:7890

选项:
  --port <n>                  监听端口
  --host <addr>               监听地址（默认 127.0.0.1）
  --proxy <url>               出站代理（默认读 HTTPS_PROXY/ALL_PROXY）
  --target <host>             上游主机（默认 api.anthropic.com）
  --target-port <n>           上游端口（默认 443）
  --target-protocol <p>       http|https（默认 https）
  --max-retries <n>           最大重试次数（默认 5）
  --base-delay <ms>           退避基数（默认 600）
  --max-delay <ms>            退避上限（默认 8000）
  --jitter <bool>             是否抖动（默认 true）
  --retry-statuses <list>     可重试状态码，如 403,429,503（默认 403,408,429,500,502,503,504）
  --retry-network-errors <b>  网络错误是否重试（默认 true）
  --verbose                   打印每个请求
  -h, --help                  显示帮助

环境变量（与选项等价）:
  RETRY_PROXY_PORT  RETRY_UPSTREAM_PROXY  RETRY_MAX  RETRY_DELAY_MS
  RETRY_MAX_DELAY_MS  RETRY_STATUSES  RETRY_JITTER  RETRY_VERBOSE
  HTTPS_PROXY / ALL_PROXY（作为出站代理回退）

示例:
  claude-retry-proxy 7892 http://127.0.0.1:7890
  claude-retry-proxy --port 7892 --retry-statuses 403,429 --verbose
  ANTHROPIC_BASE_URL=http://127.0.0.1:7892 claude
`;

function main() {
    const config = buildConfig(process.argv.slice(2), process.env);
    if (config.help) {
        process.stdout.write(HELP);
        return;
    }
    const server = start(config);

    const shutdown = () => {
        server.close(() => process.exit(0));
        // 兜底：强制退出
        setTimeout(() => process.exit(0), 1000).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main();
