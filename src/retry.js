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
//   retryStatuses       命中则重试的状态码数组。
//   retryNetworkErrors  doAttempt 抛错时是否重试。
//   baseDelayMs/maxDelayMs/jitter  退避参数。
//   statusDelays        状态码→固定间隔(ms)；命中的状态码用固定值，不走退避（如 {403:1500}）。
//   totalDeadlineMs     含全部重试的总时长上限(ms)；0/缺省表示不限制。
//   now()               时钟函数（测试可注入），默认 Date.now。
//   sleep(ms)           延时函数（测试可注入）。
//   discard(result)     重试前丢弃上一次响应体（可选，返回 Promise）。
//   onRetry(info)       每次重试前回调：{ attempt, delay, maxRetries, statusCode, error }。
//
// 返回 { result, attempts, deadlineExceeded }；首次即成功则 attempts=1；
// deadlineExceeded=true 表示因总时长上限提前放弃（而非次数耗尽）。
// 若全部尝试都抛错，则抛出最后一次错误；因 deadline 放弃时错误上带 retryDeadlineExceeded=true。
async function requestWithRetry(doAttempt, opts) {
    const {
        maxRetries = 10,
        retryStatuses = [403],
        retryNetworkErrors = true,
        baseDelayMs = 600,
        maxDelayMs = 8000,
        jitter = true,
        statusDelays = {},     // 状态码→固定间隔(ms)；空则全部走指数退避（纯函数默认中立）
        totalDeadlineMs = 0,   // 0 = 不限制（纯函数默认中立）
        now = Date.now,
        random,
        sleep = defaultSleep,
        discard,
        onRetry,
    } = opts || {};

    const startedAt = now();
    // 决定是否还允许下一次重试：把即将等待的 delay 一并计入——睡过 deadline 再发起尝试没有意义。
    const withinDeadline = delay => totalDeadlineMs <= 0 || (now() - startedAt + delay) < totalDeadlineMs;

    let lastError = null;
    let lastStatus;
    let nextDelay = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
            if (onRetry) {
                onRetry({
                    attempt,
                    delay: nextDelay,
                    maxRetries,
                    statusCode: lastStatus,
                    error: lastError,
                });
            }
            await sleep(nextDelay);
        }

        let result;
        try {
            result = await doAttempt(attempt);
        } catch (err) {
            lastError = err;
            lastStatus = undefined;
            nextDelay = computeDelay(attempt + 1, { baseDelayMs, maxDelayMs, jitter, statusDelays, statusCode: lastStatus, random });
            if (retryNetworkErrors && attempt < maxRetries) {
                if (withinDeadline(nextDelay)) continue;
                err.retryDeadlineExceeded = true;
            }
            throw err;
        }

        lastStatus = result ? result.statusCode : undefined;
        nextDelay = computeDelay(attempt + 1, { baseDelayMs, maxDelayMs, jitter, statusDelays, statusCode: lastStatus, random });
        const wantRetry = retryStatuses.includes(lastStatus) && attempt < maxRetries;
        const within = wantRetry ? withinDeadline(nextDelay) : true;
        if (!wantRetry || !within) {
            return { result, attempts: attempt + 1, deadlineExceeded: wantRetry && !within };
        }

        if (discard) {
            try { await discard(result); } catch (_) { /* 丢弃失败不阻断重试 */ }
        }
    }

    // 理论上不可达（循环必定 return 或 throw），兜底抛出。
    if (lastError) throw lastError;
    throw new Error('requestWithRetry: 未获得任何结果');
}

function defaultSleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { requestWithRetry, computeDelay };
