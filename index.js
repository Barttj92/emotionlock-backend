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

async function undeployAndDeleteMetaApiAccount(accountId) {
    try {
        await fetch(`${PROVISIONING_API}/users/current/accounts/${accountId}/undeploy`, {
            method: 'POST',
            headers: { 'auth-token': METAAPI_TOKEN }
        });
        await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
        console.log('Undeploy warning:', e.message);
    }
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
    if (!response.ok) return null;
    return response.json();
}

async function getDeals(accountId, region, fromTime, toTime) {
    const url = `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${accountId}/history-deals/time/${fromTime}/${toTime}`;
    try {
        const response = await fetch(url, {
            headers: { 'auth-token': METAAPI_TOKEN }
        });
        if (!response.ok) return [];
        const data = await response.json();
        return Array.isArray(data) ? data : [];
    } catch (e) {
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
            lastReset: new Date().toDateString(),
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
    const today = localDateStr || new Date().toDateString();
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

function checkWeeklyTokenReset(user) {
    if (shouldResetWeeklyTokens(user.lastTokenReset)) {
        user.emergencyTokens = DEFAULT_TOKENS;
        user.lastTokenReset = new Date().toISOString();
        // Persist reset to Supabase (fire and forget)
        if (user.licenseCode) {
            saveTokens(user.licenseCode, DEFAULT_TOKENS).catch(() => {});
        }
    }
}

// =====================
// MetaApi trade polling
// =====================
async function checkUserTrades(userId) {
    const user = userStates[userId];
    if (!user || !user.mt5Connected || !user.metaApiAccountId) return;

    checkDailyReset(user);

    try {
        const accountInfo = await getMetaApiAccountInfo(user.metaApiAccountId);
        if (!accountInfo) {
            debugLog(`User ${userId}: MetaApi account not found`);
            return;
        }

        if (accountInfo.region) user.mt5Region = accountInfo.region;

        const isReady = accountInfo.state === 'DEPLOYED' &&
            (accountInfo.connectionStatus === 'CONNECTED' || accountInfo.connectionStatus === 'SYNCHRONIZING');

        if (!isReady) {
            debugLog(`User ${userId}: account not ready yet (${accountInfo.state} / ${accountInfo.connectionStatus})`);
            return;
        }

        // Incremental fetch: only pull deals since last successful check (with 60s overlap for safety).
        // Falls back to today-midnight on first run or after a daily reset.
        const todayMidnight = new Date();
        todayMidnight.setHours(0, 0, 0, 0);
        const now = new Date();

        let fromDate;
        if (user.lastDealCheck) {
            const lastCheck = new Date(user.lastDealCheck);
            // 60s overlap to catch deals that arrived during the previous poll window
            const overlapped = new Date(lastCheck.getTime() - 60 * 1000);
            // Never go earlier than today-midnight (daily reset boundary)
            fromDate = overlapped > todayMidnight ? overlapped : todayMidnight;
        } else {
            fromDate = todayMidnight;
        }

        const fromTime = fromDate.toISOString();
        const toTime = now.toISOString();

        const deals = await getDeals(user.metaApiAccountId, user.mt5Region, fromTime, toTime);

        let newTradesDetected = false;

        for (const deal of deals) {
            if (user.processedDealIds.has(deal.id)) continue;

            const isTradeOpened = deal.entryType === 'DEAL_ENTRY_IN' || deal.entryType === 'DEAL_ENTRY_INOUT';
            if (!isTradeOpened) continue;
            if (deal.type === 'DEAL_TYPE_BALANCE') continue;

            const isWin = (deal.profit || 0) > 0;
            if (!user.countWinningTrades && isWin) {
                user.processedDealIds.add(deal.id);
                continue;
            }

            user.processedDealIds.add(deal.id);
            user.tradesCount++;
            newTradesDetected = true;

            debugLog(`User ${userId}: trade counted. Total: ${user.tradesCount}/${user.maxTrades}`);
        }

        // If a new trade came in after an emergency unlock, reset the emergency so locking can trigger again
        if (newTradesDetected && user.emergencyUnlocked) {
            user.emergencyUnlocked = false;
            debugLog(`User ${userId}: new trade after emergency unlock — resetting emergency state`);
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
        userStates[key].mt5Server = purchase.mt5_server;
        userStates[key].mt5Login = purchase.mt5_login;
        userStates[key].mt5Connected = true;
        debugLog(`Restored MT5 connection for user`);
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
        // Disconnect existing account if any
        if (userStates[userId].metaApiAccountId) {
            try {
                await undeployAndDeleteMetaApiAccount(userStates[userId].metaApiAccountId);
            } catch (e) {
                console.log('Cleanup old account warning:', e.message);
            }
        }

        console.log(`Connecting MT5 for user ${userId} on ${server}...`);
        const account = await createMetaApiAccount(server, String(login), password, `EmotionLock-${userId}`);

        userStates[userId].metaApiAccountId = account.id;
        userStates[userId].mt5Server = server;
        userStates[userId].mt5Login = String(login);
        userStates[userId].mt5Connected = true;
        userStates[userId].processedDealIds = new Set();

        await deployMetaApiAccount(account.id);

        // Persist MT5 connection to Supabase so it survives server restarts
        await supabase.from('purchases').update({
            meta_api_account_id: account.id,
            mt5_server: server,
            mt5_login: String(login),
        }).eq('license_code', userId);

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
        await undeployAndDeleteMetaApiAccount(user.metaApiAccountId);
        user.metaApiAccountId = null;
        user.mt5Connected = false;
        user.mt5Server = null;
        user.mt5Login = null;

        // Clear MT5 from Supabase too
        await supabase.from('purchases').update({
            meta_api_account_id: null,
            mt5_server: null,
            mt5_login: null,
        }).eq('license_code', userId);

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
        checkWeeklyTokenReset(user);

        // On server restart, reload all persisted state from Supabase
        if (isNewUser) {
            const storedTokens = await getStoredTokens(userId);
            if (storedTokens !== null) {
                user.emergencyTokens = storedTokens;
                console.log(`Server restart: restored ${storedTokens} tokens for ${userId}`);
            }

            const { data: purchase } = await supabase
                .from('purchases')
                .select('meta_api_account_id, mt5_server, mt5_login, max_trades, count_winning_trades')
                .eq('license_code', userId)
                .maybeSingle();

            if (purchase?.meta_api_account_id) {
                user.metaApiAccountId = purchase.meta_api_account_id;
                user.mt5Server = purchase.mt5_server;
                user.mt5Login = purchase.mt5_login;
                user.mt5Connected = true;
                console.log(`Server restart: restored MT5 connection for ${userId}`);
            }
            if (purchase?.max_trades) user.maxTrades = purchase.max_trades;
            if (purchase?.count_winning_trades !== undefined) user.countWinningTrades = purchase.count_winning_trades;
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
        if (maxTrades !== undefined) {
            user.maxTrades = maxTrades;
        }
        if (countWinningTrades !== undefined) user.countWinningTrades = countWinningTrades;

        // Re-evaluate lock state: if trades >= new maxTrades and not emergency-unlocked → lock
        if (user.tradesCount >= user.maxTrades && !user.emergencyUnlocked) {
            user.isLocked = true;
        }

        // Persist settings to Supabase so they survive server restarts
        supabase.from('purchases').update({
            max_trades: user.maxTrades,
            count_winning_trades: user.countWinningTrades,
        }).eq('license_code', userId).then(() => {}).catch(() => {});

        res.json({ success: true, maxTrades: user.maxTrades, countWinningTrades: user.countWinningTrades, isLocked: user.isLocked });
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
        checkWeeklyTokenReset(user);
        if (user.emergencyTokens <= 0) {
            return res.status(400).json({ error: 'No tokens available' });
        }
        user.isLocked = false;
        user.emergencyUnlocked = true;
        user.emergencyTokens -= 1;
        // Persist new token count to Supabase so server restarts don't reset it
        await saveTokens(userId, user.emergencyTokens);
        debugLog(`User ${userId}: emergency unlock. Tokens left: ${user.emergencyTokens}`);
        res.json({ success: true, isLocked: false, emergencyUnlocked: true, emergencyTokens: user.emergencyTokens });
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
