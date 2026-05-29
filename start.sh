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

case "$cmd" in
    start)
        if is_running; then
            echo "已在运行 (PID $(cat "$PID_FILE"))，端口 $PORT"
            exit 0
        fi
        nohup node "$DIR/bin/claude-retry-proxy.js" --port "$PORT" --proxy "$PROXY" \
            >"$LOG_FILE" 2>&1 &
        echo $! > "$PID_FILE"
        sleep 0.5
        echo "已启动 PID $(cat "$PID_FILE")，监听 127.0.0.1:${PORT}，日志 ${LOG_FILE}"
        echo "让 Claude Code 使用：export ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT"
        ;;
    stop)
        if is_running; then
            kill "$(cat "$PID_FILE")" && rm -f "$PID_FILE"
            echo "已停止"
        else
            echo "未在运行"
            rm -f "$PID_FILE"
        fi
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
