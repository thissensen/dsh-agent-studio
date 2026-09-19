/**
 * HTTP 请求围栏与响应工具：插件自建路由的安全边界。
 *
 * **围栏必须插件自己实现，框架不代劳。** 本插件的路由挂在用户本机的 DSH 服务上，
 * 守的是「谁能让这台机器改配置」这条线，所以它单独成模块：读端点与写端点、
 * 配置端点与预设端点，都从这一处取同一套判据，不各写一遍。
 *
 * 四条规则见 `validateRequestOrigin`；写操作在其之上再收紧一层，
 * 见 `validateMutationRequest`。
 *
 * @module dsh-agent-studio/http-guard
 */


import type { IncomingMessage, ServerResponse } from 'node:http'

/** 围栏的拒绝结果（通过时返回 null）。 */
interface GuardReject {
    statusCode: number
    error: string
}

/** 写操作必须携带的自定义请求头。它把请求变成「非简单请求」，浏览器会先发预检，跨站页面因此伪造不出来。 */
export const CLIENT_MARKER_HEADER = 'x-dsh-agent-studio'

/** 请求体上限，防止畸形请求把内存吃光。 */
const MAX_BODY_BYTES = 1 << 20

/**
 * 把 authority 字符串解析成 URL，失败返回 undefined。
 * @param authority - `host` 头或 trustedHosts 里的一项。
 */
function parseAuthority(authority: string): URL | undefined {
    try {
        return new URL(`http://${authority}`)
    } catch {
        return undefined
    }
}

/**
 * authority 的规范形式：有端口带端口，没端口只留主机名。
 *
 * 「有端口」的判据不能用 `url.port`——省略默认端口时它是空串，但 `https://` 的默认
 * 端口是 443 而 `http://` 是 80，所以这里借一次 https 解析把显式默认端口补出来。
 */
function canonicalAuthority(authority: string, parsed: URL): string {
    const port = parsed.port !== '' ? parsed.port : new URL(`https://${authority}`).port
    if (port === '') return parsed.hostname

    return `${parsed.hostname}:${port}`
}

/** `host` 头是否已经是规范形式（挡掉大小写、多余端口这类变体）。 */
function isCanonicalAuthority(authority: string, parsed: URL): boolean {
    return canonicalAuthority(authority, parsed) === authority.toLowerCase()
}

/** 主机名是否是回环地址：`localhost`、`[::1]` 或 `127.x.x.x`。 */
function isLoopbackHostname(hostname: string): boolean {
    if (hostname === 'localhost' || hostname === '[::1]') return true

    const parts = hostname.split('.')
    const isIpv4Shape = parts.length === 4 && parts[0] === '127'
    const isNumericOnly = parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)

    return isIpv4Shape && isNumericOnly
}

/** host 是否命中用户显式信任的 authority 清单。 */
function isTrustedAuthority(hostUrl: URL, trustedHosts: unknown[]): boolean {
    return trustedHosts.some((entry) => {
        if (typeof entry !== 'string') return false

        const entryUrl = parseAuthority(entry)
        if (entryUrl === undefined) return false
        if (!isCanonicalAuthority(entry, entryUrl)) return false

        // 信任项带了端口就按「主机:端口」比，没带端口时放宽到只比主机名
        const entryDeclaresPort = canonicalAuthority(entry, entryUrl) !== entryUrl.hostname
        if (entryDeclaresPort) return entryUrl.host === hostUrl.host

        return entryUrl.hostname === hostUrl.hostname
    })
}

/** 围栏的统一拒绝结果。 */
function forbiddenHost(): GuardReject {
    return { statusCode: 403, error: 'forbidden host' }
}

/**
 * 请求围栏。通过返回 null，否则返回 `{ statusCode, error }`。
 * @param req - Node 的请求对象。
 * @param trustedHosts - 用户显式信任的 authority 清单，通常来自 `webRuntime`。
 */
export function validateRequestOrigin(req: IncomingMessage, trustedHosts: unknown[]): GuardReject | null {
    const host = typeof req.headers.host === 'string' ? req.headers.host : ''
    const hostUrl = parseAuthority(host)
    if (hostUrl === undefined) return forbiddenHost()
    if (!isCanonicalAuthority(host, hostUrl)) return forbiddenHost()

    const isReachableHost = isLoopbackHostname(hostUrl.hostname) || isTrustedAuthority(hostUrl, trustedHosts)
    if (!isReachableHost) return forbiddenHost()

    // 跨站发起的请求一律拒绝，哪怕 host 头本身看着正常
    if (req.headers['sec-fetch-site'] === 'cross-site') return forbiddenHost()

    const origin = req.headers.origin
    if (typeof origin !== 'string') return null

    // origin 解析失败按不可信处理——拿不准就拒绝
    try {
        if (new URL(origin).host !== hostUrl.host) return forbiddenHost()
    } catch {
        return forbiddenHost()
    }

    return null
}

/**
 * 写操作的围栏：在读操作的全部规则之上，再要求自定义头与 JSON content-type。
 *
 * 自定义头是关键那一环——它让浏览器把这个请求当作「非简单请求」，先发预检；
 * 跨站页面做不出带自定义头的预检，所以伪造不出来。
 *
 * @param req - Node 的请求对象。
 * @param trustedHosts - 用户显式信任的 authority 清单。
 */
export function validateMutationRequest(req: IncomingMessage, trustedHosts: unknown[]): GuardReject | null {
    const hostError = validateRequestOrigin(req, trustedHosts)
    if (hostError !== null) return hostError

    if (req.headers[CLIENT_MARKER_HEADER] !== '1') {
        return { statusCode: 403, error: 'forbidden mutation request' }
    }

    const contentType = String(req.headers['content-type'] ?? '')
        .split(';', 1)[0]
        .trim()
        .toLowerCase()

    if (contentType !== 'application/json') {
        return { statusCode: 415, error: 'content-type must be application/json' }
    }

    return null
}

/** 浏览器可能在响应写回前就断开，没有监听者时 res 的 'error' 会变成未捕获异常。 */
function ignoreClientAbort(): void {}

/**
 * 回一个 JSON 响应。
 * @param res - Node 的响应对象。
 * @param statusCode - HTTP 状态码。
 * @param payload - 可 JSON 序列化的响应体。
 */
export function json(res: ServerResponse, statusCode: number, payload: unknown): void {
    if (res.writableEnded || res.destroyed) return

    res.once('error', ignoreClientAbort)

    const body = JSON.stringify(payload)
    try {
        res.writeHead(statusCode, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(body),
        })
        res.end(body)

    } catch {
        // 连接已断，写不回去是常态，不该把它升级成未捕获异常
    }
}

/**
 * 读请求体并解析成 JSON 对象。
 *
 * Node 的请求是事件流，这里是唯一一处回调适配；上层拿到的是 Promise。
 *
 * @param req - Node 的请求对象。
 */
export function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
        let size = 0
        let settled = false
        const chunks: Buffer[] = []

        const fail = (err: unknown) => {
            if (settled) return
            settled = true
            reject(err)
        }

        req.on('data', (chunk) => {
            if (settled) return

            size += chunk.length
            if (size > MAX_BODY_BYTES) {
                fail(Object.assign(Error('body too large'), { statusCode: 413 }))
                req.resume()
                return
            }

            chunks.push(chunk)
        })

        req.on('end', () => {
            if (settled) return

            try {
                const raw = Buffer.concat(chunks).toString('utf8')
                settled = true
                resolve(raw === '' ? {} : JSON.parse(raw))

            } catch (err) {
                fail(Object.assign(Error(`invalid JSON body: ${(err as Error).message}`), { statusCode: 400 }))
            }
        })

        req.on('error', fail)
    })
}
