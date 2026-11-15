/*
 * PingMe 自动签到 + 视频奖励 —— Shadowrocket（小火箭）cron 脚本
 * ---------------------------------------------------------------------
 * 原脚本：ZenmoFeiShi（怎么肥事）/ fmz200（奶思）Env 通用版
 * 本版：去掉 Env 兼容层，只用小火箭原生 $ 接口，直接跑在 cron 任务里
 * 依赖：先由 PingMeCaptureSR.js 抓到参数（存储键 pingme_capture_v3）
 * 流程：查余额 → 签到 → 看 5 次视频 → 再查余额 → 一条通知汇总
 * 结束：无论成功失败都会调用 $done()，避免任务挂住
 */

const NAME = 'PingMe签到';
const CK_KEY = 'pingme_capture_v3';
const SECRET = '0fOiukQq7jXZV2GRi9LGlO';
const MAX_VIDEO = 5;
const VIDEO_DELAY = 8000;   // 每个视频间隔 8 秒
const FIRST_DELAY = 1500;   // 第一个视频前等待 1.5 秒
const REQ_TIMEOUT = 20000;  // 单请求超时
const ICON = 'https://raw.githubusercontent.com/fmz200/wool_scripts/main/icons/apps/PingMe.png';

/* ================= 小火箭环境封装 ================= */

function log() {
    const parts = [];
    for (let i = 0; i < arguments.length; i++) {
        const a = arguments[i];
        parts.push(a && typeof a === 'object' ? safeStringify(a) : String(a));
    }
    console.log('[PingMe] ' + parts.join(' '));
}

function safeStringify(o) {
    try { return JSON.stringify(o); } catch (e) { return String(o); }
}

function storeRead(key) {
    try {
        const v = $persistentStore.read(key);
        return (v === null || v === undefined) ? '' : String(v);
    } catch (e) { return ''; }
}

function storeWrite(value, key) {
    try { return $persistentStore.write(String(value), key); } catch (e) { return false; }
}

function notify(title, body) {
    try {
        $notification.post(title, '', body || '', { 'media-url': ICON });
    } catch (e) {
        try { $notification.post(title, '', body || ''); } catch (e2) { log('通知失败'); }
    }
}

function delay(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
}

function finish() {
    try { $done(); } catch (e) { log('$done 调用异常: ' + e); }
}

function errText(e) {
    if (!e) return '未知错误';
    if (typeof e === 'string') return e;
    return e.message || e.error || safeStringify(e);
}

// 小火箭 $httpClient 包一层 Promise
function httpGet(url, headers) {
    return new Promise(function (resolve, reject) {
        let settled = false;
        const timer = setTimeout(function () {
            if (settled) return;
            settled = true;
            reject(new Error('请求超时'));
        }, REQ_TIMEOUT + 5000);

        $httpClient.get({ url: url, headers: headers, timeout: REQ_TIMEOUT }, function (err, resp, body) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (err) {
                reject(new Error(typeof err === 'string' ? err : (err.error || safeStringify(err))));
                return;
            }
            const status = resp && (resp.status || resp.statusCode);
            resolve({ status: status, body: (body === null || body === undefined) ? '' : String(body) });
        });
    });
}

/* ================= 签名与请求构造（与原版逻辑一致） ================= */

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function getUTCSignDate() {
    const d = new Date();
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) +
        ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
}

function buildSignedParams(capture) {
    const params = {};
    const raw = capture.paramsRaw || {};
    Object.keys(raw).forEach(function (k) {
        if (k === 'sign' || k === 'signDate') return;
        params[k] = raw[k];
    });
    params.signDate = getUTCSignDate();
    const signBase = Object.keys(params).sort().map(function (k) {
        return k + '=' + params[k];
    }).join('&');
    params.sign = MD5(signBase + SECRET);
    return params;
}

function buildUrl(path, capture) {
    const params = buildSignedParams(capture);
    const qs = Object.keys(params).map(function (k) {
        return k + '=' + encodeURIComponent(params[k]);
    }).join('&');
    return 'https://api.pingmeapp.net/app/' + path + '?' + qs;
}

function hasHeader(obj, lowerName) {
    return Object.keys(obj).some(function (k) { return k.toLowerCase() === lowerName; });
}

function buildHeaders(capture) {
    const src = capture.headers || {};
    const out = {};
    const drop = ['content-length', 'content-type', 'host', 'accept-encoding',
        ':authority', ':method', ':path', ':scheme'];

    Object.keys(src).forEach(function (k) {
        if (drop.indexOf(k.toLowerCase()) !== -1) return;
        out[k] = src[k];
    });

    out['Host'] = 'api.pingmeapp.net';
    if (!hasHeader(out, 'accept')) out['Accept'] = 'application/json';
    return out;
}

/* ================= 主流程 ================= */

async function main() {
    const raw = storeRead(CK_KEY);
    if (!raw) {
        log('未找到签到参数');
        notify('❌ 请先获取PingMe签到参数', '先打开 PingMe App 触发一次抓参');
        return;
    }

    let capture;
    try {
        capture = JSON.parse(raw);
    } catch (e) {
        log('参数解析失败: ' + e);
        notify('❌ PingMe签到参数损坏', '可打开 PingMe App 再触发一次抓参');
        return;
    }
    if (!capture || !capture.paramsRaw || !Object.keys(capture.paramsRaw).length) {
        log('参数为空');
        notify('❌ PingMe签到参数为空', '可打开 PingMe App 再触发一次抓参');
        return;
    }

    log('组装请求头，开始运行签到');
    const headers = buildHeaders(capture);
    const msgs = [];

    function api(path) {
        const url = buildUrl(path, capture);
        log('请求: ' + path);
        return httpGet(url, headers).then(function (res) {
            return JSON.parse(res.body);
        });
    }

    /* 1. 运行前余额 */
    try {
        const d = await api('queryBalanceAndBonus');
        if (d.retcode === 0) msgs.push('💰 运行前余额：' + ((d.result && d.result.balance) || '?') + ' Coins');
        else msgs.push('⚠️ 查询：' + (d.retmsg || d.retcode));
    } catch (e) {
        msgs.push('❌ 查询：' + (e instanceof SyntaxError ? '解析失败' : errText(e)));
    }

    /* 2. 签到 */
    try {
        const d = await api('checkIn');
        if (d.retcode === 0) {
            const hint = (d.result && d.result.bonusHint) || d.retmsg || '';
            msgs.push('✅ 签到：' + String(hint).replace(/\n/g, ' '));
        } else {
            msgs.push('⚠️ 签到：' + (d.retmsg || d.retcode));
        }
    } catch (e) {
        msgs.push('❌ 签到：' + (e instanceof SyntaxError ? '解析失败' : errText(e)));
    }

    /* 3. 视频奖励 */
    for (let i = 1; i <= MAX_VIDEO; i++) {
        await delay(i === 1 ? FIRST_DELAY : VIDEO_DELAY);
        try {
            const d = await api('videoBonus');
            if (d.retcode === 0) {
                msgs.push('🎬 视频' + i + '：+' + ((d.result && d.result.bonus) || '?') + ' Coins');
            } else {
                msgs.push('⏸ 视频' + i + '：' + (d.retmsg || d.retcode));
                break;
            }
        } catch (e) {
            msgs.push('❌ 视频' + i + '：' + (e instanceof SyntaxError ? '解析失败' : errText(e)));
            break;
        }
    }

    /* 4. 最新余额 */
    try {
        const d = await api('queryBalanceAndBonus');
        if (d.retcode === 0) msgs.unshift('💰 最新余额：' + ((d.result && d.result.balance) || '?') + ' Coins');
    } catch (e) {
        log('查询最新余额失败: ' + errText(e));
    }

    log('任务完成');
    notify(NAME + '🎉 任务完成', msgs.join('\n'));
}

main()
    .then(finish)
    .catch(function (e) {
        log('任务失败: ' + errText(e));
        notify(NAME + '❌ 任务失败', errText(e));
        finish();
    });

/* ================= MD5（标准实现，保持与原脚本一致） ================= */

function MD5(string) {
    function RotateLeft(lValue, iShiftBits) { return (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits)); }
    function AddUnsigned(lX, lY) {
        const lX4 = lX & 0x40000000, lY4 = lY & 0x40000000, lX8 = lX & 0x80000000, lY8 = lY & 0x80000000;
        const lResult = (lX & 0x3FFFFFFF) + (lY & 0x3FFFFFFF);
        if (lX4 & lY4) return lResult ^ 0x80000000 ^ lX8 ^ lY8;
        if (lX4 | lY4) return (lResult & 0x40000000) ? (lResult ^ 0xC0000000 ^ lX8 ^ lY8) : (lResult ^ 0x40000000 ^ lX8 ^ lY8);
        return lResult ^ lX8 ^ lY8;
    }
    function F(x, y, z) { return (x & y) | ((~x) & z); }
    function G(x, y, z) { return (x & z) | (y & (~z)); }
    function H(x, y, z) { return x ^ y ^ z; }
    function I(x, y, z) { return y ^ (x | (~z)); }
    function FF(a, b, c, d, x, s, ac) { a = AddUnsigned(a, AddUnsigned(AddUnsigned(F(b, c, d), x), ac)); return AddUnsigned(RotateLeft(a, s), b); }
    function GG(a, b, c, d, x, s, ac) { a = AddUnsigned(a, AddUnsigned(AddUnsigned(G(b, c, d), x), ac)); return AddUnsigned(RotateLeft(a, s), b); }
    function HH(a, b, c, d, x, s, ac) { a = AddUnsigned(a, AddUnsigned(AddUnsigned(H(b, c, d), x), ac)); return AddUnsigned(RotateLeft(a, s), b); }
    function II(a, b, c, d, x, s, ac) { a = AddUnsigned(a, AddUnsigned(AddUnsigned(I(b, c, d), x), ac)); return AddUnsigned(RotateLeft(a, s), b); }
    function ConvertToWordArray(str) {
        const lMessageLength = str.length;
        const lNumberOfWords_temp1 = lMessageLength + 8;
        const lNumberOfWords_temp2 = (lNumberOfWords_temp1 - (lNumberOfWords_temp1 % 64)) / 64;
        const lNumberOfWords = (lNumberOfWords_temp2 + 1) * 16;
        const lWordArray = Array(lNumberOfWords - 1).fill(0);
        let lBytePosition = 0, lByteCount = 0;
        while (lByteCount < lMessageLength) {
            const lWordCount = (lByteCount - (lByteCount % 4)) / 4;
            lBytePosition = (lByteCount % 4) * 8;
            lWordArray[lWordCount] |= str.charCodeAt(lByteCount) << lBytePosition;
            lByteCount++;
        }
        const lWordCount = (lByteCount - (lByteCount % 4)) / 4;
        lBytePosition = (lByteCount % 4) * 8;
        lWordArray[lWordCount] |= 0x80 << lBytePosition;
        lWordArray[lNumberOfWords - 2] = lMessageLength << 3;
        lWordArray[lNumberOfWords - 1] = lMessageLength >>> 29;
        return lWordArray;
    }
    function WordToHex(lValue) {
        let WordToHexValue = '';
        for (let lCount = 0; lCount <= 3; lCount++) {
            const lByte = (lValue >>> (lCount * 8)) & 255;
            const WordToHexValue_temp = '0' + lByte.toString(16);
            WordToHexValue += WordToHexValue_temp.substr(WordToHexValue_temp.length - 2, 2);
        }
        return WordToHexValue;
    }
    const x = ConvertToWordArray(string);
    let a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476;
    const S11 = 7, S12 = 12, S13 = 17, S14 = 22, S21 = 5, S22 = 9, S23 = 14, S24 = 20;
    const S31 = 4, S32 = 11, S33 = 16, S34 = 23, S41 = 6, S42 = 10, S43 = 15, S44 = 21;
    for (let k = 0; k < x.length; k += 16) {
        const AA = a, BB = b, CC = c, DD = d;
        a = FF(a,b,c,d,x[k+0],S11,0xD76AA478); d = FF(d,a,b,c,x[k+1],S12,0xE8C7B756); c = FF(c,d,a,b,x[k+2],S13,0x242070DB); b = FF(b,c,d,a,x[k+3],S14,0xC1BDCEEE);
        a = FF(a,b,c,d,x[k+4],S11,0xF57C0FAF); d = FF(d,a,b,c,x[k+5],S12,0x4787C62A); c = FF(c,d,a,b,x[k+6],S13,0xA8304613); b = FF(b,c,d,a,x[k+7],S14,0xFD469501);
        a = FF(a,b,c,d,x[k+8],S11,0x698098D8); d = FF(d,a,b,c,x[k+9],S12,0x8B44F7AF); c = FF(c,d,a,b,x[k+10],S13,0xFFFF5BB1); b = FF(b,c,d,a,x[k+11],S14,0x895CD7BE);
        a = FF(a,b,c,d,x[k+12],S11,0x6B901122); d = FF(d,a,b,c,x[k+13],S12,0xFD987193); c = FF(c,d,a,b,x[k+14],S13,0xA679438E); b = FF(b,c,d,a,x[k+15],S14,0x49B40821);
        a = GG(a,b,c,d,x[k+1],S21,0xF61E2562); d = GG(d,a,b,c,x[k+6],S22,0xC040B340); c = GG(c,d,a,b,x[k+11],S23,0x265E5A51); b = GG(b,c,d,a,x[k+0],S24,0xE9B6C7AA);
        a = GG(a,b,c,d,x[k+5],S21,0xD62F105D); d = GG(d,a,b,c,x[k+10],S22,0x02441453); c = GG(c,d,a,b,x[k+15],S23,0xD8A1E681); b = GG(b,c,d,a,x[k+4],S24,0xE7D3FBC8);
        a = GG(a,b,c,d,x[k+9],S21,0x21E1CDE6); d = GG(d,a,b,c,x[k+14],S22,0xC33707D6); c = GG(c,d,a,b,x[k+3],S23,0xF4D50D87); b = GG(b,c,d,a,x[k+8],S24,0x455A14ED);
        a = GG(a,b,c,d,x[k+13],S21,0xA9E3E905); d = GG(d,a,b,c,x[k+2],S22,0xFCEFA3F8); c = GG(c,d,a,b,x[k+7],S23,0x676F02D9); b = GG(b,c,d,a,x[k+12],S24,0x8D2A4C8A);
        a = HH(a,b,c,d,x[k+5],S31,0xFFFA3942); d = HH(d,a,b,c,x[k+8],S32,0x8771F681); c = HH(c,d,a,b,x[k+11],S33,0x6D9D6122); b = HH(b,c,d,a,x[k+14],S34,0xFDE5380C);
        a = HH(a,b,c,d,x[k+1],S31,0xA4BEEA44); d = HH(d,a,b,c,x[k+4],S32,0x4BDECFA9); c = HH(c,d,a,b,x[k+7],S33,0xF6BB4B60); b = HH(b,c,d,a,x[k+10],S34,0xBEBFBC70);
        a = HH(a,b,c,d,x[k+13],S31,0x289B7EC6); d = HH(d,a,b,c,x[k+0],S32,0xEAA127FA); c = HH(c,d,a,b,x[k+3],S33,0xD4EF3085); b = HH(b,c,d,a,x[k+6],S34,0x04881D05);
        a = HH(a,b,c,d,x[k+9],S31,0xD9D4D039); d = HH(d,a,b,c,x[k+12],S32,0xE6DB99E5); c = HH(c,d,a,b,x[k+15],S33,0x1FA27CF8); b = HH(b,c,d,a,x[k+2],S34,0xC4AC5665);
        a = II(a,b,c,d,x[k+0],S41,0xF4292244); d = II(d,a,b,c,x[k+7],S42,0x432AFF97); c = II(c,d,a,b,x[k+14],S43,0xAB9423A7); b = II(b,c,d,a,x[k+5],S44,0xFC93A039);
        a = II(a,b,c,d,x[k+12],S41,0x655B59C3); d = II(d,a,b,c,x[k+3],S42,0x8F0CCC92); c = II(c,d,a,b,x[k+10],S43,0xFFEFF47D); b = II(b,c,d,a,x[k+1],S44,0x85845DD1);
        a = II(a,b,c,d,x[k+8],S41,0x6FA87E4F); d = II(d,a,b,c,x[k+15],S42,0xFE2CE6E0); c = II(c,d,a,b,x[k+6],S43,0xA3014314); b = II(b,c,d,a,x[k+13],S44,0x4E0811A1);
        a = II(a,b,c,d,x[k+4],S41,0xF7537E82); d = II(d,a,b,c,x[k+11],S42,0xBD3AF235); c = II(c,d,a,b,x[k+2],S43,0x2AD7D2BB); b = II(b,c,d,a,x[k+9],S44,0xEB86D391);
        a = AddUnsigned(a,AA); b = AddUnsigned(b,BB); c = AddUnsigned(c,CC); d = AddUnsigned(d,DD);
    }
    return (WordToHex(a) + WordToHex(b) + WordToHex(c) + WordToHex(d)).toLowerCase();
}
