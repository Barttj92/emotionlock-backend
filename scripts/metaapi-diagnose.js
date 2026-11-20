// Read-only: prints the MetaAPI state of every EmotionLock account, so we can
// see why accounts stay DISCONNECTED. Never prints the token or passwords.
// Usage: METAAPI_TOKEN=... node scripts/metaapi-diagnose.js
'use strict';
const TOKEN = process.env.METAAPI_TOKEN;
if (!TOKEN) { console.error('Set METAAPI_TOKEN first.'); process.exit(1); }
const PROV = 'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai';
const HIDE = new Set(['password', 'investorPassword', 'keywords', 'accessToken']);

(async () => {
    const res = await fetch(`${PROV}/users/current/accounts?limit=1000`, { headers: { 'auth-token': TOKEN }, signal: AbortSignal.timeout(60000) });
    console.log(`list: HTTP ${res.status}`);
    const body = await res.json().catch(async () => ({ raw: (await res.text()).slice(0, 300) }));
    const list = Array.isArray(body) ? body : (body.items || []);
    if (!list.length) { console.log(JSON.stringify(body).slice(0, 500)); return; }
    const ours = list.filter(a => String(a.name || '').startsWith('EmotionLock-'));
    console.log(`${list.length} accounts, ${ours.length} EmotionLock, deployed: ${ours.filter(a => a.state === 'DEPLOYED').length}\n`);
    for (const a of ours.filter(a => a.state !== 'UNDEPLOYED')) {
        const short = String(a.name).slice(12, 20);
        const out = {};
        for (const [k, v] of Object.entries(a)) if (!HIDE.has(k)) out[k] = v;
        console.log(`${short} ${a.server}: ${a.state}/${a.connectionStatus} reliability=${a.reliability} region=${a.region}`);
        console.log('   ' + JSON.stringify(out).slice(0, 700));
        // The client API answers with a reason when the account is not connected.
        const region = a.region || 'london';
        for (const path of ['server-time', 'account-information']) {
            try {
                const r = await fetch(`https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${a._id || a.id}/${path}`, { headers: { 'auth-token': TOKEN }, signal: AbortSignal.timeout(40000) });
                console.log(`   ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
            } catch (e) { console.log(`   ${path}: ${e.message}`); }
        }
    }
})().catch(e => console.log('fout: ' + e.message));
