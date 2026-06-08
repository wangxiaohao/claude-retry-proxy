#!/usr/bin/env bash
# start.sh — 后台启动/停止/查看 claude-retry-proxy。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${RETRY_PROXY_PORT:-7893}"
PROXY="${RETRY_UPSTREAM_PROXY:-${HTTPS_PROXY:-http://127.0.0.1:7890}}"
PID_FILE="$DIR/.retry-proxy.pid"
LOG_FILE="${RETRY_PROXY_LOG:-/tmp/claude-retry-proxy.log}"

cmd="${1:-start}"

is_running() {
    [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}

# 按端口查找正在 LISTEN 的进程并关闭（不依赖 PID 文件，兜底清理残留/失管进程）。
# 先 TERM，等待至多 ~2s，仍占用则 KILL 强杀。
free_port() {
    command -v lsof >/dev/null 2>&1 || return 0
    local pids
    pids="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    [[ -z "$pids" ]] && return 0
    echo "端口 $PORT 被占用 (PID: $(echo "$pids" | tr '\n' ' ' | sed 's/ $//'))，正在关闭…"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    for _ in $(seq 1 10); do
        sleep 0.2
        lsof -ti "tcp:$PORT" -sTCP:LISTEN >/dev/null 2>&1 || return 0
    done
    pids="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
        echo "未能优雅关闭，强制结束 (PID: $(echo "$pids" | tr '\n' ' ' | sed 's/ $//'))"
        # shellcheck disable=SC2086
        kill -9 $pids 2>/dev/null || true
        sleep 0.3
    fi
}

case "$cmd" in
    start)
        # 启动前先按端口关闭任何占用进程，确保端口空闲后再启动。
        free_port
        rm -f "$PID_FILE"
        nohup node "$DIR/bin/claude-retry-proxy.js" --port "$PORT" --proxy "$PROXY" \
            >"$LOG_FILE" 2>&1 &
        echo $! > "$PID_FILE"
        sleep 0.5
        echo "已启动 PID $(cat "$PID_FILE")，监听 127.0.0.1:${PORT}，日志 ${LOG_FILE}"
        echo "让 Claude Code 使用：export ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT"
        ;;
    stop)
        if is_running; then
            kill "$(cat "$PID_FILE")" 2>/dev/null || true
            echo "已停止 (PID $(cat "$PID_FILE"))"
        fi
        rm -f "$PID_FILE"
        # 兜底：按端口清理 PID 文件之外的残留进程。
        free_port
        ;;
    restart)
        "$0" stop || true
        sleep 0.3
        "$0" start
        ;;
    status)
        if is_running; then
            echo "运行中 (PID $(cat "$PID_FILE"))，端口 ${PORT}，日志 ${LOG_FILE}"
        else
            echo "未运行"
        fi
        ;;
    *)
        echo "用法: $0 {start|stop|restart|status}"
        exit 1
        ;;
esac
