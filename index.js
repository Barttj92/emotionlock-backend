const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
let apn = null;
try { apn = require('@parse/node-apn'); } catch (err) { console.error('apn module unavailable (push disabled):', err.message); }
const { createClient } = require('@supabase/supabase-js');

// =====================
// Startup checks
// =====================
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('FATAL: SUPABASE_SERVICE_ROLE_KEY environment variable is not set.');
    process.exit(1);
}

const app = express();

// =====================
// Security middleware
// =====================
app.use(cors({ origin: 'https://emotionlock.app' }));
// F9: Explicit body size limit — prevents oversized payloads from reaching JSON parsing
app.use(express.json({ limit: '10kb' }));

// Debug logger — only logs in non-production environments
const debugLog = (...args) => { if (process.env.NODE_ENV !== 'production') console.log(...args); };

// Timing-safe admin key comparison
function isValidAdminKey(key) {
    if (!key || !process.env.ADMIN_KEY) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(key), Buffer.from(process.env.ADMIN_KEY));
    } catch {
        return false;
    }
}

// Rate limiters
const unlockLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many unlock attempts. Try again in an hour.' },
});

const mt5Limiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many connection attempts. Try again in an hour.' },
});

// F5: Rate limit on /status — the iOS app polls every 5s (720/hour per device).
// 1200/hour per IP leaves plenty of room for legitimate polling from a single household
// while blocking automated scanners that probe random UUIDs to pollute the DB.
const statusLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 1200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.' },
});

// =====================
// Supabase setup
// =====================
const SUPABASE_URL = process.env.SUPABASE_URL;
if (!SUPABASE_URL) {
    console.error('FATAL: SUPABASE_URL environment variable is not set.');
    process.exit(1);
}
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function getStoredTokens(licenseCode) {
    const { data } = await supabase
        .from('purchases')
        .select('emergency_tokens_remaining')
        .eq('license_code', licenseCode)
        .single();
    return data?.emergency_tokens_remaining ?? null;
}

async function saveTokens(licenseCode, tokens) {
    await supabase
        .from('purchases')
        .update({ emergency_tokens_remaining: tokens })
        .eq('license_code', licenseCode);
}

// UUID-based save — used for all Apple IAP users (the standard flow)
async function saveTokensByUserId(userId, tokens) {
    await supabase
        .from('purchases')
        .update({ emergency_tokens_remaining: tokens })
        .eq('user_id', userId);
}

async function saveDailyTrades(userId, count, dateStr) {
    await supabase
        .from('purchases')
        .update({ daily_trades_count: count, daily_trades_date: dateStr })
        .eq('user_id', userId);
}


// =====================
// APNs setup
// =====================
let apnProvider = null;
if (process.env.APNS_KEY_BASE64) {
    try {
        const apnKey = Buffer.from(process.env.APNS_KEY_BASE64, 'base64').toString('utf8');
        apnProvider = new apn.Provider({
            token: {
                key: apnKey,
                keyId: process.env.APNS_KEY_ID,
                teamId: process.env.APNS_TEAM_ID,
            },
            production: process.env.APNS_PRODUCTION === 'true'
        });
        console.log('APNs provider initialized');
    } catch (err) {
        console.error('APNs provider init failed (push notifications disabled):', err.message);
        apnProvider = null;
    }
}

async function sendPushNotification(deviceToken, title, body) {
    if (!apn || !apnProvider || !deviceToken) return;
    const notification = new apn.Notification();
    notification.expiry = Math.floor(Date.now() / 1000) + 3600;
    notification.badge = 1;
    notification.sound = 'default';
    notification.alert = { title, body };
    notification.topic = process.env.APNS_BUNDLE_ID || 'com.emotionlock.EmotionLock';
    try {
        const result = await apnProvider.send(notification, deviceToken);
        if (result.failed.length > 0) {
            console.log('Push failed:', result.failed[0].response);
        } else {
            console.log('Push sent successfully');
        }
    } catch (err) {
        console.error('Push error:', err.message);
    }
}

// =====================
// MetaApi setup
// =====================
const METAAPI_TOKEN = process.env.METAAPI_TOKEN;
const PROVISIONING_API = 'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai';

async function createMetaApiAccount(server, login, password, name) {
    const response = await fetch(`${PROVISIONING_API}/users/current/accounts`, {
        method: 'POST',
        headers: {
            'auth-token': METAAPI_TOKEN,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            login: String(login),
            password,
            name,
            server,
            platform: 'mt5',
            type: 'cloud',
            magic: 0,
            application: 'MetaApi',
            // Explicit G1 tier (regular reliability). Never use 'high' — doubles hourly cost.
            reliability: 'regular',
            copyFactoryRoles: [],
            tags: ['emotionlock']
        })
    });
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`MetaApi create account failed: ${err}`);
    }
    return response.json();
}

async function deployMetaApiAccount(accountId) {
    const response = await fetch(`${PROVISIONING_API}/users/current/accounts/${accountId}/deploy`, {
        method: 'POST',
        headers: { 'auth-token': METAAPI_TOKEN }
    });
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`MetaApi deploy failed: ${err}`);
    }
}

async function undeployMetaApiAccount(accountId) {
    try {
        await fetch(`${PROVISIONING_API}/users/current/accounts/${accountId}/undeploy`, {
            method: 'POST',
            headers: { 'auth-token': METAAPI_TOKEN }
        });
    } catch (e) {
        console.log('Undeploy warning:', e.message);
    }
}

async function undeployAndDeleteMetaApiAccount(accountId) {
    await undeployMetaApiAccount(accountId);
    await new Promise(r => setTimeout(r, 3000));
    const response = await fetch(`${PROVISIONING_API}/users/current/accounts/${accountId}`, {
        method: 'DELETE',
        headers: { 'auth-token': METAAPI_TOKEN }
    });
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`MetaApi delete failed: ${err}`);
    }
}

async function getMetaApiAccountInfo(accountId) {
    const response = await fetch(`${PROVISIONING_API}/users/current/accounts/${accountId}`, {
        headers: { 'auth-token': METAAPI_TOKEN }
    });
    if (!response.ok) {
        const errText = await response.text();
        console.log(`[metaapi] getAccountInfo HTTP ${response.status} for ${accountId}: ${errText.slice(0, 200)}`);
        return null;
    }
    return response.json();
}

// Safety net against duplicate accounts: if Supabase row and in-memory state are
// both missing (server restart with stale data, lost rows, etc.) we still need to
// find any pre-existing MetaAPI account tied to this user before creating a new one.
// Every account we create is named `EmotionLock-${userId}` and tagged 'emotionlock'
// so we can recover by listing accounts and matching on name.
async function findMetaApiAccountByName(name) {
    try {
        const response = await fetch(`${PROVISIONING_API}/users/current/accounts`, {
            headers: { 'auth-token': METAAPI_TOKEN }
        });
        if (!response.ok) {
            console.log(`[metaapi] findByName list HTTP ${response.status}`);
            return null;
        }
        const accounts = await response.json();
        if (!Array.isArray(accounts)) return null;
        // Exact match on name. If multiple accounts somehow share a name, prefer
        // the first one. Duplicate cleanup is a separate admin concern.
        const match = accounts.find(a => a && a.name === name);
        return match || null;
    } catch (err) {
        console.log(`[metaapi] findByName error: ${err.message}`);
        return null;
    }
}

// Wraps createMetaApiAccount with the safety-net check. Always called instead of
// createMetaApiAccount directly from the connect-mt5 flow. Behavior:
//   1. List MetaAPI accounts and look for one named `EmotionLock-${userId}`
//   2. If found AND credentials match: redeploy and reuse (no new account)
//   3. If found but credentials are stale: delete it, then create fresh
//   4. If not found: create fresh
// Returns { id, region, recovered }.
async function createOrRecoverMetaApiAccount(server, login, password, userId) {
    const name = `EmotionLock-${userId}`;
    const orphan = await findMetaApiAccountByName(name);
    if (orphan && orphan.id) {
        const sameCreds = (orphan.server || '').trim() === server.trim() &&
                          String(orphan.login || '') === String(login);
        if (sameCreds) {
            console.log(`[metaapi] Recovered orphan account ${orphan.id} by name for user ${userId}`);
            await deployMetaApiAccount(orphan.id);
            return { id: orphan.id, region: orphan.region || null, recovered: true };
        }
        console.log(`[metaapi] Stale orphan account ${orphan.id} for user ${userId}, deleting before create`);
        try {
            await undeployAndDeleteMetaApiAccount(orphan.id);
        } catch (e) {
            console.log('Orphan cleanup warning:', e.message);
        }
    }
    const account = await createMetaApiAccount(server, String(login), password, name);
    await deployMetaApiAccount(account.id);
    return { id: account.id, region: account.region || null, recovered: false };
}

async function getDeals(accountId, region, fromTime, toTime) {
    const url = `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${accountId}/history-deals/time/${fromTime}/${toTime}`;
    try {
        const response = await fetch(url, {
            headers: { 'auth-token': METAAPI_TOKEN }
        });
        if (!response.ok) {
            const errText = await response.text();
            console.log(`[getDeals] HTTP ${response.status} for account ${accountId} region ${region}: ${errText.slice(0, 200)}`);
            return [];
        }
        const data = await response.json();
        if (!Array.isArray(data)) {
            console.log(`[getDeals] Unexpected response format for account ${accountId}:`, JSON.stringify(data).slice(0, 200));
            return [];
        }
        return data;
    } catch (e) {
        console.log(`[getDeals] Fetch error for account ${accountId}: ${e.message}`);
        return [];
    }
}

// =====================
// License codes
// =====================
const DEFAULT_TOKENS = 2;

// Validate license code against Supabase purchases table
async function isValidLicenseCode(code) {
    const { data } = await supabase
        .from('purchases')
        .select('license_code')
        .eq('license_code', code)
        .maybeSingle();
    return !!data;
}

// =====================
// User state
// =====================
const userStates = {};

// Idempotency set for IAP transactions (survives within process lifetime)
const processedIAPTransactions = new Set();

function initUser(userId) {
    if (!userStates[userId]) {
        userStates[userId] = {
            tradesCount: 0,
            isLocked: false,
            emergencyUnlocked: false,
            emergencyTokens: DEFAULT_TOKENS,
            lastReset: new Date().toISOString().split('T')[0],
            lastTokenReset: new Date().toISOString(),
            maxTrades: 1,
            // F4: Only count winning trades when true (profit > 0). Default false = count all closes.
            countWinningTrades: false,
            deviceToken: null,
            metaApiAccountId: null,
            mt5Connected: false,
            mt5Server: null,
            mt5Login: null,
            mt5Region: 'vint-hill',
            processedDealIds: new Set(),
            todayDeals: [],
            lastDealCheck: null,
        };
    }
}

function checkDailyReset(user, localDateStr) {
    // Use the client's local date if provided (so reset happens at user's local midnight)
    const today = localDateStr || new Date().toISOString().split('T')[0];
    if (user.lastReset !== today) {
        user.tradesCount = 0;
        user.isLocked = false;
        user.emergencyUnlocked = false;
        user.lastReset = today;
        user.processedDealIds = new Set();
        user.todayDeals = [];
    }
}

// Returns the UTC Date object for midnight Amsterdam time on the given date string ("YYYY-MM-DD").
// Determines the CET/CEST offset by sampling noon UTC on that day, which is always well
// away from DST transition boundaries (transitions happen at 02:00 Amsterdam, i.e. 00:00/01:00 UTC).
function getAmsterdamMidnight(dateStr) {
    const noon = new Date(dateStr + 'T12:00:00Z');
    const hourStr = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Amsterdam',
        hour: '2-digit',
        hour12: false,
    }).format(noon);
    const offsetHours = parseInt(hourStr, 10) - 12; // CEST=+2, CET=+1
    const midnight = new Date(dateStr + 'T00:00:00Z');
    midnight.setHours(midnight.getHours() - offsetHours);
    return midnight;
}

// Get day-of-week (0=Sun) and hour in Europe/Amsterdam, correct across CET/CEST transitions.
// Previous implementation hardcoded UTC+1, which drifted one hour during summer time (CEST).
function getAmsterdamDayHour(date) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Amsterdam',
        weekday: 'short',
        hour: '2-digit',
        hour12: false,
    }).formatToParts(date);
    const weekdayShort = parts.find(p => p.type === 'weekday')?.value ?? 'Mon';
    const hourStr = parts.find(p => p.type === 'hour')?.value ?? '0';
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    // Intl may return "24" for midnight in some locales; normalize.
    const hour = parseInt(hourStr, 10) % 24;
    return { day: dayMap[weekdayShort] ?? 0, hour };
}

function shouldResetWeeklyTokens(lastTokenReset) {
    // If we have no record of the last reset (e.g. after a server restart),
    // do NOT reset. initUser already starts with DEFAULT_TOKENS and the real
    // value is loaded from Supabase in the isNewUser block that follows.
    // Returning true here would overwrite Supabase with 2 before the restore runs.
    if (!lastTokenReset) return false;
    const now = new Date();
    const last = new Date(lastTokenReset);
    const nowAms = getAmsterdamDayHour(now);
    const lastAms = getAmsterdamDayHour(last);
    const isResetTime = nowAms.day === 0 && nowAms.hour >= 22;
    const wasBeforeReset = lastAms.day !== 0 || lastAms.hour < 22;
    const daysDiff = Math.floor((now - last) / (1000 * 60 * 60 * 24));
    return (isResetTime && daysDiff >= 1 && wasBeforeReset) || daysDiff >= 7;
}

function checkWeeklyTokenReset(user, userId) {
    if (shouldResetWeeklyTokens(user.lastTokenReset)) {
        user.emergencyTokens = DEFAULT_TOKENS;
        user.lastTokenReset = new Date().toISOString();
        // Persist reset — prefer userId (Apple IAP), fall back to licenseCode (legacy)
        if (userId) {
            saveTokensByUserId(userId, DEFAULT_TOKENS).catch(() => {});
        } else if (user.licenseCode) {
            saveTokens(user.licenseCode, DEFAULT_TOKENS).catch(() => {});
        }
    }
}

// =====================
// MetaApi trade polling
// =====================
async function checkUserTrades(userId) {
    const user = userStates[userId];
    if (!user) return;
    if (!user.mt5Connected) { console.log(`[trades] ${userId.slice(0,8)}: mt5Connected=false, skipping`); return; }
    if (!user.metaApiAccountId) { console.log(`[trades] ${userId.slice(0,8)}: no metaApiAccountId, skipping`); return; }

    checkDailyReset(user, new Date().toISOString().split('T')[0]);

    try {
        const accountInfo = await getMetaApiAccountInfo(user.metaApiAccountId);
        if (!accountInfo) {
            console.log(`[trades] ${userId.slice(0,8)}: MetaApi account not found (id: ${user.metaApiAccountId})`);
            return;
        }

        if (accountInfo.region) user.mt5Region = accountInfo.region;

        const isReady = accountInfo.state === 'DEPLOYED' &&
            (accountInfo.connectionStatus === 'CONNECTED' || accountInfo.connectionStatus === 'SYNCHRONIZING');

        console.log(`[trades] ${userId.slice(0,8)}: state=${accountInfo.state} status=${accountInfo.connectionStatus} region=${user.mt5Region} ready=${isReady}`);

        if (!isReady) return;

        // Incremental fetch: only pull deals since last successful check (with 60s overlap for safety).
        // Falls back to today-midnight on first run or after a daily reset.
        // Use Amsterdam midnight (not UTC) so the fetch window matches the daily reset boundary.
        const todayMidnight = getAmsterdamMidnight(user.lastReset);
        const now = new Date();

        let fromDate;
        if (!user.lastDealCheck) {
            // First poll after connecting or server restart.
            // Fetch all of today's deals to:
            // 1. Seed processedDealIds so the overlap window doesn't double-count.
            // 2. Rebuild todayDeals for the status display without incrementing tradesCount
            //    (tradesCount was already restored from Supabase).
            const seedDeals = await getDeals(user.metaApiAccountId, user.mt5Region, todayMidnight.toISOString(), now.toISOString());
            user.todayDeals = [];
            for (const deal of seedDeals) {
                user.processedDealIds.add(deal.id);
                const isTradeClose = deal.entryType === 'DEAL_ENTRY_OUT' || deal.entryType === 'DEAL_ENTRY_INOUT';
                if (!isTradeClose || deal.type === 'DEAL_TYPE_BALANCE') continue;
                const direction = deal.type === 'DEAL_TYPE_SELL' ? 'Long' : 'Short';
                user.todayDeals.push({
                    symbol: deal.symbol || '',
                    direction,
                    price: deal.price ?? null,
                    profit: deal.profit ?? null,
                });
            }
            user.lastDealCheck = now.toISOString();
            console.log(`[trades] ${userId.slice(0,8)}: first check — seeded ${seedDeals.length} deals, rebuilt ${user.todayDeals.length} todayDeals`);
            return;
        }

        if (user.lastDealCheck) {
            const lastCheck = new Date(user.lastDealCheck);
            // 60s overlap to catch deals that arrived during the previous poll window
            const overlapped = new Date(lastCheck.getTime() - 60 * 1000);
            // Never go earlier than today-midnight (daily reset boundary)
            fromDate = overlapped > todayMidnight ? overlapped : todayMidnight;
        }

        const fromTime = fromDate.toISOString();
        const toTime = now.toISOString();

        const deals = await getDeals(user.metaApiAccountId, user.mt5Region, fromTime, toTime);

        console.log(`[trades] ${userId.slice(0,8)}: fetched ${deals.length} deals from ${fromTime} to ${toTime}`);
        if (deals.length > 0) {
            console.log(`[trades] ${userId.slice(0,8)}: deal types:`, deals.map(d => `${d.id} ${d.entryType} ${d.type} profit=${d.profit}`).join(' | '));
        }

        let newTradesDetected = false;

        for (const deal of deals) {
            if (user.processedDealIds.has(deal.id)) continue;

            // Count on close only (DEAL_ENTRY_OUT closes an existing position,
            // DEAL_ENTRY_INOUT closes and immediately reverses in one step)
            const isTradeClose = deal.entryType === 'DEAL_ENTRY_OUT' || deal.entryType === 'DEAL_ENTRY_INOUT';
            if (!isTradeClose) continue;

            // Balance/deposit entries are never real trades
            if (deal.type === 'DEAL_TYPE_BALANCE') continue;

            user.processedDealIds.add(deal.id);

            // F4: countWinningTrades — skip losing/breakeven trades when enabled.
            // profit null = no financial data (e.g. crypto deals), counted as a trade.
            const dealProfit = deal.profit ?? null;
            const isWin = dealProfit !== null && dealProfit > 0;
            if (user.countWinningTrades && dealProfit !== null && !isWin) {
                // Mark processed so the overlap window does not recheck it, but do not increment.
                const direction = deal.type === 'DEAL_TYPE_SELL' ? 'Long' : 'Short';
                user.todayDeals.push({
                    symbol: deal.symbol || '',
                    direction,
                    price: deal.price ?? null,
                    profit: dealProfit,
                });
                continue;
            }

            user.tradesCount++;
            newTradesDetected = true;

            // Store trade details for today's overview in the status response.
            // direction: closing SELL deal = was Long position, closing BUY deal = was Short.
            const direction = deal.type === 'DEAL_TYPE_SELL' ? 'Long' : 'Short';
            if (!user.todayDeals) user.todayDeals = [];
            user.todayDeals.push({
                symbol: deal.symbol || '',
                direction,
                price: deal.price ?? null,
                profit: deal.profit ?? null,
            });

            // Persist updated count to Supabase so a server restart doesn't reset it mid-day
            saveDailyTrades(userId, user.tradesCount, user.lastReset).catch(() => {});

            console.log(`User ${userId}: trade close counted. Total: ${user.tradesCount}/${user.maxTrades} (deal ${deal.id} profit=${deal.profit})`);
        }

        if (newTradesDetected && user.tradesCount >= user.maxTrades && !user.isLocked) {
            user.isLocked = true;
            debugLog(`User ${userId}: trade limit reached, sending push`);
            await sendPushNotification(
                user.deviceToken,
                '🔒 EmotionLock activated',
                `You've reached your limit of ${user.maxTrades} trade${user.maxTrades > 1 ? 's' : ''} today. Trading apps are now blocked.`
            );
        }

        user.lastDealCheck = new Date().toISOString();

    } catch (err) {
        console.error(`Error checking trades for user ${userId}:`, err.message);
    }
}

// Poll every 15 seconds
setInterval(async () => {
    for (const userId of Object.keys(userStates)) {
        await checkUserTrades(userId);
    }
}, 15000);

// =====================
// Routes
// =====================

// PUBLIC ROUTE: health check — no auth needed, returns no sensitive data
app.get('/', (req, res) => {
    res.json({ status: 'EmotionLock backend running' });
});

// PUBLIC ROUTE: license activation — validates licenseCode against Supabase, no session needed
app.post('/activate', async (req, res) => {
    try {
    const { licenseCode } = req.body;
    if (!licenseCode) return res.status(400).json({ error: 'licenseCode required' });

    const key = String(licenseCode).slice(0, 50).toUpperCase().trim();
    if (key.length < 5) return res.status(400).json({ error: 'Invalid license code format' });

    // Validate against Supabase — works after every server restart
    const valid = await isValidLicenseCode(key);
    if (!valid) return res.status(404).json({ error: 'Invalid license code' });

    initUser(key);
    userStates[key].licenseCode = key;

    // Load persistent token count from Supabase (survives server restarts)
    const storedTokens = await getStoredTokens(key);
    if (storedTokens !== null) {
        userStates[key].emergencyTokens = storedTokens;
        console.log(`Restored ${storedTokens} tokens from Supabase for ${key}`);
    } else {
        // First time: save the default to Supabase
        await saveTokens(key, userStates[key].emergencyTokens);
    }

    // Restore MT5 connection from Supabase if available
    const { data: purchase } = await supabase
        .from('purchases')
        .select('meta_api_account_id, mt5_server, mt5_login, max_trades')
        .eq('license_code', key)
        .maybeSingle();

    if (purchase?.meta_api_account_id) {
        userStates[key].metaApiAccountId = purchase.meta_api_account_id;
        if (purchase?.mt5_server) {
            userStates[key].mt5Server = purchase.mt5_server;
            userStates[key].mt5Login = purchase.mt5_login;
            userStates[key].mt5Connected = true;
            debugLog(`Restored MT5 connection for user`);
        }
    }
    if (purchase?.max_trades) userStates[key].maxTrades = purchase.max_trades;

    console.log(`License activated: ${key}`);
    res.json({ success: true, userId: key });
    } catch (err) {
        console.error('Activate error:', err.message);
        res.status(500).json({ error: 'Failed to activate license. Please try again.' });
    }
});

const connectMt5Schema = z.object({
    server:   z.string().min(1).max(100),
    login:    z.union([z.string().min(1).max(20), z.number().int().positive()]),
    password: z.string().min(1).max(128),
});

// PUBLIC ROUTE: MT5 connect — no session auth, but requires a valid userId (licenseCode) in userStates.
//               Rate-limited to 10 requests/hour per IP. Credentials are forwarded to MetaApi only.
app.post('/connect-mt5/:userId', mt5Limiter, async (req, res) => {
    const { userId } = req.params;

    const parsed = connectMt5Schema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid input.', details: parsed.error.issues.map(i => i.message) });
    }
    const { server, login, password } = parsed.data;

    if (!userStates[userId]) {
        return res.status(404).json({ error: 'User not found. Activate your license first.' });
    }

    try {
        // Check Supabase for an existing MetaAPI account for this user
        const { data: savedAccount } = await supabase
            .from('purchases')
            .select('meta_api_account_id, mt5_server, mt5_login')
            .eq('user_id', userId)
            .maybeSingle();

        const existingMetaApiId = savedAccount?.meta_api_account_id || userStates[userId].metaApiAccountId;
        // Fall back to in-memory state when the Supabase row isn't populated yet.
        // Without this, every reconnect creates a new MetaAPI account.
        const existingServer = savedAccount?.mt5_server ?? userStates[userId].mt5Server;
        const existingLogin  = savedAccount?.mt5_login  ?? userStates[userId].mt5Login;
        const isSameAccount = existingMetaApiId &&
            existingServer?.trim() === server.trim() &&
            existingLogin === String(login);

        let accountId;
        let accountRegion = null;
        if (isSameAccount) {
            // Same server + login: redeploy the existing account, no new account needed.
            // If the account was manually deleted in MetaAPI, fall through and create a fresh one.
            const info = await getMetaApiAccountInfo(existingMetaApiId);
            if (info) {
                console.log(`Reusing existing MetaAPI account for user ${userId}`);
                accountId = existingMetaApiId;
                await deployMetaApiAccount(accountId);
                if (info.region) accountRegion = info.region;
            } else {
                console.log(`Existing MetaAPI account not found, creating or recovering for user ${userId}`);
                const result = await createOrRecoverMetaApiAccount(server, String(login), password, userId);
                accountId = result.id;
                accountRegion = result.region;
            }
        } else {
            // Different account: delete old (if any), then create or recover via safety net.
            // The safety net protects against orphans when Supabase + in-memory are both empty
            // (server restart with stale data) so we never create a duplicate MetaAPI account.
            if (existingMetaApiId) {
                try {
                    await undeployAndDeleteMetaApiAccount(existingMetaApiId);
                } catch (e) {
                    console.log('Cleanup old account warning:', e.message);
                }
            }
            console.log(`Creating or recovering MetaAPI account for user ${userId} on ${server}...`);
            const result = await createOrRecoverMetaApiAccount(server, String(login), password, userId);
            accountId = result.id;
            accountRegion = result.region;
        }

        userStates[userId].metaApiAccountId = accountId;
        userStates[userId].mt5Server = server;
        userStates[userId].mt5Login = String(login);
        userStates[userId].mt5Connected = true;
        // Only clear the processed-deal log when switching to a different account.
        // Keeping it for same-account reconnects prevents today's closes from being double-counted.
        if (!isSameAccount) {
            userStates[userId].processedDealIds = new Set();
            userStates[userId].tradesCount = 0;
            saveDailyTrades(userId, 0, userStates[userId].lastReset).catch(() => {});
        }
        if (accountRegion) userStates[userId].mt5Region = accountRegion;
        console.log(`MT5 connected for user ${userId.slice(0,8)}: accountId=${accountId} region=${accountRegion || 'unknown (will detect on first poll)'}`);

        // Persist MT5 connection to Supabase so it survives server restarts
        const { error: mt5SaveErr } = await supabase.from('purchases').update({
            meta_api_account_id: accountId,
            mt5_server: server,
            mt5_login: String(login),
        }).eq('user_id', userId);
        if (mt5SaveErr) console.error(`Failed to persist MT5 for ${userId}:`, mt5SaveErr.message);

        debugLog(`MT5 connected for user ${userId}`);
        res.json({
            success: true,
            message: 'Connecting... it may take a few minutes to fully sync.'
        });

    } catch (err) {
        console.error(`MT5 connect error for ${userId}:`, err.message);
        res.status(500).json({ error: 'Failed to connect MT5 account. Please try again.' });
    }
});

// Disconnect MT5 account
app.delete('/connect-mt5/:userId', async (req, res) => {
    const { userId } = req.params;
    const user = userStates[userId];

    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.metaApiAccountId) return res.status(400).json({ error: 'No MT5 account connected' });

    try {
        // Undeploy only — keep the MetaAPI account so it can be reused on reconnect
        await undeployMetaApiAccount(user.metaApiAccountId);
        user.mt5Connected = false;
        user.mt5Server = null;
        user.mt5Login = null;
        // Keep meta_api_account_id, mt5_server, mt5_login in Supabase so reconnect can reuse the account

        console.log(`MT5 disconnected for user ${userId}`);
        res.json({ success: true });
    } catch (err) {
        console.error(`MT5 disconnect error for ${userId}:`, err.message);
        res.status(500).json({ error: 'Failed to disconnect MT5 account. Please try again.' });
    }
});

// UUID v4 regex used to validate userId before writing to Supabase (F5)
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// PUBLIC ROUTE: status polling — called by the iOS app every 5s. UserId is the Keychain UUID
//               (non-guessable). Returns only non-sensitive trade state.
app.get('/status/:userId', statusLimiter, async (req, res) => {
    try {
        const { userId } = req.params;
        const localDate = req.headers['x-local-date'] || null;
        const isNewUser = !userStates[userId];
        initUser(userId);
        const user = userStates[userId];
        checkDailyReset(user, localDate);

        // On first contact or server restart, sync state with Supabase.
        // checkWeeklyTokenReset runs AFTER this block so it sees the correct
        // persisted token count, not the default value from initUser.
        if (isNewUser) {
            // Two separate queries so a missing column never blocks MT5 restoration.
            const { data: purchase, error: purchaseErr } = await supabase
                .from('purchases')
                .select('meta_api_account_id, mt5_server, mt5_login, max_trades, emergency_tokens_remaining, count_winning_trades')
                .eq('user_id', userId)
                .maybeSingle();

            if (purchaseErr) {
                console.error(`[status] Supabase query failed for ${userId}:`, purchaseErr.message);
            }

            if (!purchase && !purchaseErr) {
                // No row exists yet for this userId. This happens for every new Apple IAP customer
                // because purchases rows are not automatically created on first use.
                // F5: Only create the row when userId is a valid UUID v4 (format used by KeychainHelper).
                // This prevents random-string probes from polluting the purchases table.
                if (!UUID_V4_RE.test(userId)) {
                    return res.status(400).json({ error: 'Invalid userId format.' });
                }
                const { error: createErr } = await supabase
                    .from('purchases')
                    .insert({
                        user_id: userId,
                        emergency_tokens_remaining: DEFAULT_TOKENS,
                        daily_trades_count: 0,
                        max_trades: user.maxTrades,
                    });
                if (createErr) {
                    console.error(`[status] Could not create purchases row for ${userId}:`, createErr.message);
                } else {
                    console.log(`[status] Auto-created purchases row for new user ${userId}`);
                }
            }

            if (purchase?.emergency_tokens_remaining != null) {
                user.emergencyTokens = purchase.emergency_tokens_remaining;
            }

            if (purchase?.meta_api_account_id) {
                user.metaApiAccountId = purchase.meta_api_account_id;
                if (purchase.mt5_server) {
                    user.mt5Server = purchase.mt5_server;
                    user.mt5Login = purchase.mt5_login;
                    user.mt5Connected = true;
                    console.log(`[status] Restored MT5 connection for ${userId}`);
                    deployMetaApiAccount(purchase.meta_api_account_id).catch(e =>
                        console.log(`[status] Redeploy warning for ${userId}:`, e.message)
                    );
                }
            }
            if (purchase?.max_trades) user.maxTrades = purchase.max_trades;
            // F4: Restore countWinningTrades preference from Supabase
            if (purchase?.count_winning_trades != null) user.countWinningTrades = purchase.count_winning_trades;

            // Restore today's trade count (separate query — daily_trades columns added later).
            const todayISO = localDate || new Date().toISOString().split('T')[0];
            const { data: tradeData } = await supabase
                .from('purchases')
                .select('daily_trades_count, daily_trades_date')
                .eq('user_id', userId)
                .maybeSingle();

            if (tradeData?.daily_trades_date === todayISO && tradeData?.daily_trades_count > 0) {
                user.tradesCount = tradeData.daily_trades_count;
                user.lastReset = todayISO;
                if (user.tradesCount >= user.maxTrades) {
                    user.isLocked = true;
                }
                console.log(`[status] Restored ${tradeData.daily_trades_count} trades for ${userId} (date: ${todayISO})`);
            }
        }

        // Run weekly reset after Supabase restore so we compare against the real
        // persisted token count, not the initUser default.
        checkWeeklyTokenReset(user, userId);

        res.json({
            tradesCount: user.tradesCount,
            isLocked: user.isLocked,
            emergencyUnlocked: user.emergencyUnlocked,
            emergencyTokens: user.emergencyTokens,
            mt5Connected: user.mt5Connected,
            mt5Server: user.mt5Server ?? null,
            mt5Login: user.mt5Login ?? null,
            maxTrades: user.maxTrades,
            countWinningTrades: user.countWinningTrades ?? false,
            todayDeals: user.todayDeals ?? [],
        });
    } catch (err) {
        console.error(`Status error for ${req.params.userId}:`, err.message);
        res.status(500).json({ error: 'Failed to fetch status. Please try again.' });
    }
});

const settingsSchema = z.object({
    maxTrades: z.number().int().min(1).max(10).optional(),
    // F4: When true, only winning trades (profit > 0) count toward the daily limit.
    countWinningTrades: z.boolean().optional(),
});

// PUBLIC ROUTE: user settings — called by iOS app. UserId is the Keychain UUID (non-guessable).
app.post('/settings/:userId', (req, res) => {
    try {
        const { userId } = req.params;

        const parsed = settingsSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ error: 'Invalid input.', details: parsed.error.issues.map(i => i.message) });
        }
        const { maxTrades, countWinningTrades } = parsed.data;

        if (!userStates[userId]) {
            initUser(userId);
        }
        const user = userStates[userId];

        if (maxTrades !== undefined && maxTrades !== user.maxTrades) {
            // Initial setup: free when the backend still has the factory default (1),
            // the user has no trades today, and tokens are untouched.
            // This covers onboarding after a fresh install — not an impulsive mid-day change.
            const isInitialSetup = user.maxTrades === 1
                && user.tradesCount === 0
                && user.emergencyTokens === DEFAULT_TOKENS;

            if (!isInitialSetup) {
                // Any other change to the trade limit costs 1 emergency token — up or down.
                // This prevents gaming the system by quietly lowering the limit mid-day.
                checkWeeklyTokenReset(user, userId);
                if (user.emergencyTokens <= 0) {
                    return res.status(400).json({
                        error: 'no_tokens',
                        message: 'No emergency tokens left. You cannot change your trade limit.',
                        isLocked: user.isLocked,
                        emergencyTokens: user.emergencyTokens,
                    });
                }
                user.emergencyTokens -= 1;
                saveTokensByUserId(userId, user.emergencyTokens).catch(() => {});
            }

            const wasLocked = user.isLocked;
            user.maxTrades = maxTrades;

            // Re-evaluate lock state after the change
            if (user.tradesCount >= user.maxTrades) {
                user.isLocked = true;
                user.emergencyUnlocked = false;
            } else if (wasLocked) {
                // Limit raised high enough to lift the lock
                user.isLocked = false;
                user.emergencyUnlocked = true;
            }
            debugLog(`User ${userId}: maxTrades changed to ${maxTrades}, token used. Tokens left: ${user.emergencyTokens}`);
        }

        // F4: countWinningTrades toggle — free to change, no token cost.
        if (countWinningTrades !== undefined && countWinningTrades !== user.countWinningTrades) {
            user.countWinningTrades = countWinningTrades;
            debugLog(`User ${userId}: countWinningTrades set to ${countWinningTrades}`);
        }

        // Persist settings to Supabase so they survive server restarts
        supabase.from('purchases').update({
            max_trades: user.maxTrades,
            count_winning_trades: user.countWinningTrades,
        }).eq('user_id', userId).then(() => {}).catch(() => {});

        res.json({
            success: true,
            maxTrades: user.maxTrades,
            isLocked: user.isLocked,
            emergencyTokens: user.emergencyTokens,
            emergencyUnlocked: user.emergencyUnlocked,
            countWinningTrades: user.countWinningTrades,
        });
    } catch (err) {
        console.error(`Settings error for ${req.params.userId}:`, err.message);
        res.status(500).json({ error: 'Failed to update settings.' });
    }
});

// PUBLIC ROUTE: emergency unlock — rate-limited to 5/hour per IP. UserId is the Keychain UUID.
app.post('/unlock/:userId', unlockLimiter, async (req, res) => {
    try {
        const { userId } = req.params;
        if (!userStates[userId]) {
            return res.status(404).json({ error: 'User not found. Open the app first.' });
        }
        const user = userStates[userId];
        checkWeeklyTokenReset(user, userId);
        if (user.emergencyTokens <= 0) {
            return res.status(400).json({ error: 'No tokens available' });
        }
        user.tradesCount = Math.max(0, user.tradesCount - 1);
        user.isLocked = false;
        user.emergencyTokens -= 1;
        // Persist new token count to Supabase so server restarts don't reset it
        await saveTokensByUserId(userId, user.emergencyTokens);
        debugLog(`User ${userId}: emergency unlock. tradesCount: ${user.tradesCount}, tokens left: ${user.emergencyTokens}`);
        res.json({ success: true, isLocked: false, tradesCount: user.tradesCount, emergencyTokens: user.emergencyTokens });
    } catch (err) {
        console.error(`Unlock error for ${req.params.userId}:`, err.message);
        res.status(500).json({ error: 'Failed to process unlock. Please try again.' });
    }
});

// PUBLIC ROUTE: device token registration — called on app launch. UserId is the Keychain UUID.
app.post('/register-device/:userId', (req, res) => {
    const { userId } = req.params;
    const { deviceToken } = req.body;
    if (!deviceToken) return res.status(400).json({ error: 'deviceToken required' });
    initUser(userId);
    userStates[userId].deviceToken = deviceToken;
    console.log(`User ${userId}: device token registered`);
    res.json({ success: true });
});

// Token purchases removed — emergency tokens are free (2 per week, included with subscription)
app.post('/add-tokens-iap/:userId', (req, res) => {
    res.status(410).json({ error: 'Token purchases are no longer available.' });
});

// Admin: inspect live user state (trade counting debug)
app.get('/admin/user-state/:userId', async (req, res) => {
    const adminKey = req.headers['x-admin-key'];
    if (!isValidAdminKey(adminKey)) return res.status(401).json({ error: 'Unauthorized' });

    const { userId } = req.params;
    const user = userStates[userId];
    if (!user) return res.json({ exists: false, knownUsers: Object.keys(userStates).map(k => k.slice(0, 8)) });

    // Also fetch live MetaAPI account info
    let accountInfo = null;
    if (user.metaApiAccountId) {
        accountInfo = await getMetaApiAccountInfo(user.metaApiAccountId).catch(() => null);
    }

    res.json({
        exists: true,
        mt5Connected: user.mt5Connected,
        metaApiAccountId: user.metaApiAccountId,
        mt5Region: user.mt5Region,
        mt5Server: user.mt5Server,
        mt5Login: user.mt5Login,
        tradesCount: user.tradesCount,
        maxTrades: user.maxTrades,
        isLocked: user.isLocked,
        lastDealCheck: user.lastDealCheck,
        processedDealIds: [...(user.processedDealIds || [])],
        metaApiAccountInfo: accountInfo ? {
            state: accountInfo.state,
            connectionStatus: accountInfo.connectionStatus,
            region: accountInfo.region,
        } : null,
    });
});

// Admin: manually trigger trade check for a user
app.post('/admin/check-trades/:userId', async (req, res) => {
    const adminKey = req.headers['x-admin-key'];
    if (!isValidAdminKey(adminKey)) return res.status(401).json({ error: 'Unauthorized' });

    const { userId } = req.params;
    if (!userStates[userId]) return res.status(404).json({ error: 'User not in memory' });

    await checkUserTrades(userId);
    const user = userStates[userId];
    res.json({ tradesCount: user.tradesCount, isLocked: user.isLocked, lastDealCheck: user.lastDealCheck });
});

// Admin: list all MetaAPI accounts for cleanup inspection
app.get('/admin/metaapi-accounts', async (req, res) => {
    const adminKey = req.headers['x-admin-key'];
    if (!isValidAdminKey(adminKey)) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const response = await fetch(`${PROVISIONING_API}/users/current/accounts`, {
            headers: { 'auth-token': METAAPI_TOKEN }
        });
        if (!response.ok) return res.status(500).json({ error: 'MetaAPI request failed' });
        const accounts = await response.json();
        res.json(accounts.map(a => ({
            id: a.id,
            name: a.name,
            login: a.login,
            server: a.server,
            state: a.state,
            connectionStatus: a.connectionStatus,
            region: a.region,
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin: delete a specific MetaAPI account by id
app.delete('/admin/metaapi-accounts/:accountId', async (req, res) => {
    const adminKey = req.headers['x-admin-key'];
    if (!isValidAdminKey(adminKey)) return res.status(401).json({ error: 'Unauthorized' });

    const { accountId } = req.params;
    try {
        await undeployAndDeleteMetaApiAccount(accountId);
        res.json({ success: true, deleted: accountId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin: generate (or register) license code (called by website after purchase)
// Note: license codes are stored in Supabase purchases table — this endpoint is kept
// for backward compatibility but the website handles Supabase insertion directly.
app.post('/admin/generate-code', async (req, res) => {
    const adminKey = req.headers['x-admin-key'];
    if (!isValidAdminKey(adminKey)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    // Accept a custom code from the website, or generate one
    let code = req.body && req.body.code;
    if (!code) {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        const rand = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
        code = `EL-${rand(4)}-${rand(4)}`;
    }

    // Also insert into Supabase in case the website didn't handle it
    const { error } = await supabase.from('purchases').upsert(
        { license_code: code, emergency_tokens_remaining: DEFAULT_TOKENS },
        { onConflict: 'license_code', ignoreDuplicates: true }
    );
    if (error) console.log('Supabase upsert warning:', error.message);

    console.log(`License code registered: ${code}`);
    res.json({ success: true, code });
});

// Admin: add emergency tokens to a license — kept for backward compat but token purchases
// are no longer available (F2: removed licenseCodes dead code that caused ReferenceError crashes).
app.post('/admin/add-tokens/:licenseCode', (req, res) => {
    const adminKey = req.headers['x-admin-key'];
    if (!isValidAdminKey(adminKey)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    // Token purchases are removed. Emergency tokens are free (2/week with subscription).
    res.status(410).json({ error: 'Token purchases are no longer available.' });
});

// Admin: list active in-memory user states (UUIDs + key fields, no passwords)
app.get('/admin/user-states', (req, res) => {
    const adminKey = req.headers['x-admin-key'];
    if (!isValidAdminKey(adminKey)) return res.status(401).json({ error: 'Unauthorized' });

    const states = Object.entries(userStates).map(([id, u]) => ({
        userId: id,
        mt5Connected: u.mt5Connected,
        mt5Server: u.mt5Server,
        mt5Login: u.mt5Login,
        tradesCount: u.tradesCount,
        maxTrades: u.maxTrades,
        isLocked: u.isLocked,
        emergencyTokens: u.emergencyTokens,
        lastReset: u.lastReset,
    }));
    res.json({ count: states.length, users: states });
});

// Admin: patch tokens and/or maxTrades for a UUID directly in Supabase + memory
app.post('/admin/fix-user/:userId', async (req, res) => {
    const adminKey = req.headers['x-admin-key'];
    if (!isValidAdminKey(adminKey)) return res.status(401).json({ error: 'Unauthorized' });

    const { userId } = req.params;
    const { tokens, maxTrades } = req.body;

    const updates = {};
    if (tokens !== undefined) updates.emergency_tokens_remaining = tokens;
    if (maxTrades !== undefined) updates.max_trades = maxTrades;

    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'Provide at least one of: tokens, maxTrades' });
    }

    const { error } = await supabase.from('purchases').update(updates).eq('user_id', userId);
    if (error) return res.status(500).json({ error: error.message });

    // Also patch in-memory state if user is active
    if (userStates[userId]) {
        if (tokens !== undefined) userStates[userId].emergencyTokens = tokens;
        if (maxTrades !== undefined) userStates[userId].maxTrades = maxTrades;
    }

    res.json({ success: true, userId, applied: updates });
});

// Reset operational state after a fresh install / re-onboarding.
// Called by the iOS app the first time the user completes onboarding after a
// (re)install. The Keychain userId survives app deletion (by design, for
// license recovery), which means a re-installer would otherwise inherit stale
// MT5 connections, tradesCount and maxTrades from their previous session.
//
// This endpoint resets only OPERATIONAL state. License and subscription rows
// in Supabase are intentionally left untouched so existing entitlements
// (mt5license + monthly) keep working without a restore flow.
app.post('/reset-after-onboarding/:userId', async (req, res) => {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    // F1: Require the caller to echo the userId in the request body.
    // This proves possession of the userId at both the URL and body level,
    // preventing passive observers who only see the path from triggering a reset.
    const { confirm } = req.body ?? {};
    if (!confirm || confirm !== userId) {
        return res.status(403).json({ error: 'Forbidden: confirm field must match userId.' });
    }

    const rawMax = req.body?.maxTrades;
    const maxTrades = Number.isInteger(rawMax) ? rawMax : parseInt(rawMax, 10);
    if (!Number.isFinite(maxTrades) || maxTrades < 1 || maxTrades > 50) {
        return res.status(400).json({ error: 'maxTrades must be an integer between 1 and 50' });
    }

    try {
        // 1) Tear down any existing MetaAPI account so we don't pay for an
        //    orphan. Use full delete (not just undeploy) since the user is
        //    starting fresh and may pick a different broker.
        const existing = userStates[userId];
        if (existing?.metaApiAccountId) {
            try {
                await undeployAndDeleteMetaApiAccount(existing.metaApiAccountId);
            } catch (e) {
                console.log(`MT5 cleanup on reset for ${userId}:`, e.message);
            }
        }

        // 2) Reset in-memory state to a clean slate. Re-init via initUser so we
        //    get the same shape any other endpoint expects, then overwrite the
        //    user-supplied fields.
        delete userStates[userId];
        initUser(userId);
        const user = userStates[userId];
        user.maxTrades = maxTrades;
        user.emergencyTokens = DEFAULT_TOKENS;
        user.lastTokenReset = new Date().toISOString();

        // 3) Persist the operational columns in Supabase. License/subscription
        //    columns (has_license, etc.) are intentionally NOT touched.
        const { error } = await supabase.from('purchases').update({
            meta_api_account_id: null,
            mt5_server: null,
            mt5_login: null,
            max_trades: maxTrades,
            emergency_tokens_remaining: DEFAULT_TOKENS,
        }).eq('user_id', userId);

        if (error) {
            console.error(`Reset Supabase update failed for ${userId}:`, error.message);
            // Don't fail the whole request — in-memory state is already correct
            // and the next /status poll will re-persist what it can.
        }

        console.log(`Reset after onboarding for ${userId}: maxTrades=${maxTrades}`);
        res.json({
            success: true,
            userId,
            maxTrades,
            emergencyTokens: DEFAULT_TOKENS,
            tradesCount: 0,
            isLocked: false,
            mt5Connected: false,
        });
    } catch (err) {
        console.error(`Reset after onboarding error for ${userId}:`, err.message);
        res.status(500).json({ error: 'Reset failed. Please try again.' });
    }
});

// Save user profile (collected after MT5 license purchase in the app)
// Public endpoint — auth is the userId itself (UUID from Keychain, same pattern as all other user endpoints)
app.post('/profile/:userId', async (req, res) => {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    const { firstName, lastName, email } = req.body ?? {};

    if (!firstName || typeof firstName !== 'string' || firstName.trim().length < 1) {
        return res.status(400).json({ error: 'firstName is required' });
    }
    if (!lastName || typeof lastName !== 'string' || lastName.trim().length < 1) {
        return res.status(400).json({ error: 'lastName is required' });
    }
    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
        return res.status(400).json({ error: 'A valid email address is required' });
    }

    try {
        const { error } = await supabase.from('profiles').upsert(
            {
                user_id:    userId,
                first_name: firstName.trim(),
                last_name:  lastName.trim(),
                email:      email.trim().toLowerCase(),
                updated_at: new Date().toISOString(),
            },
            { onConflict: 'user_id' }
        );

        if (error) {
            console.error('[profile] Supabase upsert error:', error.message);
            return res.status(500).json({ error: 'Failed to save profile. Please try again.' });
        }

        console.log(`[profile] Saved profile for user ${userId}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[profile] Unexpected error:', err);
        res.status(500).json({ error: 'Unexpected error. Please try again.' });
    }
});

// Delete account — required by Apple App Store policy
app.delete('/delete-account/:userId', async (req, res) => {
    const { userId } = req.params;

    if (!userStates[userId]) {
        return res.status(404).json({ error: 'User not found. Open the app first.' });
    }

    const user = userStates[userId];

    try {
        // Disconnect MT5 if connected
        if (user?.metaApiAccountId) {
            try {
                await undeployAndDeleteMetaApiAccount(user.metaApiAccountId);
            } catch (e) {
                console.log(`MT5 cleanup on account delete for ${userId}:`, e.message);
            }
        }

        // Clear from in-memory state
        delete userStates[userId];

        // Clear all user data from Supabase — match on user_id (UUID from Keychain)
        await supabase.from('purchases').update({
            meta_api_account_id: null,
            mt5_server: null,
            mt5_login: null,
            emergency_tokens_remaining: null,
            emergency_tokens_purchased: null,
        }).eq('user_id', userId);

        // Also remove profile data (GDPR compliance)
        await supabase.from('profiles').delete().eq('user_id', userId);

        console.log(`Account deleted for user ${userId}`);
        res.json({ success: true });
    } catch (err) {
        console.error(`Delete account error for ${userId}:`, err.message);
        res.status(500).json({ error: 'Failed to delete account. Please try again.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`EmotionLock backend running on port ${PORT}`);
});

// =====================
// Scout Agents — scrape Reddit and X for marketing opportunities
// =====================

const SCOUT_SUBREDDITS = [
    'Forex',
    'Daytrading',
    'algotrading',
    'Trading',
    'Futures',
    'StockMarket',
];

const SCOUT_KEYWORDS = [
    'revenge trading',
    'overtrading',
    'emotional',
    'tilt',
    'broke my rules',
    'cant stop trading',
    "can't stop trading",
    'trading addiction',
    'discipline',
    'lost control',
    'emotional trading',
    'trading psychology',
];

async function redditScout() {
    console.log('[Scout] Reddit scan starting...');
    let totalFound = 0;

    for (const sub of SCOUT_SUBREDDITS) {
        try {
            const url = `https://www.reddit.com/r/${sub}/new.json?limit=50`;
            const res = await fetch(url, {
                headers: { 'User-Agent': 'EmotionLock-Scout/1.0' },
                signal: AbortSignal.timeout(10000),
            });

            if (!res.ok) {
                console.log(`[Scout] Reddit r/${sub}: HTTP ${res.status}`);
                continue;
            }

            const json = await res.json();
            const posts = json?.data?.children ?? [];

            for (const child of posts) {
                const post = child.data;
                const text = `${post.title ?? ''} ${post.selftext ?? ''}`.toLowerCase();

                const matched = SCOUT_KEYWORDS.filter(kw => text.includes(kw.toLowerCase()));
                if (matched.length === 0) continue;

                const postUrl = `https://www.reddit.com${post.permalink}`;

                // Check if already saved
                const { data: existing } = await supabase
                    .from('opportunities')
                    .select('id')
                    .eq('url', postUrl)
                    .maybeSingle();

                if (existing) continue;

                await supabase.from('opportunities').insert({
                    platform: 'reddit',
                    author: post.author ?? 'unknown',
                    content: `${post.title}\n\n${post.selftext ?? ''}`.slice(0, 2000),
                    url: postUrl,
                    engagement: (post.score ?? 0) + (post.num_comments ?? 0),
                    keywords_matched: matched,
                    status: 'new',
                    subreddit: sub,
                    found_at: new Date().toISOString(),
                });

                totalFound++;
            }
        } catch (err) {
            console.error(`[Scout] Reddit r/${sub} error:`, err.message);
        }
    }

    console.log(`[Scout] Reddit scan done. Found ${totalFound} new opportunities.`);
    return totalFound;
}

async function twitterScout() {
    // NOTE: Discord Scout requires being in servers manually.
    // Add Discord opportunities manually or via a bot token in trading-focused servers.
    const bearerToken = process.env.TWITTER_BEARER_TOKEN;
    if (!bearerToken) {
        console.log('[Scout] TWITTER_BEARER_TOKEN not set, skipping X scout.');
        return 0;
    }

    console.log('[Scout] X/Twitter scan starting...');
    let totalFound = 0;

    try {
        const query = SCOUT_KEYWORDS.slice(0, 5).map(kw => `"${kw}"`).join(' OR ');
        const encodedQuery = encodeURIComponent(`(${query}) lang:en -is:retweet`);
        const url = `https://api.twitter.com/2/tweets/search/recent?query=${encodedQuery}&max_results=20&tweet.fields=author_id,created_at,public_metrics,text&expansions=author_id&user.fields=username`;

        const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${bearerToken}` },
            signal: AbortSignal.timeout(10000),
        });

        if (!res.ok) {
            const errText = await res.text();
            console.log(`[Scout] X API HTTP ${res.status}: ${errText.slice(0, 200)}`);
            return 0;
        }

        const json = await res.json();
        const tweets = json?.data ?? [];
        const users = {};
        for (const u of json?.includes?.users ?? []) {
            users[u.id] = u.username;
        }

        for (const tweet of tweets) {
            const text = tweet.text.toLowerCase();
            const matched = SCOUT_KEYWORDS.filter(kw => text.includes(kw.toLowerCase()));
            if (matched.length === 0) continue;

            const username = users[tweet.author_id] ?? 'unknown';
            const tweetUrl = `https://twitter.com/${username}/status/${tweet.id}`;

            const { data: existing } = await supabase
                .from('opportunities')
                .select('id')
                .eq('url', tweetUrl)
                .maybeSingle();

            if (existing) continue;

            const metrics = tweet.public_metrics ?? {};
            const engagement = (metrics.like_count ?? 0) + (metrics.retweet_count ?? 0) + (metrics.reply_count ?? 0);

            await supabase.from('opportunities').insert({
                platform: 'x',
                author: username,
                content: tweet.text.slice(0, 2000),
                url: tweetUrl,
                engagement,
                keywords_matched: matched,
                status: 'new',
                subreddit: null,
                found_at: new Date().toISOString(),
            });

            totalFound++;
        }
    } catch (err) {
        console.error('[Scout] X error:', err.message);
    }

    console.log(`[Scout] X scan done. Found ${totalFound} new opportunities.`);
    return totalFound;
}

// Reddit scout runs every 30 minutes
setInterval(redditScout, 30 * 60 * 1000);

// X scout runs every 15 minutes
setInterval(twitterScout, 15 * 60 * 1000);

// Run once on startup after a short delay
setTimeout(async () => {
    await redditScout();
    await twitterScout();
}, 15000);

// Manual trigger endpoint (called by Vercel cron or admin)
app.post('/scout/run', async (req, res) => {
    const adminKey = req.headers['x-admin-key'];
    if (!isValidAdminKey(adminKey)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const [redditCount, twitterCount] = await Promise.all([redditScout(), twitterScout()]);
    res.json({ success: true, reddit: redditCount, twitter: twitterCount });
});

// GET endpoint for scout status
app.get('/scout/status', (req, res) => {
    const adminKey = req.headers['x-admin-key'];
    if (!isValidAdminKey(adminKey)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    res.json({
        subreddits: SCOUT_SUBREDDITS,
        keywords: SCOUT_KEYWORDS,
        reddit_interval_minutes: 30,
        twitter_interval_minutes: 15,
        // Discord: requires manual setup in servers
        discord_note: 'Discord requires joining servers manually and setting up a bot token.',
    });
});
