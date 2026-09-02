"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const router = (0, express_1.Router)();
// Cloud Scheduler から10分おきに叩かれる想定。ユーザー認証(Supabase JWT)ではなく、
// Scheduler側でヘッダーに仕込む共有シークレットで検証する。
const SCHEDULER_SECRET = process.env.SCHEDULER_SECRET;
const TIME_ZONE = 'Asia/Tokyo';
const NEAR_MINUTES = 2; // Cloud Runのコールドスタート遅延を吸収するための許容幅
function isNear(value, mod, tolerance) {
    const remainder = value % mod;
    return Math.min(remainder, mod - remainder) <= tolerance;
}
function getJstParts(date) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: TIME_ZONE,
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
    }).formatToParts(date);
    return {
        hour: Number(parts.find(p => p.type === 'hour')?.value ?? '0') % 24,
        minute: Number(parts.find(p => p.type === 'minute')?.value ?? '0'),
    };
}
async function runHourlyTasks() {
    // TODO: 1時間ごとにやりたい処理をここに実装する
}
async function runDailyTasks() {
    // TODO: 1日ごとにやりたい処理をここに実装する
}
router.post('/api/maintenance/tick', async (req, res) => {
    if (!SCHEDULER_SECRET || req.get('X-Scheduler-Secret') !== SCHEDULER_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const { hour, minute } = getJstParts(new Date());
    const isTopOfHour = isNear(minute, 60, NEAR_MINUTES);
    const isMidnight = isTopOfHour && isNear(hour * 60 + minute, 24 * 60, NEAR_MINUTES);
    try {
        if (isMidnight) {
            await runDailyTasks();
            return res.status(200).json({ ran: 'daily' });
        }
        if (isTopOfHour) {
            await runHourlyTasks();
            return res.status(200).json({ ran: 'hourly' });
        }
        return res.status(200).json({ ran: 'health' });
    }
    catch (error) {
        console.error('[Maintenance] tick failed:', error);
        res.status(500).json({ error: error.message });
    }
});
exports.default = router;
