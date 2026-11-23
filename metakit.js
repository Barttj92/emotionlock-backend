'use strict';

// MetaKit (metakit.cloud) as a second MT5 provider next to MetaAPI (D-048, D-050).
//
// How it plugs in: a MetaKit account is stored in the same place as a MetaAPI
// account (purchases.meta_api_account_id, userStates[].metaApiAccountId) with
// the prefix "mk:", e.g. "mk:56". The low-level MetaAPI helpers in index.js
// check isMetaKitId() first and hand the call to this module, so every
// existing flow (connect, cleanup, refund, delete-account, restore, poller)
// works unchanged for both providers. This module returns data in the shape
// the MetaAPI REST API returns, so the trade counting and loss-limit code is
// shared and identical.
//
// Semantics that differ on purpose:
//   - "undeploy" deletes the MetaKit account. A stopped MetaKit account keeps
//     its paid slot, a deleted one frees it for the next user. The user types
//     the investor password again on a later reconnect (accepted, D-048).
//   - Slots: always reuse a free slot first, buy one only when none is free,
//     never buy ahead, at most METAKIT_MAX_SLOT_PURCHASES_PER_DAY (7) per
//     Amsterdam day. Idle slots are cancelled after METAKIT_SLOT_IDLE_DAYS.
//   - Deal times: MetaKit returns broker wall-clock time labelled as UTC. The
//     shared skew logic in index.js corrects it, fed by quoteServerTime().

const API = 'https://api.metakit.cloud';
const PREFIX = 'mk:';

const cfg = {
    apiKey: String(process.env.METAKIT_API_KEY || '').trim(),
    webhookSecret: String(process.env.METAKIT_WEBHOOK_SECRET || '').trim(),
    provider: String(process.env.MT5_PROVIDER || 'metaapi').trim().toLowerCase(),
    testUserIds: new Set(
        (process.env.METAKIT_TEST_USER_IDS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    ),
    maxSlotPurchasesPerDay: parseInt(process.env.METAKIT_MAX_SLOT_PURCHASES_PER_DAY || '7', 10),
    slotIdleDays: parseInt(process.env.METAKIT_SLOT_IDLE_DAYS || '7', 10),
    pollMs: parseInt(process.env.METAKIT_POLL_MS || '60000', 10),
    connectWaitMs: parseInt(process.env.METAKIT_CONNECT_WAIT_MS || '45000', 10),
    // Servers that are not in MetaKit's broker list (most prop firms on 23 Nov
    // 2026) are still tried once without broker_id. If MetaKit cannot connect,
    // the server is skipped for 24h and the user goes to MetaAPI.
    tryUnlistedServers: process.env.METAKIT_TRY_UNLISTED_SERVERS !== 'false',
};

let deps = {
    notifyAdmin: async () => {},
    adminNotifyTimestamp: () => new Date().toISOString(),
    log: (...a) => console.log(...a),
};

function init(injected) {
    deps = { ...deps, ...injected };
    if (cfg.provider === 'metakit' && !cfg.apiKey) {
        console.error('[metakit] MT5_PROVIDER=metakit but METAKIT_API_KEY is not set: new connects stay on MetaAPI');
    }
    console.log(`[metakit] provider=${cfg.provider} configured=${isConfigured()} testUsers=${cfg.testUserIds.size} webhookSecret=${cfg.webhookSecret ? 'set' : 'missing'}`);
}

function isConfigured() {
    return !!cfg.apiKey;
}

function isMetaKitId(id) {
    return typeof id === 'string' && id.startsWith(PREFIX);
}

function toRawId(id) {
    return String(id).slice(PREFIX.length);
}

function toPrefixedId(rawId) {
    return `${PREFIX}${rawId}`;
}

// New connects go to MetaKit when the global trigger is on, or for test users.
function useMetaKitFor(userId) {
    if (!isConfigured()) return false;
    if (cfg.provider === 'metakit') return true;
    return !!userId && cfg.testUserIds.has(String(userId).toLowerCase());
}

// Errors where the connect may fall back to MetaAPI (MetaKit cannot serve
// this user right now). Credential errors are NOT in this group: a wrong
// investor password is wrong at MetaAPI too.
class MetaKitFallbackError extends Error {
    constructor(reason, message) {
        super(message || reason);
        this.code = 'METAKIT_FALLBACK';
        this.reason = reason;
    }
}

// ── HTTP ──────────────────────────────────────────────────────────────────
async function mk(method, path, body, timeoutMs = 30000) {
    const response = await fetch(API + path, {
        method,
        headers: {
            Authorization: `Bearer ${cfg.apiKey}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (response.status === 429) {
        console.log(`[metakit] 429 rate limited on ${method} ${path} (retry-after ${response.headers.get('retry-after') || '?'}s)`);
    }
    return { status: response.status, ok: response.ok, json, text };
}

async function mkPaged(path, maxPages = 20) {
    const all = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= maxPages; page++) {
        const r = await mk('GET', `${path}${sep}limit=100&page=${page}`);
        if (!r.ok || !r.json || !Array.isArray(r.json.data)) return { ok: false, status: r.status, data: null };
        all.push(...r.json.data);
        const totalPages = Number(r.json.total_pages) || 1;
        if (page >= totalPages) return { ok: true, status: r.status, data: all };
    }
    console.log(`[metakit] ${path}: stopped after ${maxPages} pages, result may be incomplete`);
    return { ok: true, status: 200, data: all };
}

// ── Mapping to the MetaAPI shapes used by index.js ────────────────────────
const DEAL_TYPES = { buy: 'DEAL_TYPE_BUY', sell: 'DEAL_TYPE_SELL', balance: 'DEAL_TYPE_BALANCE', credit: 'DEAL_TYPE_CREDIT' };
const DEAL_ENTRIES = { in: 'DEAL_ENTRY_IN', out: 'DEAL_ENTRY_OUT', inout: 'DEAL_ENTRY_INOUT', out_by: 'DEAL_ENTRY_OUT_BY' };

function upperToken(value, prefix) {
    const s = String(value || '').trim();
    if (!s) return undefined;
    return `${prefix}${s.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function finiteOrNull(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// MetaKit deal -> MetaAPI deal. `time` keeps MetaKit's own clock (broker wall
// clock labelled UTC); index.js shifts it with the measured skew, exactly as
// it does for MetaAPI accounts whose clock is off.
function mapDeal(d) {
    if (!d || d.ticket === undefined || d.ticket === null) return null;
    const t = Date.parse(d.time);
    const type = DEAL_TYPES[String(d.type || '').toLowerCase()] || upperToken(d.type, 'DEAL_TYPE_');
    const entryType = DEAL_ENTRIES[String(d.entry || '').toLowerCase()] || upperToken(d.entry, 'DEAL_ENTRY_');
    const positionId = d.positionId !== undefined && d.positionId !== null && Number(d.positionId) !== 0
        ? String(d.positionId) : undefined;
    return {
        id: String(d.ticket),
        type,
        entryType,
        positionId,
        orderId: d.order !== undefined ? String(d.order) : undefined,
        symbol: d.symbol || '',
        volume: finiteOrNull(d.volume),
        price: finiteOrNull(d.price),
        profit: finiteOrNull(d.profit),
        commission: finiteOrNull(d.commission),
        swap: finiteOrNull(d.swap),
        fee: finiteOrNull(d.fee),
        reason: d.reason,
        time: Number.isFinite(t) ? new Date(t).toISOString() : d.time,
        // Broker wall clock, for the time diagnostics log.
        brokerTime: Number.isFinite(t) ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) : undefined,
        platform: 'mt5',
    };
}

function mapPosition(p) {
    if (!p || p.ticket === undefined || p.ticket === null) return null;
    return {
        id: String(p.ticket),
        symbol: p.symbol,
        type: p.type === 'sell' ? 'POSITION_TYPE_SELL' : 'POSITION_TYPE_BUY',
        volume: finiteOrNull(p.volume),
        openPrice: finiteOrNull(p.priceOpen),
        currentPrice: finiteOrNull(p.priceCurrent),
        profit: finiteOrNull(p.profit),
        swap: finiteOrNull(p.swap),
        time: p.time,
    };
}

// MetaKit account status -> MetaAPI state + connectionStatus.
//   connected    -> DEPLOYED / CONNECTED
//   starting     -> DEPLOYING
//   disconnected -> UNDEPLOYED (stopped; the poller starts it again if the user has access)
//   error        -> DEPLOYED / DISCONNECTED (the poller retries with start after its grace)
function mapAccount(a) {
    if (!a) return null;
    const status = String(a.status || '').toLowerCase();
    let state = 'DEPLOYED';
    let connectionStatus = 'DISCONNECTED';
    if (status === 'connected') connectionStatus = 'CONNECTED';
    else if (status === 'starting') { state = 'DEPLOYING'; connectionStatus = 'DISCONNECTED'; }
    else if (status === 'disconnected') { state = 'UNDEPLOYED'; connectionStatus = 'DISCONNECTED'; }
    return {
        id: toPrefixedId(a.id),
        name: a.account_name,
        login: a.account_number !== undefined ? String(a.account_number) : undefined,
        server: a.server,
        state,
        connectionStatus,
        region: 'metakit',
        currency: a.currency,
        metakitStatus: status,
        brokerId: a.broker_id,
    };
}

// ── Broker lookup (server name -> broker_id) ──────────────────────────────
const BROKER_CACHE_MS = 6 * 3600 * 1000;
let brokerCache = { at: 0, byServer: null };

async function loadBrokerIndex() {
    if (brokerCache.byServer && Date.now() - brokerCache.at < BROKER_CACHE_MS) return brokerCache.byServer;
    const r = await mkPaged('/v1/brokers');
    if (!r.ok) {
        if (brokerCache.byServer) return brokerCache.byServer; // keep a stale index rather than none
        return null;
    }
    const byServer = new Map();
    for (const b of r.data) {
        const servers = (b.servers && Array.isArray(b.servers.MT5)) ? b.servers.MT5 : [];
        for (const s of servers) byServer.set(String(s).trim().toLowerCase(), b.id);
    }
    brokerCache = { at: Date.now(), byServer };
    console.log(`[metakit] broker index loaded: ${r.data.length} brokers, ${byServer.size} MT5 servers`);
    return byServer;
}

async function findBrokerId(server) {
    const index = await loadBrokerIndex();
    if (!index) throw new MetaKitFallbackError('broker_lookup_failed', 'MetaKit broker list could not be read');
    const id = index.get(String(server || '').trim().toLowerCase());
    return id === undefined ? null : id;
}

// ── Slot pool ─────────────────────────────────────────────────────────────
function amsterdamDayStartMs(nowMs = Date.now()) {
    const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));
    // Offset of Amsterdam at this moment (CET +1h or CEST +2h).
    const asAms = new Date(new Date(nowMs).toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' })).getTime();
    const asUtc = new Date(new Date(nowMs).toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
    return Date.parse(`${ymd}T00:00:00Z`) - (asAms - asUtc);
}

let slotMutex = Promise.resolve();
let lastSlotAlertAt = 0;

function alertSlots(subject, lines) {
    const now = Date.now();
    if (now - lastSlotAlertAt < 3 * 3600 * 1000) return;
    lastSlotAlertAt = now;
    deps.notifyAdmin({ subject, lines: [...lines, '', `Time (Europe/Amsterdam): ${deps.adminNotifyTimestamp()}`] }).catch(() => {});
}

// Makes sure one readonly slot is free. Reuses a free slot when there is one;
// buys exactly one otherwise. Serialised so two connects never buy two slots
// for one free place.
function ensureFreeSlot(userId) {
    const run = slotMutex.then(() => ensureFreeSlotLocked(userId));
    slotMutex = run.catch(() => {});
    return run;
}

async function ensureFreeSlotLocked(userId) {
    const usage = await mk('GET', '/v1/usage');
    if (!usage.ok || !usage.json) throw new MetaKitFallbackError('usage_unavailable', `MetaKit usage HTTP ${usage.status}`);
    const free = Number(usage.json.readonly_accounts?.available ?? 0);
    if (free > 0) return { bought: false };

    // Daily brake: count slots bought since Amsterdam midnight.
    const slots = await mkPaged('/v1/slots');
    if (!slots.ok) throw new MetaKitFallbackError('slots_unavailable', `MetaKit slots HTTP ${slots.status}`);
    const dayStart = amsterdamDayStartMs();
    const boughtToday = slots.data.filter(s => Date.parse(s.created_at) >= dayStart).length;
    if (boughtToday >= cfg.maxSlotPurchasesPerDay) {
        alertSlots('[EmotionLock] MetaKit slot brake reached, new connects go to MetaAPI', [
            `${boughtToday} MetaKit slots were bought today (limit ${cfg.maxSlotPurchasesPerDay} per day, D-050).`,
            'No more slots are bought today. New MT5 connects fall back to MetaAPI until tomorrow.',
            `Last user: ${userId}`,
            'Raise METAKIT_MAX_SLOT_PURCHASES_PER_DAY on Railway if this is real growth.',
        ]);
        throw new MetaKitFallbackError('slot_brake', 'daily slot purchase limit reached');
    }

    const bought = await mk('POST', '/v1/slots', { tier: 'readonly' });
    if (bought.status === 402) {
        alertSlots('[EmotionLock] MetaKit slot purchase refused (payment)', [
            'MetaKit refused to buy a slot: no valid card on file or the payment failed.',
            'New MT5 connects fall back to MetaAPI. Check Settings > Billing in MetaKit.',
            `Response: ${bought.text.slice(0, 300)}`,
        ]);
        throw new MetaKitFallbackError('payment_required', 'MetaKit slot purchase needs a payment method');
    }
    if (!bought.ok) throw new MetaKitFallbackError('slot_purchase_failed', `MetaKit slot purchase HTTP ${bought.status}`);
    const slot = bought.json?.slot;
    console.log(`[metakit] bought slot ${slot?.id} (${slot?.status}) for user ${String(userId).slice(0, 8)}, ${boughtToday + 1} today`);
    if (slot && slot.status !== 'active') {
        // 3-D Secure or a slow charge: give it a few seconds, then let the
        // connect find out (POST /v1/accounts answers 402 if still unusable).
        for (let i = 0; i < 5; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const u = await mk('GET', '/v1/usage');
            if (u.ok && Number(u.json?.readonly_accounts?.available ?? 0) > 0) break;
        }
    }
    return { bought: true };
}

// ── Accounts ──────────────────────────────────────────────────────────────
async function listEmotionLockAccounts() {
    const r = await mkPaged('/v1/accounts');
    if (!r.ok) return null;
    return r.data.filter(a => /^EmotionLock-/i.test(String(a.account_name || '')));
}

async function getAccountRaw(rawId) {
    return mk('GET', `/v1/accounts/${rawId}`);
}

// Same contract as fetchMetaApiAccountInfo: { account, status }.
async function fetchAccountInfo(prefixedId) {
    const r = await getAccountRaw(toRawId(prefixedId));
    if (r.status === 404) return { account: null, status: 404 };
    if (!r.ok || !r.json) {
        console.log(`[metakit] getAccount HTTP ${r.status} for ${prefixedId}: ${String(r.text).slice(0, 200)}`);
        return { account: null, status: r.status };
    }
    return { account: mapAccount(r.json), status: r.status };
}

async function startAccount(prefixedId) {
    const r = await mk('POST', `/v1/accounts/${toRawId(prefixedId)}/start`);
    if (r.ok) return true;
    // Already starting or another start/stop running: not an error for us.
    if (r.status === 409 && /operation_in_progress/.test(r.text)) return true;
    throw new Error(`MetaKit start failed: HTTP ${r.status} ${String(r.text).slice(0, 300)}`);
}

// "Undeploy" for MetaKit = delete the account and free its slot. 404 = already gone.
async function releaseAccount(prefixedId) {
    const r = await mk('DELETE', `/v1/accounts/${toRawId(prefixedId)}`);
    if (r.ok || r.status === 404) {
        console.log(`[metakit] released account ${prefixedId} (slot freed)`);
        return true;
    }
    throw new Error(`MetaKit delete failed: HTTP ${r.status} ${String(r.text).slice(0, 300)}`);
}

async function updateConnection(prefixedId, { server, password }) {
    const brokerId = await findBrokerId(server);
    const body = brokerId === null ? { server, password } : { broker_id: brokerId, server, password };
    const r = await mk('PATCH', `/v1/accounts/${toRawId(prefixedId)}`, body);
    if (!r.ok) throw new Error(`MetaKit update account failed: HTTP ${r.status} ${String(r.text).slice(0, 300)}`);
}

// Waits until a freshly created account is connected or failed.
async function waitForConnect(rawId, waitMs = cfg.connectWaitMs) {
    const deadline = Date.now() + waitMs;
    let last = null;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 3000));
        const r = await getAccountRaw(rawId);
        if (r.ok && r.json) {
            last = String(r.json.status || '').toLowerCase();
            if (last === 'connected' || last === 'error') return last;
        }
    }
    return last || 'starting';
}

function credentialError() {
    // Same raw shape as a MetaAPI rejection, so friendlyMt5ConnectError in
    // index.js shows the existing "check server, account number and password" text.
    return new Error('MetaKit connect failed: {"error":"ValidationError","message":"MetaKit could not log in to the broker"}');
}

// Counterpart of createOrRecoverMetaApiAccount, with the same safety net:
// look for an account named EmotionLock-<userId> before creating one.
const unlistedFailedAt = new Map(); // server (lower case) -> ms of the failed try
const UNLISTED_RETRY_MS = 24 * 3600 * 1000;

function markUnlistedFailed(server, why) {
    unlistedFailedAt.set(String(server).trim().toLowerCase(), Date.now());
    console.log(`[metakit] unlisted server ${server} did not work (${why}), MetaAPI for the next 24h`);
}

async function createOrRecoverAccount(server, login, password, userId) {
    const name = `EmotionLock-${userId}`;
    const brokerId = await findBrokerId(server);
    const unlisted = brokerId === null;
    if (unlisted) {
        const failedAt = unlistedFailedAt.get(String(server).trim().toLowerCase());
        if (!cfg.tryUnlistedServers || (failedAt && Date.now() - failedAt < UNLISTED_RETRY_MS)) {
            throw new MetaKitFallbackError('broker_unsupported', `MetaKit does not list server ${server}`);
        }
        console.log(`[metakit] server ${server} is not in the broker list, trying without broker_id`);
    }

    const existing = await listEmotionLockAccounts();
    if (existing === null) throw new MetaKitFallbackError('accounts_unavailable', 'MetaKit account list could not be read');
    const mine = existing.filter(a => String(a.account_name).toLowerCase() === name.toLowerCase());
    const sameServer = (a) => String(a.server || '').trim().toLowerCase() === String(server).trim().toLowerCase();
    const reusable = mine.filter(a => sameServer(a) && String(a.account_number) === String(login));
    const stale = mine.filter(a => !reusable.includes(a));

    for (const old of stale) {
        console.log(`[metakit] stale account ${old.id} for user ${userId}, deleting before create`);
        await releaseAccount(toPrefixedId(old.id)).catch(e => console.log('[metakit] stale cleanup warning:', e.message));
    }
    if (reusable.length > 0) {
        const keep = reusable.find(a => a.status === 'connected') || reusable[0];
        for (const extra of reusable) {
            if (extra.id === keep.id) continue;
            console.log(`[metakit] deleting duplicate account ${extra.id} for user ${userId} (keeping ${keep.id})`);
            await releaseAccount(toPrefixedId(extra.id)).catch(() => {});
        }
        // The user just typed the password again: use it, then (re)start.
        await updateConnection(toPrefixedId(keep.id), { server, password }).catch(e => console.log('[metakit] password update warning:', e.message));
        await startAccount(toPrefixedId(keep.id)).catch(e => console.log('[metakit] start warning:', e.message));
        console.log(`[metakit] recovered account ${keep.id} by name for user ${userId}`);
        return { id: toPrefixedId(keep.id), region: 'metakit', recovered: true };
    }

    await ensureFreeSlot(userId);
    const body = { name, number: Number(login), password, server, type: 'readonly' };
    if (!unlisted) body.broker_id = brokerId;
    let created = await mk('POST', '/v1/accounts', body);
    if (created.status === 402) {
        // Slot got taken in between, or the bought slot is not active yet.
        await ensureFreeSlot(userId);
        created = await mk('POST', '/v1/accounts', body);
    }
    if (created.status === 402) throw new MetaKitFallbackError('no_slot', 'MetaKit has no usable slot');
    if (created.status >= 500 || created.status === 429 || created.status === 0) {
        throw new MetaKitFallbackError('create_failed', `MetaKit create HTTP ${created.status}`);
    }
    if ((!created.ok || created.json?.id === undefined) && unlisted) {
        markUnlistedFailed(server, `create HTTP ${created.status}`);
        throw new MetaKitFallbackError('broker_unsupported', `MetaKit refused unlisted server ${server}`);
    }
    if (!created.ok || created.json?.id === undefined) {
        // 4xx other than 402: bad input (login not numeric, server rejected).
        console.log(`[metakit] create refused for user ${userId}: HTTP ${created.status} ${String(created.text).slice(0, 300)}`);
        throw credentialError();
    }
    const rawId = created.json.id;
    console.log(`[metakit] created account ${rawId} for user ${userId} on ${server}`);
    // Shorter wait for an unlisted server: if MetaKit cannot connect, the
    // MetaAPI fallback still has to fit in the app's 90s connect timeout.
    const outcome = await waitForConnect(rawId, unlisted ? Math.min(cfg.connectWaitMs, 30000) : cfg.connectWaitMs);
    if (outcome === 'error') {
        await releaseAccount(toPrefixedId(rawId)).catch(() => {});
        if (unlisted) {
            // Could be the password, could be MetaKit not knowing this broker.
            // MetaAPI tells the user which one it is.
            markUnlistedFailed(server, 'connect error');
            throw new MetaKitFallbackError('broker_unsupported', `MetaKit could not connect to unlisted server ${server}`);
        }
        throw credentialError();
    }
    return { id: toPrefixedId(rawId), region: 'metakit', recovered: false };
}

// ── Trade data ────────────────────────────────────────────────────────────
// Returns MetaAPI-shaped deals, or null on failure (never [] on failure).
async function getDeals(prefixedId, fromIso, toIso) {
    try {
        const q = `from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`;
        const r = await mkPaged(`/v1/accounts/${toRawId(prefixedId)}/deals?${q}`);
        if (!r.ok) {
            console.log(`[metakit] getDeals HTTP ${r.status} for ${prefixedId}`);
            return null;
        }
        return r.data.map(mapDeal).filter(Boolean)
            .sort((a, b) => Number(a.id) - Number(b.id));
    } catch (e) {
        console.log(`[metakit] getDeals error for ${prefixedId}: ${e.message}`);
        return null;
    }
}

async function getOpenPositions(prefixedId) {
    try {
        const r = await mkPaged(`/v1/accounts/${toRawId(prefixedId)}/positions`);
        if (!r.ok) {
            console.log(`[metakit] getPositions HTTP ${r.status} for ${prefixedId}`);
            return null;
        }
        return r.data.map(mapPosition).filter(Boolean);
    } catch (e) {
        console.log(`[metakit] getPositions error for ${prefixedId}: ${e.message}`);
        return null;
    }
}

async function getCurrency(prefixedId) {
    const r = await getAccountRaw(toRawId(prefixedId));
    if (!r.ok || !r.json) return null;
    return typeof r.json.currency === 'string' ? r.json.currency : null;
}

// MetaKit has no server-time endpoint. A live quote carries the broker's
// clock (labelled UTC), which is what deal times use. Returns
// { time } in the getServerTime contract, or null when the quote is stale
// (market closed) or unavailable, so the caller keeps the last known skew.
const quoteSymbolByAccount = new Map();
async function quoteServerTime(prefixedId) {
    const rawId = toRawId(prefixedId);
    const candidates = [quoteSymbolByAccount.get(rawId), 'EURUSD', 'EURUSD.m', 'EURUSD.r', 'EURUSD+', 'GBPUSD', 'XAUUSD', 'BTCUSD'].filter(Boolean);
    const tried = new Set();
    for (const symbol of candidates) {
        if (tried.has(symbol)) continue;
        tried.add(symbol);
        try {
            const r = await mk('GET', `/v1/accounts/${rawId}/quote?symbol=${encodeURIComponent(symbol)}`, null, 15000);
            if (!r.ok || !r.json || !r.json.time) continue;
            const t = Date.parse(r.json.time);
            // A plausible live broker clock is within -2h..+4h of real UTC.
            // Anything else is a stale tick (weekend, closed market).
            const diff = t - Date.now();
            if (!Number.isFinite(t) || diff < -2 * 3600 * 1000 || diff > 4 * 3600 * 1000) continue;
            quoteSymbolByAccount.set(rawId, symbol);
            return { time: new Date(t).toISOString() };
        } catch { /* try next symbol */ }
    }
    return null;
}

// ── Webhooks ──────────────────────────────────────────────────────────────
const crypto = require('crypto');

// Returns { ok, reason }. Tries the secret as shown by MetaKit (whsec_...)
// and without its "whsec_" prefix, since the docs do not say which bytes
// are the HMAC key. Both require knowing the secret.
function checkSignature(rawBody, header, toleranceSec = 300) {
    if (!cfg.webhookSecret) return { ok: false, reason: 'no_secret_configured' };
    if (!header) return { ok: false, reason: 'missing_header' };
    if (!rawBody) return { ok: false, reason: 'empty_body' };
    const parts = {};
    for (const kv of String(header).split(',')) {
        const i = kv.indexOf('=');
        if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
    const t = parts.t;
    const v1 = parts.v1;
    if (!t || !v1) return { ok: false, reason: 'malformed_header' };
    if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return { ok: false, reason: 'stale_timestamp' };
    const keys = [cfg.webhookSecret];
    if (cfg.webhookSecret.startsWith('whsec_')) keys.push(cfg.webhookSecret.slice('whsec_'.length));
    const b = Buffer.from(String(v1), 'utf8');
    for (const key of keys) {
        const expected = crypto.createHmac('sha256', key).update(`${t}.${rawBody}`).digest('hex');
        const a = Buffer.from(expected, 'utf8');
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) return { ok: true, reason: 'ok' };
    }
    return { ok: false, reason: 'signature_mismatch' };
}

function verifySignature(rawBody, header, toleranceSec = 300) {
    return checkSignature(rawBody, header, toleranceSec).ok;
}

// account id of the event (trade events: account_id, account events: account.id)
function webhookAccountId(body) {
    const id = body?.account_id ?? body?.account?.id;
    return id === undefined || id === null ? null : toPrefixedId(id);
}

// ── Maintenance (hourly): orphans and idle slots ──────────────────────────
const ORPHAN_CONFIRM_MS = 50 * 60 * 1000;
const ORPHAN_MAX_PER_RUN = 10;
const SLOT_RELEASE_MAX_PER_RUN = 5;
const orphanFirstSeenAt = new Map();

// linkedIds: Set of prefixed ids that belong to a user (Supabase + memory).
// inFlightUserIds: Set of lower-case user ids with a connect running.
async function runMaintenance({ linkedIds, inFlightUserIds }) {
    if (!isConfigured()) return;
    const accounts = await listEmotionLockAccounts();
    if (accounts === null) return;

    // Orphans: an EmotionLock account no user points to. Deleted after two
    // sightings at least 50 min apart, never during that user's connect.
    if (linkedIds && linkedIds.size > 0) {
        const now = Date.now();
        const orphans = accounts.filter(a => !linkedIds.has(toPrefixedId(a.id)));
        const orphanKeys = new Set(orphans.map(a => String(a.id)));
        for (const id of [...orphanFirstSeenAt.keys()]) if (!orphanKeys.has(id)) orphanFirstSeenAt.delete(id);
        const confirmed = [];
        for (const a of orphans) {
            const owner = String(a.account_name).slice('EmotionLock-'.length).toLowerCase();
            if (inFlightUserIds && inFlightUserIds.has(owner)) continue;
            const key = String(a.id);
            if (!orphanFirstSeenAt.has(key)) { orphanFirstSeenAt.set(key, now); continue; }
            if (now - orphanFirstSeenAt.get(key) >= ORPHAN_CONFIRM_MS) confirmed.push(a);
        }
        const toDelete = confirmed.slice(0, ORPHAN_MAX_PER_RUN);
        for (const a of toDelete) {
            await releaseAccount(toPrefixedId(a.id)).catch(e => console.log('[metakit] orphan delete warning:', e.message));
            orphanFirstSeenAt.delete(String(a.id));
        }
        if (toDelete.length > 0) {
            deps.notifyAdmin({
                subject: `[EmotionLock] ${toDelete.length} orphan MetaKit account(s) deleted`,
                lines: [
                    'These MetaKit accounts were not linked to any user and were deleted (slot freed):',
                    '',
                    ...toDelete.map(a => `  - ${a.id}  ${a.account_name}  ${a.server}/${a.account_number}`),
                    '',
                    `Time (Europe/Amsterdam): ${deps.adminNotifyTimestamp()}`,
                ],
            }).catch(() => {});
        }
    }

    // Idle slots: free for more than METAKIT_SLOT_IDLE_DAYS -> cancel.
    const slots = await mkPaged('/v1/slots?status=active');
    if (!slots.ok) return;
    const idleCutoff = Date.now() - cfg.slotIdleDays * 24 * 3600 * 1000;
    const idle = slots.data.filter(s => s.tier === 'readonly' && s.connected_account_id === null
        && Date.parse(s.updated_at || s.created_at) < idleCutoff);
    const toRelease = idle.slice(0, SLOT_RELEASE_MAX_PER_RUN);
    const released = [];
    for (const s of toRelease) {
        const r = await mk('DELETE', `/v1/slots/${s.id}`);
        if (r.ok || r.status === 204) released.push(s);
        else console.log(`[metakit] slot release ${s.id} HTTP ${r.status}: ${String(r.text).slice(0, 200)}`);
    }
    if (released.length > 0) {
        console.log(`[metakit] released ${released.length} idle slot(s)`);
        deps.notifyAdmin({
            subject: `[EmotionLock] ${released.length} idle MetaKit slot(s) cancelled`,
            lines: [
                `Slots that were free for more than ${cfg.slotIdleDays} days were cancelled (D-050):`,
                ...released.map(s => `  - ${s.id} (free since ${s.updated_at})`),
                '',
                `Time (Europe/Amsterdam): ${deps.adminNotifyTimestamp()}`,
            ],
        }).catch(() => {});
    }
}

async function summary() {
    if (!isConfigured()) return { configured: false, provider: cfg.provider };
    const [usage, slots, accounts] = await Promise.all([
        mk('GET', '/v1/usage'), mkPaged('/v1/slots'), mkPaged('/v1/accounts'),
    ]);
    return {
        configured: true,
        provider: cfg.provider,
        usage: usage.json,
        slots: slots.ok ? slots.data.map(s => ({ id: s.id, tier: s.tier, status: s.status, account: s.connected_account_id, created_at: s.created_at, updated_at: s.updated_at })) : null,
        accounts: accounts.ok ? accounts.data.map(a => ({ id: a.id, name: a.account_name, server: a.server, status: a.status, type: a.type, last_ping: a.last_ping })) : null,
        limits: { maxSlotPurchasesPerDay: cfg.maxSlotPurchasesPerDay, slotIdleDays: cfg.slotIdleDays, pollMs: cfg.pollMs },
    };
}

module.exports = {
    cfg,
    init,
    isConfigured,
    isMetaKitId,
    toRawId,
    toPrefixedId,
    useMetaKitFor,
    MetaKitFallbackError,
    // provider calls
    fetchAccountInfo,
    startAccount,
    releaseAccount,
    updateConnection,
    createOrRecoverAccount,
    getDeals,
    getOpenPositions,
    getCurrency,
    quoteServerTime,
    // webhooks
    verifySignature,
    checkSignature,
    webhookAccountId,
    // jobs
    runMaintenance,
    summary,
    // exported for tests
    _test: { mapDeal, mapPosition, mapAccount, amsterdamDayStartMs, findBrokerId },
};
