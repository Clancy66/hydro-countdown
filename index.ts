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
        if (upcomingStart === -1) return;

        const tbodyMatch = html.substring(upcomingStart).match(/<tbody>([\s\S]*?)<\/tbody>/);
        if (!tbodyMatch) return;

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

                let numMatch = rawTitle.match(/Contest\s+(\d+)/i);
                if (!numMatch) {
                    numMatch = rawTitle.match(/(\d+)/);
                }
                if (!numMatch) continue;

                // 构建标准化的显示名称 "ABC <数字>"
                const displayName = `ABC ${numMatch[1]}`;
                const originalUrl = `https://atcoder.jp/contests/${contestSlug}`;

                const timeMatch = row.match(/<time[^>]+>([^<]+)<\/time>/);
                if (!timeMatch) continue;

                let rawTime = timeMatch[1].trim();
                rawTime = rawTime.replace(' ', 'T');
                rawTime = rawTime.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');

                const startTime = new Date(rawTime);
                if (isNaN(startTime.getTime())) {
                    console.warn(`[AtCoderSync] 无法解析的时间格式: ${rawTime}`);
                    continue;
                }

                const now = new Date();
                const diffMs = startTime.getTime() - now.getTime();
                const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

                if (diffDays >= 0 && diffDays <= 30) {
                    atCoderList.push({
                        name: displayName,
                        diff: diffMs,
                        startTime: startTime.getTime(),
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

    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
    const msUntilMidnight = tomorrow.getTime() - now.getTime();

    syncTimer = setTimeout(() => {
        syncAtCoderContests();
        syncTimer = setInterval(syncAtCoderContests, 24 * 60 * 60 * 1000);
    }, msUntilMidnight);
}

function stopSyncScheduler() {
    if (syncTimer) {
        console.log('[AtCoderSync] 未检测到 source 配置，停止定时同步任务并清空缓存...');
        clearTimeout(syncTimer);
        clearInterval(syncTimer);
        syncTimer = null;
        cachedAtCoderData = []; 
    }
}

// ==========================================
// 3. 首页倒计时接口适配
// ==========================================
HomeHandler.prototype.getCountdown = async (domainId, payload) => {
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
            item.url = 'https://gesp.ccf.org.cn';
        } else if (name.includes('电子学会') || name.includes('CIE')) {
            item.url = 'https://qceit.org.cn';
        } else if (name.includes('CSP') || name.includes('NOI')) {
            item.url = 'https://noi.cn';
        } else if (name.includes('蓝桥')) {
            item.url = 'https://www.lanqiaoqingshao.cn';
        } else if (name.includes('天梯')) {
            item.url = 'https://gplt.patest.cn';
        }
        return item;
    });

    // 准备 AtCoder 数据 (深拷贝防止污染缓存)
    const atCoderDates = JSON.parse(JSON.stringify(cachedAtCoderData));

    let mergedDates = [...localDates, ...atCoderDates];
    mergedDates.sort((a, b) => a.diff - b.diff);

    // 处理小于 1 天的倒计时，展示为小时增强紧迫感
    const now = Date.now();
    mergedDates = mergedDates.map(item => {
        // 如果存在精确时间戳，则重新计算
        if (item.startTime) {
            const diffMs = item.startTime - now;
            const diffMins = Math.floor(diffMs / (1000 * 60));
            const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
            const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            
            // 如果距离开始不足 24 小时，将 diff 替换为带 “小时” 的字符串
            if (diffDays > 0) {
                item.diff = `${diffDays} 天`;
            } else if (diffHours > 0) {
                item.diff = `${diffHours} 小时`;
            }
            else if (diffMins > 0) {
                item.diff = `${diffMins} 分钟`;
            }
            else if (diffMs <= 0) {
                item.remove = true; // 标记已过期的比赛，稍后过滤掉
            }
        }
        else {
            item.diff = `${ Math.floor(item.diff / (1000 * 60 * 60 * 24))} 天`;
        }
        return item;
    });

    // 过滤掉已过期的比赛
    mergedDates = mergedDates.filter(item => !item.remove);

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
        let targetDate: Date;

        const isoDateStr = String(val.date).replace(' ', 'T');
        targetDate = new Date(isoDateStr);

        // 如果解析失败，跳过该条数据，防止整个倒计时模块崩溃
        if (isNaN(targetDate.getTime())) {
            console.warn(`[LocalCountdown] 无法解析的时间格式: ${val.date}`);
            continue;
        }
        
        if (targetDate.getTime() >= dateToday.getTime()) {
            content.push({ 
                name: val.name, 
                diff: targetDate.getTime() - dateToday.getTime(),
                startTime: targetDate.getTime(), // 保留精确到分钟的时间戳，用于计算 “小时级” 倒计时
                url: val.url || '' 
            });
        }
    }
    payload.dates = content;
    return payload;
}