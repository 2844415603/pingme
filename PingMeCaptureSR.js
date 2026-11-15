/*
 * PingMe 抓参 —— Shadowrocket（小火箭）http-request 脚本
 * ---------------------------------------------------------------
 * 作用：拦截 GET https://api.pingmeapp.net/app/queryBalanceAndBonus
 *      把 URL 里的签名参数 + 请求头存进本地，供定时签到脚本复用。
 * 存储键：pingme_capture_v3（与 PingMeSigninSR.js 一致，别改）
 * 触发：打开 PingMe App 首页/我的，让它刷一次余额即完成抓参
 * 开关：$argument.PINGME_CAPTURE = false 时停止抓参（模块参数没生效则默认开启）
 * 调用：$done({}) 表示不改写请求，原样放行
 */

const CK_KEY = 'pingme_capture_v3';

(function () {
    /* ---------- 抓参开关 ---------- */
    // $argument 在小火箭里可能是对象（argument=a=b 解析后），也可能是原始字符串，两种都认
    let enable = 'true';
    try {
        if (typeof $argument !== 'undefined' && $argument) {
            let v;
            if (typeof $argument === 'string') {
                const m = $argument.match(/(?:^|[&,\s])PINGME_CAPTURE\s*=\s*([^&,\s]+)/i);
                if (m) v = m[1];
            } else if ($argument.PINGME_CAPTURE !== undefined && $argument.PINGME_CAPTURE !== null) {
                v = $argument.PINGME_CAPTURE;
            }
            if (v !== undefined) {
                v = String(v).trim().replace(/^["']|["']$/g, '');
                if (v !== '') enable = v;
            }
        }
    } catch (e) { /* 老版本无 $argument，按默认开启处理 */ }

    if (enable.toLowerCase() === 'false') {
        console.log('[PingMe] 抓参已关闭，跳过');
        $done({});
        return;
    }

    /* ---------- 只处理余额查询接口 ---------- */
    const url = ($request && $request.url) ? String($request.url) : '';
    if (url.indexOf('/app/queryBalanceAndBonus') === -1) {
        $done({});
        return;
    }

    const headers = ($request && $request.headers) ? $request.headers : {};

    const capture = {
        url: url,
        paramsRaw: parseRawQuery(url),
        headers: normalizeHeaderNameMap(headers)
    };

    try {
        $persistentStore.write(JSON.stringify(capture), CK_KEY);
        console.log('[PingMe] 抓参成功: ' + url);
        $notification.post('✅ PingMe 获取成功', '', '参数已保存，现在可以关闭抓参了');
    } catch (e) {
        console.log('[PingMe] 抓参保存失败: ' + e);
        $notification.post('❌ PingMe 抓参失败', '', String(e));
    }

    $done({});
})();

/* ---------- 工具 ---------- */

// 解析 query，值里带 = 也不会被截断
function parseRawQuery(url) {
    const idx = url.indexOf('?');
    if (idx === -1) return {};
    const qs = url.substring(idx + 1).split('#')[0];
    const params = {};
    qs.split('&').forEach(function (pair) {
        if (!pair) return;
        const eq = pair.indexOf('=');
        const k = eq < 0 ? pair : pair.substring(0, eq);
        const v = eq < 0 ? '' : pair.substring(eq + 1);
        if (!k) return;
        params[safeDecode(k)] = safeDecode(v);
    });
    return params;
}

function safeDecode(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
}

// 头名统一小写，方便签到脚本读取
function normalizeHeaderNameMap(headers) {
    const out = {};
    Object.keys(headers || {}).forEach(function (k) {
        out[k.toLowerCase()] = headers[k];
    });
    return out;
}
