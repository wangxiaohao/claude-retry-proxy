'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { requestWithRetry, computeDelay } = require('../src/retry');

const noSleep = () => Promise.resolve();

test('首次即成功，attempts=1，不触发重试', async () => {
    let calls = 0;
    const { result, attempts } = await requestWithRetry(
        () => { calls++; return Promise.resolve({ statusCode: 200 }); },
        { maxRetries: 5, retryStatuses: [403], sleep: noSleep }
    );
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(attempts, 1);
    assert.strictEqual(calls, 1);
});

test('403 两次后成功，attempts=3', async () => {
    const seq = [403, 403, 200];
    let i = 0;
    const retries = [];
    const { result, attempts } = await requestWithRetry(
        () => Promise.resolve({ statusCode: seq[i++] }),
        {
            maxRetries: 5,
            retryStatuses: [403],
            sleep: noSleep,
            onRetry: info => retries.push(info.attempt),
        }
    );
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(attempts, 3);
    assert.deepStrictEqual(retries, [1, 2]);
});

test('始终 403，耗尽重试后返回最后一次 403（不抛错）', async () => {
    let calls = 0;
    const { result, attempts } = await requestWithRetry(
        () => { calls++; return Promise.resolve({ statusCode: 403 }); },
        { maxRetries: 3, retryStatuses: [403], sleep: noSleep }
    );
    assert.strictEqual(result.statusCode, 403);
    assert.strictEqual(attempts, 4);       // 1 次首发 + 3 次重试
    assert.strictEqual(calls, 4);
});

test('非重试状态码（如 401）立即返回，不重试', async () => {
    let calls = 0;
    const { result, attempts } = await requestWithRetry(
        () => { calls++; return Promise.resolve({ statusCode: 401 }); },
        { maxRetries: 5, retryStatuses: [403], sleep: noSleep }
    );
    assert.strictEqual(result.statusCode, 401);
    assert.strictEqual(attempts, 1);
    assert.strictEqual(calls, 1);
});

test('网络错误在 retryNetworkErrors=true 时重试', async () => {
    let calls = 0;
    const { result, attempts } = await requestWithRetry(
        () => {
            calls++;
            if (calls < 3) return Promise.reject(new Error('ECONNRESET'));
            return Promise.resolve({ statusCode: 200 });
        },
        { maxRetries: 5, retryStatuses: [403], retryNetworkErrors: true, sleep: noSleep }
    );
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(attempts, 3);
    assert.strictEqual(calls, 3);
});

test('网络错误在 retryNetworkErrors=false 时直接抛出', async () => {
    await assert.rejects(
        () => requestWithRetry(
            () => Promise.reject(new Error('boom')),
            { maxRetries: 5, retryStatuses: [403], retryNetworkErrors: false, sleep: noSleep }
        ),
        /boom/
    );
});

test('持续网络错误耗尽重试后抛出最后一次错误', async () => {
    let calls = 0;
    await assert.rejects(
        () => requestWithRetry(
            () => { calls++; return Promise.reject(new Error(`fail-${calls}`)); },
            { maxRetries: 2, retryStatuses: [403], retryNetworkErrors: true, sleep: noSleep }
        ),
        /fail-3/
    );
    assert.strictEqual(calls, 3);
});

test('重试前调用 discard 丢弃上一次响应体', async () => {
    const seq = [403, 200];
    let i = 0;
    const discarded = [];
    await requestWithRetry(
        () => Promise.resolve({ statusCode: seq[i], _id: i++ }),
        {
            maxRetries: 5,
            retryStatuses: [403],
            sleep: noSleep,
            discard: res => { discarded.push(res._id); return Promise.resolve(); },
        }
    );
    assert.deepStrictEqual(discarded, [0]); // 只丢弃了那次 403
});

test('discard 抛错不应中断重试', async () => {
    const seq = [403, 200];
    let i = 0;
    const { result } = await requestWithRetry(
        () => Promise.resolve({ statusCode: seq[i++] }),
        {
            maxRetries: 5,
            retryStatuses: [403],
            sleep: noSleep,
            discard: () => Promise.reject(new Error('drain failed')),
        }
    );
    assert.strictEqual(result.statusCode, 200);
});

test('onRetry 收到正确的 attempt/statusCode/delay', async () => {
    const seq = [403, 503, 200];
    let i = 0;
    const infos = [];
    await requestWithRetry(
        () => Promise.resolve({ statusCode: seq[i++] }),
        {
            maxRetries: 5,
            retryStatuses: [403, 503],
            jitter: false,
            baseDelayMs: 100,
            maxDelayMs: 10000,
            sleep: noSleep,
            onRetry: info => infos.push(info),
        }
    );
    assert.strictEqual(infos.length, 2);
    assert.strictEqual(infos[0].statusCode, 403);
    assert.strictEqual(infos[0].delay, 100);   // 100 * 2^0
    assert.strictEqual(infos[1].statusCode, 503);
    assert.strictEqual(infos[1].delay, 200);   // 100 * 2^1
});

test('computeDelay 指数退避，无抖动', () => {
    const opt = { baseDelayMs: 500, maxDelayMs: 8000, jitter: false };
    assert.strictEqual(computeDelay(1, opt), 500);
    assert.strictEqual(computeDelay(2, opt), 1000);
    assert.strictEqual(computeDelay(3, opt), 2000);
    assert.strictEqual(computeDelay(4, opt), 4000);
});

test('computeDelay 受 maxDelayMs 封顶', () => {
    const opt = { baseDelayMs: 500, maxDelayMs: 3000, jitter: false };
    assert.strictEqual(computeDelay(5, opt), 3000); // 500*16=8000 → 封顶 3000
});

test('computeDelay 抖动落在 [cap/2, cap]', () => {
    const opt = { baseDelayMs: 1000, maxDelayMs: 8000, jitter: true, random: () => 0 };
    assert.strictEqual(computeDelay(1, opt), 500);  // cap=1000, random=0 → 500
    const opt2 = { baseDelayMs: 1000, maxDelayMs: 8000, jitter: true, random: () => 1 };
    assert.strictEqual(computeDelay(1, opt2), 1000); // random=1 → 1000
});

test('computeDelay: statusDelays 命中状态码时返回固定值（不指数、不抖动、不封顶）', () => {
    const opt = { baseDelayMs: 600, maxDelayMs: 800, jitter: true, statusDelays: { 403: 1500 }, statusCode: 403, random: () => 0 };
    assert.strictEqual(computeDelay(1, opt), 1500);
    assert.strictEqual(computeDelay(5, opt), 1500); // 任意 attempt 都固定，且超过 maxDelayMs 也不封顶
});

test('computeDelay: 未命中 statusDelays 的状态码仍走指数退避', () => {
    const opt = { baseDelayMs: 500, maxDelayMs: 8000, jitter: false, statusDelays: { 403: 1500 }, statusCode: 503 };
    assert.strictEqual(computeDelay(1, opt), 500);
    assert.strictEqual(computeDelay(2, opt), 1000);
});

test('computeDelay: statusCode 为空（网络错误）走指数退避', () => {
    const opt = { baseDelayMs: 500, maxDelayMs: 8000, jitter: false, statusDelays: { 403: 1500 } };
    assert.strictEqual(computeDelay(1, opt), 500);
});

test('requestWithRetry: 403 使用固定间隔，每次重试 delay 均为 statusDelays[403]', async () => {
    const seq = [403, 403, 403, 200];
    let i = 0;
    const delays = [];
    const { result, attempts } = await requestWithRetry(
        () => Promise.resolve({ statusCode: seq[i++] }),
        {
            maxRetries: 10,
            retryStatuses: [403],
            statusDelays: { 403: 1500 },
            jitter: true,              // 即便开了抖动，固定间隔也不抖
            baseDelayMs: 600,
            sleep: noSleep,
            onRetry: info => delays.push(info.delay),
        }
    );
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(attempts, 4);
    assert.deepStrictEqual(delays, [1500, 1500, 1500]);
});

test('requestWithRetry: 仅 403 固定，503 仍指数退避', async () => {
    const seq = [403, 503, 200];
    let i = 0;
    const infos = [];
    await requestWithRetry(
        () => Promise.resolve({ statusCode: seq[i++] }),
        {
            maxRetries: 10,
            retryStatuses: [403, 503],
            statusDelays: { 403: 1500 },
            jitter: false,
            baseDelayMs: 100,
            maxDelayMs: 10000,
            sleep: noSleep,
            onRetry: info => infos.push(info),
        }
    );
    assert.strictEqual(infos[0].statusCode, 403);
    assert.strictEqual(infos[0].delay, 1500);   // 固定
    assert.strictEqual(infos[1].statusCode, 503);
    assert.strictEqual(infos[1].delay, 200);    // 100 * 2^1，指数
});

test('requestWithRetry: 网络错误不命中固定表，走指数退避', async () => {
    let calls = 0;
    const delays = [];
    await requestWithRetry(
        () => {
            calls++;
            if (calls < 3) return Promise.reject(new Error('socket hang up'));
            return Promise.resolve({ statusCode: 200 });
        },
        {
            maxRetries: 10,
            retryStatuses: [403],
            statusDelays: { 403: 1500 },
            retryNetworkErrors: true,
            jitter: false,
            baseDelayMs: 100,
            maxDelayMs: 10000,
            sleep: noSleep,
            onRetry: info => delays.push(info.delay),
        }
    );
    assert.deepStrictEqual(delays, [100, 200]); // 指数，而非 1500
});

// —— 总时长上限 totalDeadlineMs ——
// 用假时钟：sleep 推进时间，便于确定性验证 deadline 截断。
function fakeClock() {
    let t = 0;
    return {
        now: () => t,
        sleep: ms => { t += ms; return Promise.resolve(); },
        advance: ms => { t += ms; },
    };
}

test('totalDeadlineMs: 到达上限后停止重试，返回最后一次响应并标记 deadlineExceeded', async () => {
    const clock = fakeClock();
    let calls = 0;
    const { result, attempts, deadlineExceeded } = await requestWithRetry(
        () => { calls++; return Promise.resolve({ statusCode: 403 }); },
        {
            maxRetries: 10,
            retryStatuses: [403],
            statusDelays: { 403: 800 },
            totalDeadlineMs: 2000,
            now: clock.now,
            sleep: clock.sleep,
        }
    );
    // t=0 首发 403 → 0+800<2000 重试；t=800 403 → 1600<2000 重试；t=1600 403 → 2400>=2000 停。
    assert.strictEqual(result.statusCode, 403);
    assert.strictEqual(attempts, 3);
    assert.strictEqual(calls, 3);
    assert.strictEqual(deadlineExceeded, true);
});

test('totalDeadlineMs=0 不限制：行为与旧逻辑一致，重试至次数耗尽', async () => {
    const clock = fakeClock();
    let calls = 0;
    const { attempts, deadlineExceeded } = await requestWithRetry(
        () => { calls++; return Promise.resolve({ statusCode: 403 }); },
        {
            maxRetries: 3,
            retryStatuses: [403],
            statusDelays: { 403: 800 },
            totalDeadlineMs: 0,
            now: clock.now,
            sleep: clock.sleep,
        }
    );
    assert.strictEqual(attempts, 4);
    assert.strictEqual(calls, 4);
    assert.strictEqual(deadlineExceeded, false);
});

test('totalDeadlineMs: 计入尝试本身的耗时（慢尝试更早触顶）', async () => {
    const clock = fakeClock();
    let calls = 0;
    const { attempts, deadlineExceeded } = await requestWithRetry(
        () => {
            calls++;
            clock.advance(900);     // 每次尝试本身耗 900ms
            return Promise.resolve({ statusCode: 403 });
        },
        {
            maxRetries: 10,
            retryStatuses: [403],
            statusDelays: { 403: 800 },
            totalDeadlineMs: 2000,
            now: clock.now,
            sleep: clock.sleep,
        }
    );
    // t=900 首发完 → 900+800<2000 重试；t=1700 睡完，t=2600 第 2 次完 → 2600+800>=2000 停。
    assert.strictEqual(attempts, 2);
    assert.strictEqual(calls, 2);
    assert.strictEqual(deadlineExceeded, true);
});

test('totalDeadlineMs: 网络错误路径同样受限，错误带 retryDeadlineExceeded 标记', async () => {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(
        () => requestWithRetry(
            () => { calls++; return Promise.reject(new Error('socket hang up')); },
            {
                maxRetries: 10,
                retryStatuses: [403],
                retryNetworkErrors: true,
                jitter: false,
                baseDelayMs: 600,
                maxDelayMs: 8000,
                totalDeadlineMs: 2000,
                now: clock.now,
                sleep: clock.sleep,
            }
        ),
        err => {
            assert.match(err.message, /socket hang up/);
            assert.strictEqual(err.retryDeadlineExceeded, true);
            return true;
        }
    );
    // 退避 600,1200,2400…：t=0 失败→睡600；t=600 失败→睡1200；t=1800 失败→1800+2400>=2000 停。
    assert.strictEqual(calls, 3);
});

test('totalDeadlineMs: 未触顶时 deadlineExceeded=false（成功路径）', async () => {
    const clock = fakeClock();
    const seq = [403, 200];
    let i = 0;
    const { result, deadlineExceeded } = await requestWithRetry(
        () => Promise.resolve({ statusCode: seq[i++] }),
        {
            maxRetries: 10,
            retryStatuses: [403],
            statusDelays: { 403: 800 },
            totalDeadlineMs: 60000,
            now: clock.now,
            sleep: clock.sleep,
        }
    );
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(deadlineExceeded, false);
});
