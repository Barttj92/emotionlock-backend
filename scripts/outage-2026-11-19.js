// One-off check for the MetaAPI outage of 19 Nov 2026 (balance empty, all
// accounts undeployed from about 21:40 UTC = 22:40 Amsterdam until the top-up
// on 20 Nov). Lists every closing deal of 19 Nov (Amsterdam day) per affected
// account, marks the ones after the outage start as missed, and says whether
// the user's limit would have been hit by them.
// Usage: METAAPI_TOKEN=... node scripts/outage-2026-11-19.js
// Read-only. Prints numbers only; never prints the token.
'use strict';
const TOKEN = process.env.METAAPI_TOKEN;
if (!TOKEN) { console.error('Set METAAPI_TOKEN first.'); process.exit(1); }

const REGION = 'london';
const OUTAGE_START = Date.parse('2026-11-19T21:40:00Z');
const DAY_FROM = '2026-11-18T23:00:00.000Z'; // 19 Nov 00:00 Amsterdam
const DAY_TO = '2026-11-19T23:00:00.000Z';   // 20 Nov 00:00 Amsterdam

// Stored state in Supabase at the moment of the outage.
const USERS = [
    { user: '725C3756', account: 'c2013acf-0e49-496c-87e7-04c3cc126ff2', mode: 'loss', limit: 100, storedTrades: 9, storedPnl: -68.22 },
    { user: 'A2D66B39', account: 'a9113840-61f6-481b-92ee-2de742f5ba64', mode: 'loss', limit: 200, storedTrades: 4, storedPnl: -90.34 },
    { user: 'EC88F7BE', account: '256222b2-e154-47db-ad18-840f3131e1e4', mode: 'loss', limit: 100, storedTrades: 0, storedPnl: 0 },
    { user: '42C65965', account: '640c5f66-6325-4a58-9421-cbddd3b58e27', mode: 'trades', limit: 3, storedTrades: 5, storedPnl: 1416.77 },
    { user: '9870C732', account: '2186e423-9030-4c1e-8cbf-f0599954fca0', mode: 'trades', limit: 2, storedTrades: 2, storedPnl: -1150.86 },
    { user: 'EA57D65C', account: 'ded2c514-61e0-4937-a48d-a3f140f492b9', mode: 'loss', limit: 300, storedTrades: 6, storedPnl: -2862.90 },
];

const CLOSE = new Set(['DEAL_ENTRY_OUT', 'DEAL_ENTRY_OUT_BY', 'DEAL_ENTRY_INOUT']);
const net = d => (Number(d.profit) || 0) + (Number(d.commission) || 0) + (Number(d.swap) || 0) + (Number(d.fee) || 0);
const r2 = n => Math.round(n * 100) / 100;
const ams = t => new Date(t).toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

(async () => {
    for (const u of USERS) {
        const url = `https://mt-client-api-v1.${REGION}.agiliumtrade.ai/users/current/accounts/${u.account}/history-deals/time/${DAY_FROM}/${DAY_TO}`;
        let deals;
        try {
            const res = await fetch(url, { headers: { 'auth-token': TOKEN }, signal: AbortSignal.timeout(30000) });
            if (!res.ok) { console.log(`${u.user}: HTTP ${res.status}, account nog niet gedeployed of niet verbonden. Later opnieuw.`); continue; }
            deals = await res.json();
        } catch (e) { console.log(`${u.user}: fout ${e.message}`); continue; }

        const trades = deals.filter(d => d.type === 'DEAL_TYPE_BUY' || d.type === 'DEAL_TYPE_SELL');
        const dayPnl = r2(trades.reduce((s, d) => s + net(d), 0));
        const closes = trades.filter(d => CLOSE.has(d.entryType));
        const positions = new Set(closes.map(d => d.positionId || d.id));
        const missed = closes.filter(d => Date.parse(d.time) >= OUTAGE_START);
        const missedPositions = new Set(missed.map(d => d.positionId || d.id));
        const missedPnl = r2(trades.filter(d => Date.parse(d.time) >= OUTAGE_START).reduce((s, d) => s + net(d), 0));

        console.log(`\n${u.user} (${u.mode}, limiet ${u.limit})`);
        console.log(`  hele dag: ${positions.size} gesloten posities, netto ${dayPnl}  | opgeslagen: ${u.storedTrades} trades, ${u.storedPnl}`);
        console.log(`  na 22:40: ${missedPositions.size} gesloten posities, netto ${missedPnl}`);
        for (const d of missed) console.log(`    ${ams(d.time)}  ${d.symbol || ''} ${d.type} vol ${d.volume}  netto ${r2(net(d))}`);

        if (!missed.length) { console.log('  -> geen gemiste trades'); continue; }
        if (u.mode === 'trades') {
            const already = u.storedTrades >= u.limit;
            console.log(already ? '  -> was al gelockt voor de storing, gemiste trades veranderen niets aan de lock'
                : `  -> ${u.storedTrades + missedPositions.size}/${u.limit}: ${u.storedTrades + missedPositions.size >= u.limit ? 'LIMIET ZOU BEREIKT ZIJN' : 'limiet niet bereikt'}`);
        } else {
            const already = u.storedPnl <= -u.limit;
            let run = u.storedPnl, hitAt = null;
            for (const d of trades.filter(d => Date.parse(d.time) >= OUTAGE_START).sort((a, b) => Date.parse(a.time) - Date.parse(b.time))) {
                run += net(d);
                if (!hitAt && run <= -u.limit) hitAt = d.time;
            }
            console.log(already ? '  -> was al gelockt voor de storing'
                : hitAt ? `  -> LIMIET ZOU BEREIKT ZIJN om ${ams(hitAt)} (eindstand ${r2(run)})` : `  -> limiet niet bereikt (eindstand ${r2(run)})`);
        }
    }
})();
