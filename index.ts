import { HomeHandler } from 'hydrooj/src/handler/home';

let cachedAtCoderData = [];
let syncTimer: NodeJS.Timeout | null = null;

// ==========================================
// 1. 核心抓取逻辑 (仅同步 AtCoder 比赛列表)
// ==========================================
async function syncAtCoderContests() {
    try {
        const response = await fetch('https://atcoder.jp/');
        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);

        const html = await response.text();
        const upcomingStart = html.indexOf('id="contest-table-upcoming"');
        if (upcomingStart === -1) {
            return;
        }

        const tbodyMatch = html.substring(upcomingStart).match(/<tbody>([\s\S]*?)<\/tbody>/);
        if (!tbodyMatch) {
            return;
        }

        const rows = tbodyMatch[1].split('<tr');
        const atCoderList = [];

        for (const row of rows) {
            if (!row.includes('Beginner')) continue;

            try {
                const titleMatch = row.match(/href="\/contests\/([^"]+)">([^<]+)<\/a>/);
                if (!titleMatch) continue;

                const contestSlug = titleMatch[1];
                const rawTitle = titleMatch[2];

                if (typeof rawTitle !== 'string') continue; 

                // --- 标题处理逻辑 ---
                // 优先匹配 "Contest <数字>" 模式
                let numMatch = rawTitle.match(/Contest\s+(\d+)/i);
                // 如果没匹配到，回退到匹配任意数字
                if (!numMatch) {
                    numMatch = rawTitle.match(/(\d+)/);
                }
                if (!numMatch) continue;

                // 构建标准化的显示名称 "ABC <数字>"
                const displayName = `ABC ${numMatch[1]}`;
                const originalUrl = `https://atcoder.jp/contests/${contestSlug}`;
                // --- 结束 ---

                const timeMatch = row.match(/<time[^>]+>([^<]+)<\/time>/);
                if (!timeMatch) continue;

                let rawTime = timeMatch[1].trim().replace(/\s+/g, ' ');
                rawTime = rawTime.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
                rawTime = rawTime.replace(' ', 'T');

                const startTime = new Date(rawTime);
                if (isNaN(startTime.getTime())) continue;

                const now = new Date();
                const diffMs = startTime.getTime() - now.getTime();
                const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

                if (diffDays >= 0 && diffDays <= 30) {
                    atCoderList.push({
                        name: displayName,
                        diff: diffDays,
                        url: originalUrl,
                        isExternal: true
                    });
                }

            } catch (e) {
                console.error(`[AtCoderSync] 解析行失败: ${e.message}`);
            }
        }

        atCoderList.sort((a, b) => a.diff - b.diff);
        cachedAtCoderData = atCoderList;
    } catch (err) {
        console.error(`[AtCoderSync] 同步过程发生严重错误: ${err}`);
    }
}

// ==========================================
// 2. 定时器控制逻辑 (按需启停)
// ==========================================
function startSyncScheduler() {
    if (syncTimer) return;

    console.log('[AtCoderSync] 检测到 source 配置，启动定时同步任务...');
    syncAtCoderContests();

    // 每日 0 点执行
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    const msUntilMidnight = tomorrow.getTime() - now.getTime();

    syncTimer = setTimeout(() => {
        syncAtCoderContests();
        // 之后每 24 小时执行一次
        syncTimer = setInterval(syncAtCoderContests, 24 * 60 * 60 * 1000);
    }, msUntilMidnight);
}

function stopSyncScheduler() {
    if (syncTimer) {
        console.log('[AtCoderSync] 未检测到 source 配置，停止定时同步任务并清空缓存...');
        clearTimeout(syncTimer);
        clearInterval(syncTimer);
        syncTimer = null;
        cachedAtCoderData = []; // 清空缓存，确保前端不再显示 ABC 比赛
    }
}

// ==========================================
// 3. 首页倒计时接口适配 (核心修改部分)
// ==========================================
HomeHandler.prototype.getCountdown = async (domainId, payload) => {
    // 【核心逻辑】根据是否配置了 atcoder 来决定是否抓取
    const hasSource = payload['atcoder'];

    if (hasSource === true) {
        startSyncScheduler();
    } else {
        stopSyncScheduler();
    }

    // 获取原本应该显示的本地数据
    let localDates = [];
    const localPayload = JSON.parse(JSON.stringify(payload));
    const result = await getLocalCountdown(localPayload); 
    localDates = result.dates || [];

    // 为本地数据自动匹配跳转链接
    localDates = localDates.map(item => {
        if (item.url) return item;

        const name = item.name || '';
        if (name.includes('GESP')) {
            item.url = 'https://gesp.ccf.org.cn/';
        } else if (name.includes('电子学会') || name.includes('CIE')) {
            item.url = 'https://qceit.org.cn/bos/default.html';
        } else if (name.includes('CSP') || name.includes('NOI')) {
            item.url = 'https://cspsjtest.noi.cn';
        }
        return item;
    });

    // 准备 AtCoder 数据 (深拷贝防止污染缓存)
    // 如果未配置 atcoder，cachedAtCoderData 会被清空，这里自然就是空数组
    const atCoderDates = JSON.parse(JSON.stringify(cachedAtCoderData));

    let mergedDates = [...localDates, ...atCoderDates];
    mergedDates.sort((a, b) => a.diff - b.diff);
    const limit = payload['limit'] || 5; 
    mergedDates = mergedDates.slice(0, limit);

    payload.dates = mergedDates;
    return payload;
};

async function getLocalCountdown(payload) {
    const content = [];
    const dateToday = new Date();
    dateToday.setHours(0, 0, 0, 0);
    
    if (!Array.isArray(payload.dates)) return payload;

    for (const val of payload.dates) {
        const targetDate = new Date(val.date);
        targetDate.setHours(0, 0, 0, 0);
        
        if (targetDate >= dateToday) {
            const diffTime = Math.floor((targetDate - dateToday) / 86400000);
            content.push({ 
                name: val.name, 
                diff: diffTime,
                url: val.url || '' 
            });
        }
    }
    payload.dates = content;
    return payload;
}