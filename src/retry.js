'use strict';
// retry.js — 纯重试逻辑，与网络/HTTP 解耦，便于单元测试。

// 指数退避 + 上限 + 可选抖动。attempt 从 1 开始计（第几次重试）。
function computeDelay(attempt, { baseDelayMs, maxDelayMs, jitter, random = Math.random }) {
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
//   sleep(ms)           延时函数（测试可注入）。
//   discard(result)     重试前丢弃上一次响应体（可选，返回 Promise）。
//   onRetry(info)       每次重试前回调：{ attempt, delay, maxRetries, statusCode, error }。
//
// 返回 { result, attempts }；首次即成功则 attempts=1。
// 若全部尝试都抛错，则抛出最后一次错误。
async function requestWithRetry(doAttempt, opts) {
    const {
        maxRetries = 5,
        retryStatuses = [403],
        retryNetworkErrors = true,
        baseDelayMs = 600,
        maxDelayMs = 8000,
        jitter = true,
        random,
        sleep = defaultSleep,
        discard,
        onRetry,
    } = opts || {};

    let lastError = null;
    let lastStatus;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
            const delay = computeDelay(attempt, { baseDelayMs, maxDelayMs, jitter, random });
            if (onRetry) {
                onRetry({
                    attempt,
                    delay,
                    maxRetries,
                    statusCode: lastStatus,
                    error: lastError,
                });
            }
            await sleep(delay);
        }

        let result;
        try {
            result = await doAttempt(attempt);
        } catch (err) {
            lastError = err;
            lastStatus = undefined;
            if (retryNetworkErrors && attempt < maxRetries) {
                continue;
            }
            throw err;
        }

        lastStatus = result ? result.statusCode : undefined;
        const retriable = retryStatuses.includes(lastStatus) && attempt < maxRetries;
        if (!retriable) {
            return { result, attempts: attempt + 1 };
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
