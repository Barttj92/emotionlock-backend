// One-off check: recompute a day's realized net P&L straight from MetaAPI,
// independent of lossLimit.js, to compare with daily_net_pnl in Supabase.
// Usage: METAAPI_TOKEN=... node scripts/verify-pnl.js
// Prints numbers only; never prints the token.
'use strict';
const TOKEN = process.env.METAAPI_TOKEN;
if (!TOKEN) { console.error('Set METAAPI_TOKEN first.'); process.exit(1); }

const CHECKS = [
    { user: 'd96e0de1', account: '8fd40f37-0adf-4fc9-b558-0721d6cb93ae', date: '2026-09-30', stored: -142.94 },
    { user: '796844bc', account: '3ad64431-660c-403f-a086-391bdce4bb4e', date: '2026-09-30', stored: -0.90 },
    { user: '11f6ba73', account: 'a39139b7-253d-4586-8f47-06978c97108a', date: '2026-10-01', stored: 1160.00 },
];
const REGION = 'london';

// Midnight Europe/Amsterdam for a YYYY-MM-DD date, as a UTC Date.
function amsMidnight(dateStr) {
    const noon = new Date(dateStr + 'T12:00:00Z');
    const h = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hour12: false }).format(noon), 10);
    return new Date(Date.parse(dateStr + 'T00:00:00Z') - (h - 12) * 3600e3);
}

(async () => {
    for (const c of CHECKS) {
        const from = amsMidnight(c.date);
        const next = new Date(from.getTime() + 36 * 3600e3).toISOString().slice(0, 10);
        const to = new Date(Math.min(amsMidnight(next).getTime(), Date.now()));
        const url = `https://mt-client-api-v1.${REGION}.agiliumtrade.ai/users/current/accounts/${c.account}/history-deals/time/${from.toISOString()}/${to.toISOString()}`;
        const res = await fetch(url, { headers: { 'auth-token': TOKEN } });
        if (!res.ok) { console.log(`${c.user} ${c.date}: HTTP ${res.status} (account not reachable right now)`); continue; }
        const deals = await res.json();
        const sum = { profit: 0, commission: 0, swap: 0, fee: 0 };
        let tradeDeals = 0, otherDeals = 0;
        for (const d of deals) {
            if (d.type !== 'DEAL_TYPE_BUY' && d.type !== 'DEAL_TYPE_SELL') { otherDeals++; continue; }
            tradeDeals++;
            for (const k of Object.keys(sum)) sum[k] += Number(d[k]) || 0;
        }
        const net = Math.round((sum.profit + sum.commission + sum.swap + sum.fee) * 100) / 100;
        const diff = Math.round((net - c.stored) * 100) / 100;
        console.log(`${c.user} ${c.date}: MetaAPI net ${net.toFixed(2)} | backend ${c.stored.toFixed(2)} | diff ${diff.toFixed(2)} | ${tradeDeals} trade deals, ${otherDeals} other | profit ${sum.profit.toFixed(2)} commission ${sum.commission.toFixed(2)} swap ${sum.swap.toFixed(2)} fee ${sum.fee.toFixed(2)}`);
    }
})();
