/**
 * 模型目录：面板里选子代理模型时的三级联动下拉靠它。
 *
 * 为什么要有这一层：条目里的「模型」是 provider / model / 推理档位三个值，而档位集合
 * **随模型变**（不同模型的档位不同，写死一张表必然错），所以不能在前端硬编码，只能
 * 现问宿主的 `llm` 服务。
 *
 * 拆成两个端点而不是一次拉全：provider 与模型清单便宜（一次调用一层），而档位要
 * 逐个模型解析（`resolveModelInfo`），几十个模型挨个解析等于把面板打开拖慢几十倍。
 * 于是清单一次给全，档位在真的选中某个模型时再取。
 *
 * @module dsh-agent-studio/models
 */
import { json } from './http-guard.js';
/**
 * 读端点：列出 provider，以及各自的模型。
 * @param res - Node 的响应对象。
 * @param deps - `{ getLlm }`；`getLlm()` 在服务未就绪时返回 undefined。
 */
export async function handleListModels(res, deps) {
    const llm = deps.getLlm();
    if (llm?.listProviders === undefined || llm?.listModels === undefined) {
        json(res, 200, { ok: true, providers: [], warnings: [] });
        return;
    }
    // provider 通常只有个位数，串行取更省事也更好读；真多到需要并发再说。
    const providers = [];
    const warnings = [];
    for (const provider of llm.listProviders()) {
        // 一家读不出来不该让整份清单空掉——那会连带把面板上所有模型选择都废掉，
        // 而实际只有一家不灵。跳过它、把原因带回面板，用户至少知道少的是哪个。
        // 会走到这里是有真实场景的：listModels 要按 provider 解析凭证与模型目录。
        try {
            const models = await llm.listModels(provider.id);
            providers.push({
                id: provider.id,
                name: provider.name,
                models: models.map((model) => ({ id: model.id, name: model.name })),
            });
        }
        catch (err) {
            warnings.push(`${provider.id}（${err?.message ?? String(err)}）`);
        }
    }
    json(res, 200, { ok: true, providers, warnings });
}
/**
 * 读端点：读某个具体模型的推理档位。
 * @param req - Node 的请求对象（`provider` 与 `model` 从查询串取）。
 * @param res - Node 的响应对象。
 * @param deps - `{ getLlm }`。
 */
export async function handleListEfforts(req, res, deps) {
    const llm = deps.getLlm();
    if (llm?.resolveModelInfo === undefined) {
        json(res, 200, { ok: true, efforts: [], defaultEffort: null });
        return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const provider = url.searchParams.get('provider') ?? '';
    const model = url.searchParams.get('model') ?? '';
    if (provider === '' || model === '') {
        json(res, 400, { ok: false, error: '需要 provider 与 model 两个查询参数' });
        return;
    }
    // 模型 id 写错、provider 不认识，都是「请求本身的问题」，回 4xx 让面板显示原因
    try {
        const info = await llm.resolveModelInfo(provider, model);
        const efforts = (info?.reasoning?.efforts ?? []).map((effort) => ({
            id: effort.id,
            name: effort.name,
        }));
        json(res, 200, { ok: true, efforts, defaultEffort: info?.reasoning?.defaultEffort ?? null });
    }
    catch (err) {
        json(res, 400, { ok: false, error: `解析模型档位失败：${err?.message ?? String(err)}` });
    }
}
