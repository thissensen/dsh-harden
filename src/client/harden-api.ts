/**
 * 设置页与自动清理共用的写端点助手。
 *
 * **为什么单独一个文件。** 面板的写回（配置、会话修复）与页面加载时的自动清理打的是同一族端点，
 * 写围栏要求的自定义头与 JSON content-type 在这里一次给齐；头名与取值是 host 侧写围栏认的
 * **接口契约**，两处各写一份必然漂移（改了一处忘另一处，请求就是 403）。
 *
 * @module dsh-harden/client-harden-api
 */

/** 写围栏要求的自定义头：它让请求变成非简单请求，跨站页面伪造不出来。 */
const MUTATION_HEADER = { 'x-dsh-harden': '1' }

/**
 * 取一份 JSON，`ok` 不为 true 就当失败抛出。
 *
 * @param url - 端点。
 * @param options - fetch 选项。
 */
export async function fetchJson(url: string, options?: RequestInit): Promise<Record<string, unknown>> {
    const response = await fetch(url, options)
    const data = await response.json()

    if (data?.ok !== true) {
        throw Error(typeof data?.error === 'string' ? data.error : `HTTP ${response.status}`)
    }

    return data
}

/**
 * 打一个写请求。写围栏要求自定义头与 JSON content-type，两者都在这里给齐。
 *
 * @param url - 端点。
 * @param body - 请求体对象。
 */
export async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
    return fetchJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...MUTATION_HEADER },
        body: JSON.stringify(body),
    })
}
