# claude-retry-proxy

本地反向代理：拦截 **Claude Code / Anthropic API** 请求，当上游返回 **403**（或其它可重试状态码、网络错误）时，**自动透明重试**，对客户端无感。可串联你的全局代理（如 clash 的 `127.0.0.1:7890`）。

> 解决场景：用 Claude Code 时频繁遇到 403，手动输入「继续」就能恢复。本代理把这个「继续」自动化掉。

## 工作原理

```
Claude Code
   │  HTTP（本地，明文）
   ▼
claude-retry-proxy  ← 检测到 403 → 退避后重试，最多 N 次；成功前不向下游吐任何字节
   │  HTTPS（经 CONNECT 隧道）
   ▼
你的全局代理 127.0.0.1:7890   （可选；不配则直连）
   │
   ▼
api.anthropic.com
```

关键点：
- **重试对客户端完全透明** —— 只有当一次尝试不是可重试状态时，才开始把响应透传给 Claude Code，所以 Claude Code 永远只看到最终成功（或最终失败）的那一次。
- **请求体被缓存**，每次重试都完整重发。
- **流式 SSE 原样透传**（403 是在流开始前就以完整状态码返回的，因此不影响流式）。
- **零运行时依赖**，纯 Node.js 内置模块。

## 安装

无需依赖，克隆即用（Node ≥ 18）：

```bash
cd claude-retry-proxy
node bin/claude-retry-proxy.js --help
```

可选全局安装：

```bash
npm link        # 之后可直接用 claude-retry-proxy 命令
```

## 使用

### 1. 启动代理（串联全局代理 7890）

```bash
node bin/claude-retry-proxy.js 7893 http://127.0.0.1:7890
# 或显式写法
node bin/claude-retry-proxy.js --port 7893 --proxy http://127.0.0.1:7890
```

若已设置了 `HTTPS_PROXY` / `ALL_PROXY` 环境变量，可省略 `--proxy`，会自动读取。

不需要全局代理（直连）时：

```bash
node bin/claude-retry-proxy.js --port 7893
```

### 2. 让 Claude Code 走这个代理

**临时（单次）：**

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:7893 claude
```

**永久（写入 shell 配置）：**

```bash
echo 'export ANTHROPIC_BASE_URL=http://127.0.0.1:7893' >> ~/.zshrc
source ~/.zshrc
```

### 3. 后台常驻（可选）

```bash
./start.sh           # 后台启动，日志写到 /tmp/claude-retry-proxy.log
./start.sh stop      # 停止
./start.sh status    # 查看状态
```

## 配置项

CLI 标志、环境变量、默认值，优先级 **CLI > 环境变量 > 默认值**。

| CLI 标志 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `--port` | `RETRY_PROXY_PORT` | `7893` | 本地监听端口 |
| `--host` | `RETRY_PROXY_HOST` | `127.0.0.1` | 监听地址 |
| `--proxy` | `RETRY_UPSTREAM_PROXY`（回退 `HTTPS_PROXY`/`ALL_PROXY`） | 空 | 出站代理 URL |
| `--target` | `RETRY_TARGET_HOST` | `api.anthropic.com` | 上游主机 |
| `--target-port` | `RETRY_TARGET_PORT` | `443` | 上游端口 |
| `--target-protocol` | `RETRY_TARGET_PROTOCOL` | `https` | `http` / `https` |
| `--max-retries` | `RETRY_MAX` | `5` | 最大重试次数（不含首发） |
| `--base-delay` | `RETRY_DELAY_MS` | `600` | 退避基数（ms） |
| `--max-delay` | `RETRY_MAX_DELAY_MS` | `8000` | 退避上限（ms） |
| `--jitter` | `RETRY_JITTER` | `true` | 是否加抖动 |
| `--retry-statuses` | `RETRY_STATUSES` | `403,408,429,500,502,503,504` | 命中即重试的状态码 |
| `--retry-network-errors` | `RETRY_NETWORK_ERRORS` | `true` | 网络错误是否重试 |
| `--verbose` | `RETRY_VERBOSE` | `false` | 打印每个请求 |

退避策略：第 n 次重试延时 = `min(baseDelay × 2^(n-1), maxDelay)`，开启抖动时在 `[delay/2, delay]` 内取值。

## 测试

```bash
npm test          # 运行全部单元 + 集成测试（node:test）
npm run check     # 仅语法检查
```

测试覆盖：重试逻辑（首发成功 / N 次 403 后成功 / 耗尽 / 非重试码 / 网络错误 / 退避计算）、配置解析、以及对伪上游的端到端集成（重试、请求体重发、SSE 透传、502 兜底）。

## 安全与注意

- 本代理**不修改、不记录**请求/响应内容（除非 `--verbose` 打印请求行）。鉴权头（`x-api-key` / `authorization`）原样转发。
- 默认只监听 `127.0.0.1`，不要绑到 `0.0.0.0` 暴露到公网。
- 仅重试**幂等性可接受**的场景。Anthropic 的 messages 接口在 403/限流下重试是安全的；如把它用于其它有副作用的 API，请按需收窄 `--retry-statuses`。

## License

MIT
