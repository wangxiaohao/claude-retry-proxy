'use strict';
// retry.js — 纯重试逻辑，与网络/HTTP 解耦，便于单元测试。

// 指数退避 + 上限 + 可选抖动。attempt 从 1 开始计（第几次重试）。
//   statusDelays  状态码→固定间隔(ms) 映射；statusCode 命中时返回固定值（不退避/不抖动/不封顶）。
//   statusCode    触发本次重试的状态码（网络错误时为空，则走指数退避）。
function computeDelay(attempt, { baseDelayMs, maxDelayMs, jitter, statusDelays, statusCode, random = Math.random }) {
    // 针对特定状态码的固定重试间隔（如 403 瞬时权限错误，用稳定短间隔而非越退越久）。
    if (statusDelays && statusCode != null && statusDelays[statusCode] != null) {
        return statusDelays[statusCode];
    }
    const exp = baseDelayMs * Math.pow(2, attempt - 1);
    const capped = Math.min(exp, maxDelayMs);
    if (!jitter) return capped;
    // 全抖动 (full jitter)：在 [capped/2, capped] 之间取值，既退避又分散并发重试。
    return Math.round(capped / 2 + random() * (capped / 2));
}

// 对 doAttempt 执行带重试的调用。
//
// doAttempt(attempt): Promise<result>  —— 发起一次尝试，result 需含 .statusCode。
// 选项:
//   maxRetries          最大重试次数（不含首次）。
//   totalTimeoutMs      从首次尝试起的总时限(ms)；超时后停止重试。0 表示不限。
//   retryStatuses       命中则重试的状态码数组。
//   retryNetworkErrors  doAttempt 抛错时是否重试。
//   baseDelayMs/maxDelayMs/jitter  退避参数。
//   statusDelays        状态码→固定间隔(ms)；命中的状态码用固定值，不走退避（如 {403:1500}）。
//   sleep(ms)           延时函数（测试可注入）。
//   discard(result)     重试前丢弃上一次响应体（可选，返回 Promise）。
//   onRetry(info)       每次重试前回调：{ attempt, delay, maxRetries, statusCode, error }。
//   now()               返回当前时间戳(ms)，测试可注入。
//
// 返回 { result, attempts }；首次即成功则 attempts=1。
// 若全部尝试都抛错，则抛出最后一次错误。
async function requestWithRetry(doAttempt, opts) {
    const {
        maxRetries = 10,
        totalTimeoutMs = 0,    // 0 = 不限；> 0 时超时即停止重试
        retryStatuses = [403],
        retryNetworkErrors = true,
        baseDelayMs = 600,
        maxDelayMs = 8000,
        jitter = true,
        statusDelays = {},     // 状态码→固定间隔(ms)；空则全部走指数退避（纯函数默认中立）
        random,
        sleep = defaultSleep,
        discard,
        onRetry,
        now = () => Date.now(),
    } = opts || {};

    const startedAt = now();
    // 已超总时限：到点就停止重试（不影响已在途的当次尝试）。
    const deadlinePassed = () => totalTimeoutMs > 0 && now() - startedAt >= totalTimeoutMs;

    let lastError = null;

    for (let attempt = 0; ; attempt++) {
        let result;
        let failed = false;
        try {
            result = await doAttempt(attempt);
            lastError = null;
        } catch (err) {
            failed = true;
            lastError = err;
        }

        // 本次尝试是否还可重试：受 maxRetries 与总时限共同约束。
        // 超时判定放在本次尝试之后，使最终透传/抛出的是"最新"一次结果。
        if (failed) {
            if (!retryNetworkErrors || attempt >= maxRetries || deadlinePassed()) {
                throw lastError;
            }
        } else {
            const status = result ? result.statusCode : undefined;
            const wantRetry = retryStatuses.includes(status);
            if (!wantRetry || attempt >= maxRetries || deadlinePassed()) {
                return { result, attempts: attempt + 1 };
            }
            // 确定要重试，才丢弃这次响应体（否则 socket 泄漏）。
            if (discard) {
                try { await discard(result); } catch (_) { /* 丢弃失败不阻断重试 */ }
            }
        }

        // 安排下一次重试：计算退避并等待（剩余时间不足时截断等待）。
        const statusCode = failed ? undefined : (result ? result.statusCode : undefined);
        const delay = computeDelay(attempt + 1, { baseDelayMs, maxDelayMs, jitter, statusDelays, statusCode, random });
        if (onRetry) {
            onRetry({ attempt: attempt + 1, delay, maxRetries, statusCode, error: lastError });
        }
        const actualDelay = totalTimeoutMs > 0
            ? Math.min(delay, Math.max(0, totalTimeoutMs - (now() - startedAt)))
            : delay;
        await sleep(actualDelay);
    }
}

function defaultSleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { requestWithRetry, computeDelay };
