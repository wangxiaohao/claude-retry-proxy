# claude-retry-proxy

本地反向代理：架在 **Claude Code 和 Anthropic API 之间**，自动重试失败请求、掐断卡死连接，对客户端完全无感。可串联你的全局代理（如 clash 的 `127.0.0.1:7890`）。零依赖，纯 Node.js。

## 它解决什么问题

用 Claude Code 时你可能遇到过这些情况：

- **频繁报 403 / `Permission denied`**，但在对话框里输一句「继续」又能恢复——说明不是真的没权限，只是上游间歇性拒绝；
- **请求挂住几十秒甚至一两分钟**没有任何输出，尤其当流量经 clash 等代理出站、节点偶尔瞬断时；
- 网络抖一下就**直接报错中断**，得手动重来。

本代理把这些「人肉重试」自动化掉：

| 问题 | 现象 | 代理的做法 |
|---|---|---|
| 间歇性 403 | `permission_error`，手动「继续」就能恢复 | 按固定间隔自动重试（默认 0.8s/次，最多 10 次），客户端只看到最终成功的那次响应 |
| 偶发网络错误 / 5xx / 429 | 断流、超时、限流 | 指数退避 + 抖动自动重试 |
| 连接卡死 | 出站代理节点瞬断，请求挂死无响应 | 建连阶段（CONNECT+TLS）默认 10s 超时，卡死快速失败转入重试 |
| 重试拖太久 | 盲目重试把单个请求拖得过长 | 可选的单次响应头超时（`--connect-timeout`）与整轮总时限（`--total-timeout`），默认关闭——高延迟链路上正常请求也可能 ~60s 才回响应头，激进默认值会误杀本会成功的请求 |

代理**不修改、不记录**任何请求内容；失败与重试都发生在代理内部，Claude Code 要么拿到成功响应，要么拿到最终失败，不会感知中间过程。

## 工作原理

```
Claude Code
   │  ANTHROPIC_BASE_URL → http://127.0.0.1:7893（本地，明文）
   ▼
claude-retry-proxy  ← 403/网络错误 → 等待后重试，最多 N 次；卡死连接被超时闸门掐断；成功前不向下游吐任何字节
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
- **流式 SSE 原样透传**（403 是在流开始前就以完整状态码返回的，因此不影响流式；超时闸门在响应头到达后即解除，长流不会被误杀）。
- **零运行时依赖**，纯 Node.js 内置模块。

## 快速上手

```bash
# 1. 启动代理（串联 clash 等全局代理）
node bin/claude-retry-proxy.js --port 7893 --proxy http://127.0.0.1:7890

# 2. 让 Claude Code 走代理（临时验证）
ANTHROPIC_BASE_URL=http://127.0.0.1:7893 claude

# 3. 确认生效
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST http://127.0.0.1:7893/v1/messages \
  -H 'content-type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{}'
# → 401（鉴权失败）说明流量已经过代理转发到 Anthropic
```

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

## 配置

### 1. 启动代理

**串联全局代理（推荐）：**

```bash
node bin/claude-retry-proxy.js --port 7893 --proxy http://127.0.0.1:7890
```

若已设置了 `HTTPS_PROXY` / `ALL_PROXY` 环境变量，可省略 `--proxy`，会自动读取。

**直连（不经全局代理）：**

```bash
node bin/claude-retry-proxy.js --port 7893
```

**后台常驻：**

```bash
./start.sh           # 后台启动，日志写到 /tmp/claude-retry-proxy.log
./start.sh stop      # 停止
./start.sh status    # 查看状态
./start.sh restart   # 重启
```

### 2. 让 Claude Code 走代理

> ⚠️ **必须通过 `ANTHROPIC_BASE_URL` 指向代理，仅设置 `HTTPS_PROXY` 不起作用。**
> 这是反向代理，不是 HTTP CONNECT 正向代理，Claude Code 需要显式指向它的地址。

**方式一：全局永久（推荐）**

写入 `~/.claude/settings.json` 的 `env` 块，所有 Claude Code 实例自动生效：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:7893"
  }
}
```

可用 `jq` 合并写入（不破坏现有配置）：

```bash
tmp=$(mktemp)
jq '.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:7893"' ~/.claude/settings.json > "$tmp" \
  && mv "$tmp" ~/.claude/settings.json
```

**修改后须重启 Claude Code**（环境变量在进程启动时读取，热加载无效）。

---

**方式二：shell 配置文件**

```bash
echo 'export ANTHROPIC_BASE_URL=http://127.0.0.1:7893' >> ~/.zshrc
source ~/.zshrc
```

注意：仅对从该终端新开的 claude 进程生效；已在跑的进程、桌面快捷方式等不受影响。

---

**方式三：临时单次**

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:7893 claude
```

### 3. 项目级覆盖

在某个项目下建 `.claude/settings.local.json`（不提交到 git）可覆盖全局设置：

**该项目跳过代理，直连 Anthropic：**

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": ""
  }
}
```

**该项目用不同端口：**

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:7894"
  }
}
```

设置优先级：**local > project > user（全局）**，后者覆盖前者。

### 4. 确认生效

重启 Claude Code 后，查看进程实际环境变量：

```bash
ps eww $(pgrep -n claude) | tr ' ' '\n' | grep ANTHROPIC_BASE_URL
# 看到 http://127.0.0.1:7893 即生效
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
| `--max-retries` | `RETRY_MAX` | `10` | 最大重试次数（不含首发） |
| `--base-delay` | `RETRY_DELAY_MS` | `600` | 退避基数（ms） |
| `--max-delay` | `RETRY_MAX_DELAY_MS` | `8000` | 退避上限（ms） |
| `--jitter` | `RETRY_JITTER` | `true` | 是否加抖动 |
| `--retry-statuses` | `RETRY_STATUSES` | `403,408,429,500,502,503,504` | 命中即重试的状态码 |
| `--status-delays` | `RETRY_STATUS_DELAYS` | `403:800` | 特定状态码的固定重试间隔(ms)，如 `403:800,429:2000`；命中即不走退避 |
| `--establish-timeout` | `RETRY_ESTABLISH_TIMEOUT_MS` | `10000` | 建连阶段（CONNECT 隧道+TLS 握手）超时(ms)，`0`=不限制；仅经 `--proxy` 出站时生效 |
| `--connect-timeout` | `RETRY_CONNECT_TIMEOUT_MS` | `0`（不限） | 单次请求"发出→收到响应头"的超时(ms)；响应头到达后即解除，不影响长流式输出 |
| `--total-timeout` | `RETRY_TOTAL_TIMEOUT_MS` | `0`（不限） | 单个请求含全部重试的总时限(ms)；到点不再发起新重试，透传最后一次结果 |
| `--retry-network-errors` | `RETRY_NETWORK_ERRORS` | `true` | 网络错误是否重试 |
| `--verbose` | `RETRY_VERBOSE` | `false` | 打印每个请求 |

退避策略：第 n 次重试延时 = `min(baseDelay × 2^(n-1), maxDelay)`，开启抖动时在 `[delay/2, delay]` 内取值。

例外——固定间隔：在 `--status-delays` 中列出的状态码使用**固定间隔**重试（不指数退避、不抖动、不受 `maxDelay` 封顶）。默认 `403:800`，即 403（多为瞬时权限错误，手动「继续」即恢复）每次重试稳定等 0.8s；429/5xx 及网络错误仍走上面的指数退避。

时长闸门（三层，由细到粗）：建连阶段（CONNECT 隧道 + TLS 握手，正常 ~1s）超过 `--establish-timeout` 即中止——出站代理节点瞬断时连接多卡死在这一段，10s 快速失败比陪等省下大量重试预算；单次尝试从发起到收到响应头超过 `--connect-timeout` 即作为网络错误中止（可重试）；整个请求（含全部重试与等待）超过 `--total-timeout` 后不再发起新重试，直接把最后一次结果透传给客户端。

> **后两层默认关闭（`0`=不限）**：经出站代理的高延迟链路上，最终会成功的请求从发出到收到响应头实测可达 ~60s、整轮重试可超 70s。若默认开启 30s/60s 这类阈值，会把这些本会成功的慢请求中途掐断成 502/403，表现为 Claude Code 持续报错不可用。只有确认自己链路的正常响应头延迟远小于阈值时，才建议显式开启这两层。

## 测试

```bash
npm test          # 运行全部单元 + 集成测试（node:test）
npm run check     # 仅语法检查
```

测试覆盖：重试逻辑（首发成功 / N 次 403 后成功 / 耗尽 / 非重试码 / 网络错误 / 退避计算 / 总时限）、配置解析、隧道建连超时，以及对伪上游的端到端集成（重试、请求体重发、SSE 透传、超时闸门、502 兜底）。

## 注意事项

- **代理未启动时 Claude Code 无法连接**：若通过 `~/.claude/settings.json` 全局配置了 `ANTHROPIC_BASE_URL`，代理必须先启动，否则 Claude Code 起不来。建议配合系统自启（macOS LaunchAgent 等）使用。
- **403 有两种，代理只能治其一**：偶发/区域性 403（手动「继续」能恢复）→ 代理有效；登录态失效的真·鉴权 403 → 需要 `/login` 重新登录，重试无效。
- **本代理不修改、不记录**请求/响应内容（除非 `--verbose` 打印请求行）。鉴权头（`x-api-key` / `authorization`）原样转发。
- 默认只监听 `127.0.0.1`，不要绑到 `0.0.0.0` 暴露到公网。
- 仅重试**幂等性可接受**的场景。Anthropic 的 messages 接口在 403/限流下重试是安全的；如把它用于其它有副作用的 API，请按需收窄 `--retry-statuses`。

## License

MIT
