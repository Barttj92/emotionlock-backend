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
app.use(express.json());

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
            countWinningTrades: false,
            deviceToken: null,
            metaApiAccountId: null,
            mt5Connected: false,
            mt5Server: null,
            mt5Login: null,
            mt5Region: 'vint-hill',
            processedDealIds: new Set(),
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
    }
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
    if (!lastTokenReset) return true;
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
        const todayMidnight = new Date();
        todayMidnight.setHours(0, 0, 0, 0);
        const now = new Date();

        let fromDate;
        if (!user.lastDealCheck) {
            // First poll after connecting or after a server restart.
            // Seed processedDealIds with everything from the last 60s so the overlap
            // window on the next real poll doesn't accidentally re-fetch these deals.
            // Do NOT count any of them — history before EmotionLock connected is irrelevant.
            const seedFrom = new Date(now.getTime() - 60 * 1000);
            const seedDeals = await getDeals(user.metaApiAccountId, user.mt5Region, seedFrom.toISOString(), now.toISOString());
            for (const deal of seedDeals) {
                user.processedDealIds.add(deal.id);
            }
            user.lastDealCheck = now.toISOString();
            console.log(`[trades] ${userId.slice(0,8)}: first check — seeded ${seedDeals.length} existing deals, poll window initialized`);
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

            // When countWinningTrades is enabled, skip breakeven and losing closes
            if (user.countWinningTrades && (deal.profit === undefined || deal.profit <= 0)) continue;

            user.processedDealIds.add(deal.id);
            user.tradesCount++;
            newTradesDetected = true;

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
        .select('meta_api_account_id, mt5_server, mt5_login, max_trades, count_winning_trades')
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
    if (purchase?.count_winning_trades !== undefined) userStates[key].countWinningTrades = purchase.count_winning_trades;

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
                console.log(`Existing MetaAPI account not found, creating new one for user ${userId}`);
                const account = await createMetaApiAccount(server, String(login), password, `EmotionLock-${userId}`);
                accountId = account.id;
                if (account.region) accountRegion = account.region;
                await deployMetaApiAccount(accountId);
            }
        } else {
            // Different account: delete old (if any), create new
            if (existingMetaApiId) {
                try {
                    await undeployAndDeleteMetaApiAccount(existingMetaApiId);
                } catch (e) {
                    console.log('Cleanup old account warning:', e.message);
                }
            }
            console.log(`Creating new MetaAPI account for user ${userId} on ${server}...`);
            const account = await createMetaApiAccount(server, String(login), password, `EmotionLock-${userId}`);
            accountId = account.id;
            if (account.region) accountRegion = account.region;
            await deployMetaApiAccount(accountId);
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

// PUBLIC ROUTE: status polling — called by the iOS app every 5s. UserId is the Keychain UUID
//               (non-guessable). Returns only non-sensitive trade state.
app.get('/status/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const localDate = req.headers['x-local-date'] || null;
        const isNewUser = !userStates[userId];
        initUser(userId);
        const user = userStates[userId];
        checkDailyReset(user, localDate);
        checkWeeklyTokenReset(user, userId);

        // On first contact or server restart, sync state with Supabase
        if (isNewUser) {
            // Two separate queries so a missing column never blocks MT5 restoration.
            const { data: purchase, error: purchaseErr } = await supabase
                .from('purchases')
                .select('meta_api_account_id, mt5_server, mt5_login, max_trades, count_winning_trades, emergency_tokens_remaining')
                .eq('user_id', userId)
                .maybeSingle();

            if (purchaseErr) {
                console.error(`[status] Supabase query failed for ${userId}:`, purchaseErr.message);
            }

            if (!purchase && !purchaseErr) {
                // No row exists yet for this userId. This happens for every new Apple IAP customer
                // because purchases rows are not automatically created on first use.
                // Create one now so all subsequent MT5, settings, and trade-count saves land correctly.
                const { error: createErr } = await supabase
                    .from('purchases')
                    .insert({
                        user_id: userId,
                        emergency_tokens_remaining: DEFAULT_TOKENS,
                        daily_trades_count: 0,
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
            if (purchase?.count_winning_trades !== undefined) user.countWinningTrades = purchase.count_winning_trades;

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

        res.json({
            tradesCount: user.tradesCount,
            isLocked: user.isLocked,
            emergencyUnlocked: user.emergencyUnlocked,
            emergencyTokens: user.emergencyTokens,
            mt5Connected: user.mt5Connected,
            mt5Server: user.mt5Server ?? null,
            mt5Login: user.mt5Login ?? null,
            maxTrades: user.maxTrades,
        });
    } catch (err) {
        console.error(`Status error for ${req.params.userId}:`, err.message);
        res.status(500).json({ error: 'Failed to fetch status. Please try again.' });
    }
});

const settingsSchema = z.object({
    maxTrades:          z.number().int().min(1).max(10).optional(),
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
            // Any change to the trade limit costs 1 emergency token — up or down.
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

        if (countWinningTrades !== undefined) user.countWinningTrades = countWinningTrades;

        // Persist settings to Supabase so they survive server restarts
        supabase.from('purchases').update({
            max_trades: user.maxTrades,
            count_winning_trades: user.countWinningTrades,
        }).eq('user_id', userId).then(() => {}).catch(() => {});

        res.json({
            success: true,
            maxTrades: user.maxTrades,
            countWinningTrades: user.countWinningTrades,
            isLocked: user.isLocked,
            emergencyTokens: user.emergencyTokens,
            emergencyUnlocked: user.emergencyUnlocked,
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

// Admin: add emergency tokens to a license (called by website after token purchase)
app.post('/admin/add-tokens/:licenseCode', (req, res) => {
    const adminKey = req.headers['x-admin-key'];
    if (!isValidAdminKey(adminKey)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const { licenseCode } = req.params;
    const tokens = parseInt(req.body && req.body.tokens) || 2;

    // Find the user who has this license code activated
    const userId = Object.keys(userStates).find(id => userStates[id].licenseCode === licenseCode);
    if (!userId) {
        // License exists but no user has activated it yet — store tokens for when they do
        if (!licenseCodes[licenseCode]) {
            return res.status(404).json({ error: 'License code not found' });
        }
        licenseCodes[licenseCode].pendingTokens = (licenseCodes[licenseCode].pendingTokens || 0) + tokens;
        console.log(`Stored ${tokens} pending tokens for unactivated license ${licenseCode}`);
        return res.json({ success: true, pending: true });
    }

    userStates[userId].emergencyTokens = (userStates[userId].emergencyTokens || 0) + tokens;
    console.log(`Added ${tokens} emergency tokens to user ${userId} (license ${licenseCode}). Total: ${userStates[userId].emergencyTokens}`);
    res.json({ success: true, tokens: userStates[userId].emergencyTokens });
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
