const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
let apn = null;
try { apn = require('@parse/node-apn'); } catch (err) { console.error('apn module unavailable (push disabled):', err.message); }
const { createClient } = require('@supabase/supabase-js');
const { verifyAndDecodeNotification: verifyAppleNotification } = require('./apple-notifications');

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
// Subscription / access helpers
// =====================
// The iOS app polls /status every 5s, so we cache the subscription state per
// user to avoid hammering Supabase. Cache is invalidated whenever /purchase
// or the App Store Server Notifications V2 webhook updates the row, so any
// real state change is reflected within at most SUBSCRIPTION_CACHE_TTL_MS.
const SUBSCRIPTION_CACHE_TTL_MS = 60 * 1000;

// Grace window AFTER trial_ends_at before the MetaAPI account is undeployed.
// Covers Apple's billing retry plus accidental cancellations so users who
// re-subscribe within 48h keep their MT5 connection without reconnect setup.
const SUBSCRIPTION_GRACE_MS = 48 * 60 * 60 * 1000;

const subscriptionCache = new Map();

function invalidateSubscriptionCache(userId) {
    if (!userId) return;
    subscriptionCache.delete(userId);
}

async function getSubscriptionState(userId) {
    const cached = subscriptionCache.get(userId);
    if (cached && (Date.now() - cached.fetchedAt) < SUBSCRIPTION_CACHE_TTL_MS) {
        return cached;
    }
    const { data, error } = await supabase
        .from('purchases')
        .select('subscription_status, trial_ends_at, license_code, app_trial_started_at, app_trial_ends_at')
        .eq('user_id', userId)
        .maybeSingle();
    if (error) {
        console.error(`[subscription] Supabase lookup failed for ${userId}:`, error.message);
        // Fail open on transient Supabase errors so a paying user is never
        // locked out by a database hiccup. The next refresh re-checks.
        return {
            status: null, trialEndsAt: null, hasLicense: false,
            appTrialStartedAt: null, appTrialEndsAt: null,
            fetchedAt: Date.now(), failedOpen: true,
        };
    }
    const state = {
        status: data?.subscription_status ?? null,
        trialEndsAt: data?.trial_ends_at ? new Date(data.trial_ends_at).getTime() : null,
        hasLicense: !!data?.license_code,
        // App-level trial: separate from Apple's subscription trial. See migration 002.
        appTrialStartedAt: data?.app_trial_started_at ? new Date(data.app_trial_started_at).getTime() : null,
        appTrialEndsAt: data?.app_trial_ends_at ? new Date(data.app_trial_ends_at).getTime() : null,
        fetchedAt: Date.now(),
        failedOpen: false,
    };
    subscriptionCache.set(userId, state);
    return state;
}

// True iff the user is currently in their 1-week free trial window.
function isAppTrialActive(state) {
    if (!state || !state.appTrialEndsAt) return false;
    return state.appTrialEndsAt > Date.now();
}

// True when the user is entitled to use trade-tracking features right now.
// Rules:
//   - In-app 1-week trial active: always allowed (covers brand new users who
//     haven't paid yet but are inside their free week).
//   - 'active' or 'trialing': always allowed.
//   - 'expired' BUT trial_ends_at is still in the future: Apple sometimes
//     reports 'expired' during a billing retry window before the access
//     period has actually ended. Honour Apple's expiresDate as the source
//     of truth and keep the user active until then.
//   - 'expired' AND past trial_ends_at: blocked, UNLESS the in-app trial is
//     still running (rare edge case where someone subscribed, cancelled and
//     is back inside the original 7-day trial — let them finish it).
//   - App trial expired AND no active sub: blocked.
//   - status null AND app trial not started yet: treat as access. Brand new
//     user who hasn't connected MT5 yet — they're allowed to reach
//     /connect-mt5 which is what starts the trial.
async function isSubscriptionActive(userId) {
    const state = await getSubscriptionState(userId);
    if (!state) return true;
    if (isAppTrialActive(state)) return true;
    if (state.status === 'active' || state.status === 'trialing') return true;
    if (state.status === 'expired') {
        if (state.trialEndsAt && state.trialEndsAt > Date.now()) return true;
        // Edge case: returning user whose old Apple ID had a cancelled sub
        // but who has NEVER started the in-app trial under this user_id.
        // Without this branch they can't reach /connect-mt5 to start their
        // first free week. We grant access here exactly like pre-trial below.
        if (!state.appTrialStartedAt) return true;
        return false;
    }
    // status === null
    // If the in-app trial has already started AND ended without a paid sub,
    // the user is past their free week and must subscribe.
    if (state.appTrialEndsAt && state.appTrialEndsAt <= Date.now()) return false;
    // Pre-trial (no MT5 connect yet) and no Apple data: allow. The trial will
    // start the moment they call /connect-mt5.
    return true;
}

// Used by the periodic cleanup job to find users whose MetaAPI account can
// be safely undeployed. Requires 'expired' status AND past the grace window.
async function isPastGracePeriod(userId) {
    const state = await getSubscriptionState(userId);
    if (!state || state.status !== 'expired') return false;
    if (!state.trialEndsAt) return false;
    return (Date.now() - state.trialEndsAt) > SUBSCRIPTION_GRACE_MS;
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
    // Paginate. MetaAPI's list endpoint defaults to a page size of ~100. Once
    // the total account count crosses that boundary, a non-paginated request
    // would silently stop seeing older accounts and the safety net would
    // start letting duplicates through. We walk pages until either we find
    // the match or a page returns fewer rows than the limit (i.e. last page).
    const PAGE_LIMIT = 100;
    const MAX_PAGES = 50; // Hard ceiling: 5000 accounts. Plenty for years of growth.
    try {
        for (let page = 0; page < MAX_PAGES; page++) {
            const offset = page * PAGE_LIMIT;
            const url = `${PROVISIONING_API}/users/current/accounts?limit=${PAGE_LIMIT}&offset=${offset}`;
            const response = await fetch(url, {
                headers: { 'auth-token': METAAPI_TOKEN }
            });
            if (!response.ok) {
                console.log(`[metaapi] findByName list HTTP ${response.status} (page ${page})`);
                return null;
            }
            const accounts = await response.json();
            if (!Array.isArray(accounts)) return null;
            const match = accounts.find(a => a && a.name === name);
            if (match) return match;
            // Last page: fewer results than limit means we have seen everything.
            if (accounts.length < PAGE_LIMIT) return null;
        }
        console.log(`[metaapi] findByName exhausted ${MAX_PAGES} pages without match for ${name}`);
        return null;
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

// Per-user mutex for /connect-mt5. Prevents concurrent calls from creating
// duplicate MetaAPI accounts (each account costs money per hour).
// Map<userId, Promise> — second concurrent call awaits the first.
const connectMt5InFlight = new Map();

// Returns the calendar date string ("YYYY-MM-DD") in Europe/Amsterdam.
// Used by the trade-polling loop so the daily reset boundary matches the
// rule "midnight Europe/Amsterdam" regardless of the server's UTC clock.
function getAmsterdamDateStr(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Amsterdam',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const y = parts.find(p => p.type === 'year')?.value ?? '1970';
    const m = parts.find(p => p.type === 'month')?.value ?? '01';
    const d = parts.find(p => p.type === 'day')?.value ?? '01';
    return `${y}-${m}-${d}`;
}

function initUser(userId) {
    if (!userStates[userId]) {
        userStates[userId] = {
            tradesCount: 0,
            isLocked: false,
            emergencyUnlocked: false,
            emergencyTokens: DEFAULT_TOKENS,
            // Use Amsterdam date so the lastReset value matches the daily-reset
            // boundary used everywhere else (polling loop, /status). A UTC
            // value here would cause an immediate "reset" on the first poll
            // after 22:00 UTC even though the Amsterdam day hasn't changed.
            lastReset: getAmsterdamDateStr(),
            firstSetupComplete: false,
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
    // Canonical reset boundary is Europe/Amsterdam (CLAUDE.md). The iOS app
    // sends x-local-date already formatted in Amsterdam time, so it should
    // match. The fallback (no header) used to be UTC, which caused the
    // polling loop to wipe state hours before the user's actual local
    // midnight. Now both paths use Amsterdam.
    const today = localDateStr || getAmsterdamDateStr();
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
        const nowIso = new Date().toISOString();
        user.emergencyTokens = DEFAULT_TOKENS;
        user.lastTokenReset = nowIso;
        // Persist reset — prefer userId (Apple IAP), fall back to licenseCode (legacy).
        // Also stamp last_token_reset so the global sweep knows this user is up-to-date.
        if (userId) {
            saveTokensByUserId(userId, DEFAULT_TOKENS).catch(() => {});
            supabase.from('purchases')
                .update({ last_token_reset: nowIso })
                .eq('user_id', userId)
                .then(() => {}).catch(() => {});
        } else if (user.licenseCode) {
            saveTokens(user.licenseCode, DEFAULT_TOKENS).catch(() => {});
            supabase.from('purchases')
                .update({ last_token_reset: nowIso })
                .eq('license_code', user.licenseCode)
                .then(() => {}).catch(() => {});
        }
    }
}

// =====================
// MetaApi trade polling
// =====================
async function checkUserTrades(userId) {
    const user = userStates[userId];
    if (!user) return;
    if (!user.mt5Connected) return;
    if (!user.metaApiAccountId) return;

    // Use Europe/Amsterdam local date for the daily reset boundary, not UTC.
    // Without this, the 15s polling loop wipes processedDealIds + tradesCount
    // hours BEFORE the user's actual local midnight (between 00:00 UTC and
    // ~02:00 CET). The iOS app's /status poll uses x-local-date for the same
    // reason, and these two sources must agree or trades get double-counted.
    checkDailyReset(user, getAmsterdamDateStr());

    try {
        const accountInfo = await getMetaApiAccountInfo(user.metaApiAccountId);
        if (!accountInfo) {
            console.log(`[trades] ${userId.slice(0,8)}: MetaApi account not found (id: ${user.metaApiAccountId})`);
            return;
        }

        if (accountInfo.region) user.mt5Region = accountInfo.region;

        const isReady = accountInfo.state === 'DEPLOYED' &&
            (accountInfo.connectionStatus === 'CONNECTED' || accountInfo.connectionStatus === 'SYNCHRONIZING');

        debugLog(`[trades] ${userId.slice(0,8)}: state=${accountInfo.state} status=${accountInfo.connectionStatus} region=${user.mt5Region} ready=${isReady}`);

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
            // 2. Rebuild todayDeals for the status display.
            // 3. Reconcile tradesCount: previously this branch ignored seen
            //    closes on the assumption that tradesCount was already
            //    restored from Supabase. That assumption breaks for a brand
            //    new MT5 connect, where Supabase still says 0 but the user
            //    has already placed and closed a trade while the MetaAPI
            //    account was deploying (1-3 min window). Those trades got
            //    added to processedDealIds and silently swallowed.
            //    Fix: count valid closes in the seed and bump tradesCount
            //    to max(tradesCount, seedCloseCount). Never decrement.
            const seedDeals = await getDeals(user.metaApiAccountId, user.mt5Region, todayMidnight.toISOString(), now.toISOString());
            user.todayDeals = [];
            let seedCloseCount = 0;
            for (const deal of seedDeals) {
                user.processedDealIds.add(deal.id);
                const isTradeClose = deal.entryType === 'DEAL_ENTRY_OUT' || deal.entryType === 'DEAL_ENTRY_INOUT';
                if (!isTradeClose || deal.type === 'DEAL_TYPE_BALANCE') continue;
                const direction = deal.type === 'DEAL_TYPE_SELL' ? 'Long' : 'Short';
                const dealProfit = deal.profit ?? null;
                user.todayDeals.push({
                    symbol: deal.symbol || '',
                    direction,
                    price: deal.price ?? null,
                    profit: dealProfit,
                });
                // F4: countWinningTrades — match the normal-path semantics so
                // reconcile honours the same rule the user configured.
                const isWin = dealProfit !== null && dealProfit > 0;
                if (user.countWinningTrades && dealProfit !== null && !isWin) continue;
                seedCloseCount++;
            }
            user.lastDealCheck = now.toISOString();

            if (seedCloseCount > user.tradesCount) {
                const before = user.tradesCount;
                user.tradesCount = seedCloseCount;
                console.log(`[trades] ${userId.slice(0,8)}: seed reconciled tradesCount ${before} -> ${seedCloseCount} (MetaAPI shows ${seedCloseCount} closes today, Supabase had ${before})`);
                saveDailyTrades(userId, user.tradesCount, user.lastReset).catch(() => {});
                if (user.tradesCount >= user.maxTrades && !user.isLocked) {
                    user.isLocked = true;
                    debugLog(`User ${userId}: trade limit reached during seed reconcile`);
                    // Skip push from this path: the user just opened the app
                    // (that's what triggered /status -> initUser -> first poll),
                    // so the next /status response will surface isLocked within
                    // seconds. No need to double-notify.
                }
            }

            debugLog(`[trades] ${userId.slice(0,8)}: first check — seeded ${seedDeals.length} deals, rebuilt ${user.todayDeals.length} todayDeals, ${seedCloseCount} valid closes, tradesCount=${user.tradesCount}`);
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

        debugLog(`[trades] ${userId.slice(0,8)}: fetched ${deals.length} deals from ${fromTime} to ${toTime}`);
        if (deals.length > 0) {
            debugLog(`[trades] ${userId.slice(0,8)}: deal types:`, deals.map(d => `${d.id} ${d.entryType} ${d.type} profit=${d.profit}`).join(' | '));
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

// Poll every 15 seconds.
// Skip users whose subscription has expired beyond the access window. The
// MetaAPI account itself isn't undeployed yet — that happens in the periodic
// cleanup job after the 48h grace — but there is no point polling deals for
// a paywalled user who can't see them anyway.
setInterval(async () => {
    for (const userId of Object.keys(userStates)) {
        try {
            const active = await isSubscriptionActive(userId);
            if (!active) continue;
        } catch (e) {
            // Fail open: a Supabase hiccup must never starve a paying user
            // of trade tracking. Log and keep polling for this cycle.
            console.error(`[poll] subscription check failed for ${userId}:`, e.message);
        }
        await checkUserTrades(userId);
    }
}, 15000);

// =====================
// MetaAPI cost cleanup — runs hourly
// =====================
// MetaAPI bills per account per hour. When a subscription expires, undeploy
// the account after the 48h grace window so we stop paying for users who
// can no longer access the app. The account row is kept (not deleted) so a
// re-subscribe later can redeploy the existing account instead of forcing
// the user through MT5 reconnect again. meta_api_undeployed_at is stamped
// so we know the deploy state without round-tripping to MetaAPI.
async function cleanupExpiredMetaApiAccounts() {
    try {
        const { data: candidates, error } = await supabase
            .from('purchases')
            .select('user_id, meta_api_account_id, trial_ends_at, subscription_status, meta_api_undeployed_at')
            .eq('subscription_status', 'expired')
            .not('meta_api_account_id', 'is', null);

        if (error) {
            console.error('[cleanup] Supabase query failed:', error.message);
            return;
        }

        const now = Date.now();
        let undeployed = 0;

        for (const row of (candidates ?? [])) {
            // Re-evaluate grace per row so the check matches isPastGracePeriod
            // exactly without trusting any cached value.
            const trialEndsAt = row.trial_ends_at ? new Date(row.trial_ends_at).getTime() : null;
            if (!trialEndsAt) continue;
            if ((now - trialEndsAt) <= SUBSCRIPTION_GRACE_MS) continue;

            // Already undeployed and not redeployed since? Skip to avoid
            // hammering MetaAPI with redundant undeploy calls every hour.
            if (row.meta_api_undeployed_at) continue;

            try {
                await undeployMetaApiAccount(row.meta_api_account_id);
                await supabase
                    .from('purchases')
                    .update({ meta_api_undeployed_at: new Date().toISOString() })
                    .eq('user_id', row.user_id);

                // Drop in-memory state so the next foregrounding (after
                // re-subscribe) re-reads Supabase and restores cleanly.
                if (userStates[row.user_id]) {
                    userStates[row.user_id].mt5Connected = false;
                }
                invalidateSubscriptionCache(row.user_id);

                console.log(`[cleanup] Undeployed MetaAPI ${row.meta_api_account_id} for expired user ${row.user_id.slice(0,8)}`);
                undeployed++;
            } catch (e) {
                console.error(`[cleanup] Undeploy failed for ${row.user_id}:`, e.message);
            }
        }

        if (undeployed > 0) {
            console.log(`[cleanup] Hourly sweep undeployed ${undeployed} MetaAPI account(s).`);
        }
    } catch (err) {
        console.error('[cleanup] Unexpected error:', err.message);
    }
}

// Hourly sweep. setInterval drifts over weeks but that is acceptable for a
// cost-cleanup job that runs 24x/day. Initial delay 5 min after boot so we
// don't fire before the process has finished warming up.
setTimeout(() => {
    cleanupExpiredMetaApiAccounts().catch(() => {});
    setInterval(() => cleanupExpiredMetaApiAccounts().catch(() => {}), 60 * 60 * 1000);
}, 5 * 60 * 1000);

// =====================
// Trial expiry push scheduler
// =====================
// Sends two pushes ahead of every user's app_trial_ends_at:
//   - 24h before: "Your free week ends tomorrow"
//   - 1h before:  "Your free trial expires in 1 hour"
//
// Each push is idempotent: the *_at column is stamped on send and the query
// excludes rows that already have it set, so duplicate notifications are
// impossible even if the scheduler is restarted mid-cycle.
//
// Window widths (24h ± 1h and 1h ± 7.5min) are intentionally larger than the
// 5-min scheduler tick so a notification cannot slip through if the loop is
// briefly delayed by Railway autoscaling or a slow Supabase query.
async function runTrialNotificationScheduler() {
    if (!apnProvider) return; // No push pipeline configured, nothing to do.

    const now = Date.now();
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const ONE_MIN_MS = 60 * 1000;

    // ---- 24h pre-expiry pushes ----
    try {
        const lower24 = new Date(now + 23 * ONE_HOUR_MS).toISOString();
        const upper24 = new Date(now + 25 * ONE_HOUR_MS).toISOString();
        const { data: due24, error: err24 } = await supabase
            .from('purchases')
            .select('user_id, device_token, app_trial_ends_at')
            .gte('app_trial_ends_at', lower24)
            .lte('app_trial_ends_at', upper24)
            .is('trial_notified_24h_at', null);
        if (err24) {
            console.error('[trial-push] 24h query failed:', err24.message);
        } else {
            for (const row of (due24 ?? [])) {
                if (!row.device_token) continue;
                try {
                    await sendPushNotification(
                        row.device_token,
                        'Your free trial ends tomorrow',
                        "You've got 24 hours left of EmotionLock. Activate to keep using it without interruption."
                    );
                    await supabase
                        .from('purchases')
                        .update({ trial_notified_24h_at: new Date().toISOString() })
                        .eq('user_id', row.user_id);
                    console.log(`[trial-push] 24h notice sent to ${row.user_id.slice(0,8)}`);
                } catch (e) {
                    console.error(`[trial-push] 24h send failed for ${row.user_id}:`, e.message);
                }
            }
        }
    } catch (e) {
        console.error('[trial-push] 24h block error:', e.message);
    }

    // ---- 1h pre-expiry pushes ----
    // Window runs from "now" (lower bound) to "+68min" (upper bound). The wide
    // lower bound catches users whose trial is about to expire within the next
    // hour even if a previous scheduler tick was missed (e.g. Railway restart
    // or a slow Supabase query). The 24h push is the long-warning; the 1h
    // push is the last-call. Better to send slightly early than not at all.
    // We deliberately do not push AFTER expiry (which would be confusing) —
    // the upper bound is the only filter we need on the future side.
    try {
        const lower1 = new Date(now).toISOString();                     // now
        const upper1 = new Date(now + 68 * ONE_MIN_MS).toISOString();   // 68 min
        const { data: due1, error: err1 } = await supabase
            .from('purchases')
            .select('user_id, device_token, app_trial_ends_at')
            .gte('app_trial_ends_at', lower1)
            .lte('app_trial_ends_at', upper1)
            .is('trial_notified_1h_at', null);
        if (err1) {
            console.error('[trial-push] 1h query failed:', err1.message);
        } else {
            for (const row of (due1 ?? [])) {
                if (!row.device_token) continue;
                try {
                    await sendPushNotification(
                        row.device_token,
                        'Your free trial ends in 1 hour',
                        'Activate now to keep your trade limit protection running.'
                    );
                    await supabase
                        .from('purchases')
                        .update({ trial_notified_1h_at: new Date().toISOString() })
                        .eq('user_id', row.user_id);
                    console.log(`[trial-push] 1h notice sent to ${row.user_id.slice(0,8)}`);
                } catch (e) {
                    console.error(`[trial-push] 1h send failed for ${row.user_id}:`, e.message);
                }
            }
        }
    } catch (e) {
        console.error('[trial-push] 1h block error:', e.message);
    }

    // ---- Cost cleanup: undeploy MetaAPI for users whose trial expired and
    // never paid. Without this, an abandoned trial keeps incurring MetaAPI
    // hourly cost indefinitely. We wait 24h past trial_ends_at before
    // undeploying to give legitimate paying users time to complete their
    // license + sub purchase without their MT5 connection going dark.
    try {
        const trialGraceCutoff = new Date(now - 24 * ONE_HOUR_MS).toISOString();
        const { data: abandoned, error: errAbandoned } = await supabase
            .from('purchases')
            .select('user_id, meta_api_account_id, app_trial_ends_at, subscription_status, license_code, meta_api_undeployed_at')
            .lte('app_trial_ends_at', trialGraceCutoff)
            .not('meta_api_account_id', 'is', null)
            .is('meta_api_undeployed_at', null);
        if (errAbandoned) {
            console.error('[trial-push] Abandoned query failed:', errAbandoned.message);
        } else {
            for (const row of (abandoned ?? [])) {
                // Skip users who paid: license + active or trialing sub means
                // they are a real paying customer, hands off their MT5.
                const subActive = row.subscription_status === 'active' || row.subscription_status === 'trialing';
                if (subActive && row.license_code) continue;
                try {
                    await undeployMetaApiAccount(row.meta_api_account_id);
                    await supabase
                        .from('purchases')
                        .update({ meta_api_undeployed_at: new Date().toISOString() })
                        .eq('user_id', row.user_id);
                    if (userStates[row.user_id]) {
                        userStates[row.user_id].mt5Connected = false;
                    }
                    invalidateSubscriptionCache(row.user_id);
                    console.log(`[trial-push] Undeployed abandoned trial MetaAPI for ${row.user_id.slice(0,8)}`);
                } catch (e) {
                    console.error(`[trial-push] Undeploy failed for ${row.user_id}:`, e.message);
                }
            }
        }
    } catch (e) {
        console.error('[trial-push] Cost cleanup block error:', e.message);
    }
}

// 5-minute tick. Same boot-delay pattern as cleanupExpiredMetaApiAccounts.
setTimeout(() => {
    runTrialNotificationScheduler().catch(() => {});
    setInterval(() => runTrialNotificationScheduler().catch(() => {}), 5 * 60 * 1000);
}, 5 * 60 * 1000);

// =====================
// Weekly token reset sweep
// =====================
// The on-activity check (checkWeeklyTokenReset) only fires when a user opens
// the app. A user who never contacts the backend between two Sundays would
// keep stale tokens server-side until their next /status — Supabase reads
// from elsewhere (admin, Command Center) would see the wrong value.
//
// This sweep runs every 15 minutes and, when "now" in Europe/Amsterdam is
// Sunday >= 22:00 OR Monday before the next sweep boundary, finds all
// purchases rows whose last_token_reset is before the most recent Sunday
// 22:00 cutoff and updates emergency_tokens_remaining = 2 + stamps the
// reset timestamp. The query is idempotent: rows already at 2 with a
// fresh last_token_reset are skipped by the cutoff comparison.

// Returns the Date of the most recent Sunday 22:00 Europe/Amsterdam.
// Anchors the reset boundary correctly across CET/CEST and across week
// boundaries (e.g. Tuesday morning -> last reset was 3 days ago).
function lastSundayResetCutoff(now = new Date()) {
    // Walk back at most 8 days and find the latest Sunday 22:00 Amsterdam
    // that is in the past. We rely on getAmsterdamDayHour() which already
    // handles DST correctly.
    for (let i = 0; i <= 8; i++) {
        // Sample at hour granularity is enough — we only need to find the
        // Sunday 22:00 boundary, not exact second precision.
        for (let hOffset = 0; hOffset < 24; hOffset++) {
            const candidate = new Date(now.getTime() - (i * 24 + hOffset) * 60 * 60 * 1000);
            if (candidate > now) continue;
            const ams = getAmsterdamDayHour(candidate);
            if (ams.day === 0 && ams.hour === 22) {
                // Snap to the start of that Amsterdam hour by zeroing minutes/seconds.
                candidate.setUTCMinutes(0, 0, 0);
                return candidate;
            }
        }
    }
    // Fallback: 7 days ago. Should never reach this in practice.
    return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
}

async function sweepWeeklyTokenReset() {
    try {
        const now = new Date();
        const cutoff = lastSundayResetCutoff(now);
        const cutoffIso = cutoff.toISOString();

        // Only sweep if the cutoff is in the past (i.e. we have crossed the
        // most recent Sunday 22:00). lastSundayResetCutoff always returns a
        // past moment, so this is effectively always true — kept explicit
        // for readability.
        if (cutoff > now) return;

        // Find rows whose last_token_reset is missing or older than the
        // cutoff. These are users who have not been reset for this week yet.
        const { data: stale, error } = await supabase
            .from('purchases')
            .select('user_id, emergency_tokens_remaining, last_token_reset')
            .or(`last_token_reset.is.null,last_token_reset.lt.${cutoffIso}`);

        if (error) {
            console.error('[token-sweep] query failed:', error.message);
            return;
        }

        let reset = 0;
        for (const row of (stale ?? [])) {
            if (!row.user_id) continue;
            // Skip rows that already have full tokens AND a non-null reset
            // timestamp — they were swept earlier or freshly initialised.
            // We use this defensive check so an outage that wipes
            // last_token_reset to null doesn't flip 0-token users back to 2
            // unfairly mid-week. Wait — actually that IS what we want on a
            // Sunday boundary. So: only the cutoff comparison gates this.
            const { error: updErr } = await supabase
                .from('purchases')
                .update({
                    emergency_tokens_remaining: DEFAULT_TOKENS,
                    last_token_reset: now.toISOString(),
                })
                .eq('user_id', row.user_id);
            if (updErr) {
                console.error(`[token-sweep] update failed for ${row.user_id}:`, updErr.message);
                continue;
            }
            // Refresh in-memory state if loaded so the next /status returns
            // the swept value immediately.
            if (userStates[row.user_id]) {
                userStates[row.user_id].emergencyTokens = DEFAULT_TOKENS;
                userStates[row.user_id].lastTokenReset = now.toISOString();
            }
            reset++;
        }

        if (reset > 0) {
            console.log(`[token-sweep] Reset emergency tokens for ${reset} user(s). Cutoff: ${cutoffIso}`);
        }
    } catch (err) {
        console.error('[token-sweep] Unexpected error:', err.message);
    }
}

// 15-minute tick. The 5-min boot delay matches the other schedulers so
// we don't fire before Supabase + MetaAPI clients are warm.
setTimeout(() => {
    sweepWeeklyTokenReset().catch(() => {});
    setInterval(() => sweepWeeklyTokenReset().catch(() => {}), 15 * 60 * 1000);
}, 5 * 60 * 1000);

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

    // Per-user mutex. A second concurrent /connect-mt5 call for the same user
    // (e.g. flaky network retry, double-tap, foregrounding race) must NOT
    // race the first call through createOrRecoverMetaApiAccount — both calls
    // would see an empty Supabase row, both would invoke create, and we
    // would end up with two MetaAPI accounts named EmotionLock-${userId},
    // each billed hourly. Returning 409 keeps the client side simple: the
    // iOS app retries on next /status anyway.
    if (connectMt5InFlight.has(userId)) {
        return res.status(409).json({
            error: 'connect_in_progress',
            message: 'Another connection attempt is already in progress. Please wait a moment.',
        });
    }
    let _resolveInFlight;
    connectMt5InFlight.set(userId, new Promise(r => { _resolveInFlight = r; }));
    res.on('finish', () => { connectMt5InFlight.delete(userId); _resolveInFlight && _resolveInFlight(); });
    res.on('close',  () => { connectMt5InFlight.delete(userId); _resolveInFlight && _resolveInFlight(); });

    // Block new MT5 connections for users whose subscription has expired.
    // Without this gate a paywalled user could trigger a new MetaAPI account
    // creation (or redeploy of an existing one) and immediately start
    // accruing hourly cost without us getting paid.
    try {
        const active = await isSubscriptionActive(userId);
        if (!active) {
            return res.status(402).json({
                error: 'subscription_expired',
                message: 'Your EmotionLock subscription is no longer active. Re-subscribe to reconnect MT5.',
            });
        }
    } catch (e) {
        console.error(`[connect-mt5] subscription check failed for ${userId}:`, e.message);
        // Fail open: don't block a paying user on a Supabase glitch.
    }

    try {
        // Check Supabase for an existing MetaAPI account for this user.
        // Also pull app_trial_started_at so we know whether this connect is
        // the moment that should start the 1-week free trial clock.
        const { data: savedAccount } = await supabase
            .from('purchases')
            .select('meta_api_account_id, mt5_server, mt5_login, app_trial_started_at, app_trial_ends_at')
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

        // Persist MT5 connection to Supabase so it survives server restarts.
        // Upsert (not update) because users coming through /reset-after-onboarding
        // do not yet have a purchases row if they haven't completed an IAP
        // purchase, and a silent UPDATE no-op would lose the MT5 link on the
        // next server restart. The unique index on user_id (partial,
        // WHERE user_id IS NOT NULL) makes this safe.
        //
        // First-ever MT5 connect for this user starts the 1-week free trial.
        // We only set the trial timestamps if they're null on the existing row
        // — never overwrite, so reconnects do not extend the trial.
        const mt5Patch = {
            user_id: userId,
            meta_api_account_id: accountId,
            mt5_server: server,
            mt5_login: String(login),
        };
        const isFirstMt5Connect = !savedAccount?.app_trial_started_at;
        if (isFirstMt5Connect) {
            const trialStart = new Date();
            const trialEnd = new Date(trialStart.getTime() + 7 * 24 * 60 * 60 * 1000);
            mt5Patch.app_trial_started_at = trialStart.toISOString();
            mt5Patch.app_trial_ends_at = trialEnd.toISOString();
            console.log(`[connect-mt5] Starting 1-week free trial for user ${userId.slice(0,8)}, ends at ${trialEnd.toISOString()}`);
        }
        const { error: mt5SaveErr } = await supabase.from('purchases').upsert(mt5Patch, { onConflict: 'user_id' });
        if (mt5SaveErr) console.error(`Failed to persist MT5 for ${userId}:`, mt5SaveErr.message);
        // Trial start (or any MT5 reconnect) is a state change worth invalidating
        // the cache for so the next /status poll sees the fresh values.
        invalidateSubscriptionCache(userId);

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
                .select('meta_api_account_id, mt5_server, mt5_login, max_trades, emergency_tokens_remaining, count_winning_trades, first_setup_complete, last_token_reset')
                .eq('user_id', userId)
                .maybeSingle();

            if (purchaseErr) {
                console.error(`[status] Supabase query failed for ${userId}:`, purchaseErr.message);
            }

            // Reject obviously malformed userIds before any work, even when we
            // are only reading. This keeps the rate limiter accounting honest
            // and avoids hitting Supabase for every scanner probe.
            if (!UUID_V4_RE.test(userId)) {
                return res.status(400).json({ error: 'Invalid userId format.' });
            }
            // No row exists yet, but we no longer auto-create one here.
            // /purchase is now the authoritative path that inserts a purchases
            // row when a real Apple IAP transaction is recorded. Auto-creating
            // from /status was abused by scanners polling random UUIDs, which
            // polluted the purchases table with thousands of empty rows
            // indistinguishable from real users in the Command Center.
            // If purchase is null, the in-memory defaults from initUser stand;
            // they will persist correctly once /purchase or /connect-mt5 runs.

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
            // One-shot latch for the initial-setup loophole — survives restarts.
            if (purchase?.first_setup_complete === true) user.firstSetupComplete = true;
            // Restore last_token_reset so the on-activity check has the right
            // anchor and doesn't fire a spurious extra reset after a restart.
            if (purchase?.last_token_reset) user.lastTokenReset = purchase.last_token_reset;

            // Restore today's trade count (separate query — daily_trades columns added later).
            // Amsterdam fallback so the comparison against daily_trades_date is
            // consistent with the polling loop's reset boundary.
            const todayISO = localDate || getAmsterdamDateStr();
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

        // Subscription gate. The iOS app already paywalls locally via
        // hasAccess in StoreKitManager, so this is defense in depth + a
        // clear signal for any client that didn't refresh entitlements yet
        // (e.g. an older app version, or a foregrounding race condition).
        // We deliberately keep this last so user state is loaded and ready
        // the moment the user re-subscribes.
        try {
            const active = await isSubscriptionActive(userId);
            if (!active) {
                return res.status(402).json({
                    error: 'subscription_expired',
                    message: 'Your EmotionLock subscription is no longer active.',
                    subscriptionExpired: true,
                    // Surface mt5Connected so the iOS app knows whether a
                    // reconnect prompt is required after re-subscribing.
                    mt5Connected: user.mt5Connected,
                });
            }
        } catch (e) {
            console.error(`[status] subscription check failed for ${userId}:`, e.message);
            // Fail open: serve the cached state rather than locking out a
            // paying user on a Supabase transient.
        }

        // Trial info — surface enough for the iOS app to render the trial
        // banner and decide between PaywallView and ContentView locally.
        // We pull the freshest state here rather than reading the cached
        // version because trial expiry crosses minute boundaries that the
        // 60s cache could miss.
        const subState = await getSubscriptionState(userId);
        const trialActive = isAppTrialActive(subState);
        const trialEndsAt = subState.appTrialEndsAt;
        let trialDaysRemaining = null;
        if (trialEndsAt) {
            const msLeft = trialEndsAt - Date.now();
            trialDaysRemaining = Math.max(0, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
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
            countWinningTrades: user.countWinningTrades ?? false,
            todayDeals: user.todayDeals ?? [],
            // App-level free trial (1 week from first MT5 connect).
            trialActive,
            trialStartedAt: subState.appTrialStartedAt ? new Date(subState.appTrialStartedAt).toISOString() : null,
            trialEndsAt: trialEndsAt ? new Date(trialEndsAt).toISOString() : null,
            trialDaysRemaining,
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
            // Initial setup: free ONLY once per user, when the backend still
            // has the factory default (1) AND the user has not yet completed
            // their first setup (firstSetupComplete=false). The previous
            // condition (maxTrades===1 && tradesCount===0 && tokens===2) was
            // exploitable: every Monday after the Sunday token reset, a user
            // whose limit happened to be 1 (and who hadn't traded yet that
            // day) could change their limit for free. The firstSetupComplete
            // flag is a one-shot latch persisted to Supabase so the loophole
            // closes the moment the user makes their first real settings call.
            const isInitialSetup = !user.firstSetupComplete
                && user.maxTrades === 1
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

            // One-shot latch: any successful maxTrades change closes the
            // initial-setup loophole permanently. Persisted to Supabase
            // below so a server restart can't re-open it.
            user.firstSetupComplete = true;

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

        // Persist settings to Supabase so they survive server restarts.
        // first_setup_complete is included so the initial-setup loophole
        // stays closed across restarts.
        supabase.from('purchases').update({
            max_trades: user.maxTrades,
            count_winning_trades: user.countWinningTrades,
            first_setup_complete: user.firstSetupComplete,
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
        // Guard: do not burn a token when the user is not locked. The UI
        // already filters this out, but a race condition between status poll
        // and a fresh trade close could let the call through and silently
        // cost the user a token for nothing.
        if (!user.isLocked) {
            return res.status(400).json({
                error: 'not_locked',
                message: 'You are not currently locked. No token has been used.',
                isLocked: false,
                tradesCount: user.tradesCount,
                emergencyTokens: user.emergencyTokens,
            });
        }
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
app.post('/register-device/:userId', async (req, res) => {
    const { userId } = req.params;
    const { deviceToken } = req.body;
    if (!deviceToken) return res.status(400).json({ error: 'deviceToken required' });
    initUser(userId);
    userStates[userId].deviceToken = deviceToken;
    console.log(`User ${userId}: device token registered`);

    // Persist the token to Supabase. Without this, the trial-expiry push
    // scheduler can't reach users after a Railway restart wipes userStates.
    // We do this as a best-effort write — a Supabase glitch should not
    // break the iOS app's device registration flow.
    try {
        await supabase.from('purchases').upsert({
            user_id: userId,
            device_token: deviceToken,
        }, { onConflict: 'user_id' });
    } catch (err) {
        console.error(`[register-device] Failed to persist token for ${userId}:`, err.message);
    }
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

// Schema for the Apple IAP purchase notification body. The iOS app calls
// this endpoint from StoreKitManager after every entitlement refresh, so the
// payload describes the *current* state Apple reports for this user, not a
// per-transaction delta. The endpoint is idempotent: repeated calls with the
// same state are no-ops at the data level.
const purchaseSchema = z.object({
    productId:             z.string().min(1).max(100),
    transactionId:         z.string().min(1).max(100),
    type:                  z.enum(['license', 'subscription']),
    subscriptionStatus:    z.enum(['active', 'trialing', 'expired']).optional(),
    // expirationDate is an epoch-ms timestamp (StoreKit's Date.timeIntervalSince1970 * 1000).
    expirationDate:        z.number().int().optional(),
    // Optional pass-through of the maxTrades chosen during onboarding. Only
    // applied on the very first INSERT for this user, so we never overwrite a
    // value the user later changed via /settings or the Settings screen.
    maxTrades:             z.number().int().min(1).max(50).optional(),
    // ASSN V2 mapping fields. originalTransactionId is the stable id across
    // renewals (Apple keeps it constant for the lifetime of the subscription),
    // appAccountToken is the UUID we set at purchase time so the webhook can
    // map any future notification back to this user without lookups.
    originalTransactionId: z.string().min(1).max(100).optional(),
    appAccountToken:       z.string().min(1).max(100).optional(),
});

// Record an Apple IAP purchase or subscription state change in Supabase so the
// Command Center and admin tools can see paying users. Without this the backend
// would never know a StoreKit purchase happened because Apple does not call
// the backend by default. (App Store Server Notifications V2 is the longer
// term complement to this client-side ping, not a replacement.)
//
// Public endpoint, authenticated by the Keychain userId itself, same pattern
// as /profile and /status. Idempotent: the iOS app fires this on every
// refreshEntitlements call (cold start, restore, transaction update), so
// repeated invocations with the same payload must not cause side effects.
app.post('/purchase/:userId', async (req, res) => {
    const { userId } = req.params;
    if (!userId || !UUID_V4_RE.test(userId)) {
        return res.status(400).json({ error: 'Invalid userId format' });
    }

    const parsed = purchaseSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({
            error: 'Invalid input.',
            details: parsed.error.issues.map(i => i.message),
        });
    }
    const {
        productId, transactionId, type, subscriptionStatus, expirationDate, maxTrades,
        originalTransactionId, appAccountToken,
    } = parsed.data;

    try {
        // Require that this userId has already completed profile setup. The
        // iOS app order is onboarding -> profile setup -> license -> sub, so a
        // real Apple IAP user always has a profiles row before /purchase is
        // ever called. Without this gate, the endpoint accepts any valid UUID
        // v4 from any IP and lets scanners pollute the purchases table with
        // ghost rows that show up in the Command Center as real customers.
        const { data: profile, error: profileErr } = await supabase
            .from('profiles')
            .select('user_id')
            .ilike('user_id', userId)
            .maybeSingle();
        if (profileErr) {
            console.error('[purchase] Profile lookup error:', profileErr.message);
            return res.status(500).json({ error: 'Failed to record purchase. Please try again.' });
        }
        if (!profile) {
            // Quiet 404 instead of a noisy log so we don't fill Railway logs
            // with every scanner probe.
            return res.status(404).json({ error: 'Unknown user. Complete profile setup first.' });
        }

        // Read the existing purchases row so we can decide whether to apply
        // the optional maxTrades pass-through (only on the first INSERT) and
        // so we never clobber unrelated fields the user has since changed.
        const { data: existing, error: readErr } = await supabase
            .from('purchases')
            .select('user_id, license_code, subscription_status')
            .eq('user_id', userId)
            .maybeSingle();
        if (readErr) {
            console.error('[purchase] Supabase read error:', readErr.message);
            return res.status(500).json({ error: 'Failed to record purchase. Please try again.' });
        }

        const patch = { user_id: userId };

        if (type === 'license') {
            // Distinguish Apple IAP licenses from admin-generated EL-... codes
            // by prefixing with IAP-. Apple's transactionId is globally unique
            // per receipt so this stays idempotent across retries.
            patch.license_code = `IAP-${transactionId}`;
        } else {
            // Subscription state. Always reflect what Apple just reported,
            // including downgrades to 'expired' so the Command Center can
            // surface cancelled subs accurately.
            if (subscriptionStatus) patch.subscription_status = subscriptionStatus;
            if (expirationDate)     patch.trial_ends_at = new Date(expirationDate).toISOString();
            patch.subscription_updated_at = new Date().toISOString();
        }

        // ASSN V2 mapping fields. We persist these on every /purchase call so
        // a future webhook can map an Apple notification (which carries one
        // of these ids, not our userId) back to the right purchases row.
        if (originalTransactionId) patch.original_transaction_id = originalTransactionId;
        if (appAccountToken)       patch.app_account_token       = appAccountToken;

        // First INSERT only: apply onboarding-time maxTrades if the caller sent
        // one. Skipping this when a row exists preserves any later /settings
        // changes the user has made through the Settings screen.
        if (!existing && typeof maxTrades === 'number') {
            patch.max_trades = maxTrades;
        }

        const { error: writeErr } = await supabase
            .from('purchases')
            .upsert(patch, { onConflict: 'user_id' });
        if (writeErr) {
            console.error('[purchase] Supabase upsert error:', writeErr.message);
            return res.status(500).json({ error: 'Failed to record purchase. Please try again.' });
        }
        // Drop the cached subscription state so the next /status poll picks
        // up the new status immediately (otherwise the user would see the
        // old "expired" state for up to SUBSCRIPTION_CACHE_TTL_MS after
        // re-subscribing).
        invalidateSubscriptionCache(userId);

        // Lock reset on post-trial activation.
        //
        // When a user's free trial expired with maxTrades reached and they
        // were locked, paying should give them a fresh start: tradesCount = 0,
        // isLocked = false, today's deal log cleared. This matches the
        // generous "trial ends, you pay, you get a clean day" semantics we
        // committed to. It does NOT apply when:
        //   - The user is already paying and just renewed (no expired trial).
        //   - The user is mid-trial (still has free access — no reason to reset).
        //   - This is a subscription event reflecting state Apple just reported
        //     as 'expired' (we're recording the bad news, not the recovery).
        //
        // Trigger condition: app trial has ended AND the new state grants access
        // (license + active subscription). We detect "license + sub" by checking
        // either the patch we just wrote (subscription_status === 'active' or
        // 'trialing') or by re-reading state. We re-read for safety because the
        // patch may only contain one of license/subscription on this call.
        try {
            const freshState = await getSubscriptionState(userId);
            const trialExpired = freshState.appTrialEndsAt && freshState.appTrialEndsAt <= Date.now();
            const subActive = freshState.status === 'active' || freshState.status === 'trialing';
            const hasLicense = freshState.hasLicense;
            const grantsAccess = subActive && hasLicense;
            if (trialExpired && grantsAccess && userStates[userId]) {
                const u = userStates[userId];
                if (u.isLocked || u.tradesCount > 0) {
                    console.log(`[purchase] Post-trial activation reset for ${userId.slice(0,8)}: clearing lock + trade count`);
                    u.tradesCount = 0;
                    u.isLocked = false;
                    u.emergencyUnlocked = false;
                    u.processedDealIds = new Set();
                    u.todayDeals = [];
                    // Persist the cleared counters so a server restart doesn't
                    // resurrect the old count from Supabase.
                    saveDailyTrades(userId, 0, u.lastReset).catch(() => {});
                }
            }
        } catch (resetErr) {
            // Failure here is not fatal — the user still got their access.
            // Worst case they see yesterday's lock state for the cache TTL.
            console.error(`[purchase] Post-trial reset check failed for ${userId}:`, resetErr.message);
        }

        console.log(`[purchase] Recorded ${type} for user ${userId.slice(0,8)}: product=${productId} tx=${transactionId}`);
        res.json({ success: true });

        // Fire-and-forget admin notification on the FIRST license purchase
        // for this user. We detect first-purchase by checking that the
        // existing row had a null license_code before this UPSERT, which
        // makes the email immune to restores, entitlement refreshes, and
        // subsequent /purchase calls for subscription state changes.
        const isFirstLicensePurchase = type === 'license' && (!existing || !existing.license_code);
        if (isFirstLicensePurchase) {
            // Pull profile details so the email is informative without us
            // having to round-trip back from chat to the admin UI. Best
            // effort: if the profile lookup fails we still send the email
            // with the user_id only.
            supabase
                .from('profiles')
                .select('first_name, last_name, email')
                .ilike('user_id', userId)
                .maybeSingle()
                .then(({ data: prof }) => {
                    const fullName = prof ? `${prof.first_name ?? ''} ${prof.last_name ?? ''}`.trim() : 'a new customer';
                    const customerEmail = prof?.email ?? 'unknown';
                    notifyAdmin({
                        subject: `New EmotionLock purchase: ${fullName || 'new customer'}`,
                        lines: [
                            `${fullName || 'A new customer'} just purchased the MT5 Activation license.`,
                            '',
                            `Email:          ${customerEmail}`,
                            `User ID:        ${userId}`,
                            `Product:        ${productId}`,
                            `Transaction ID: ${transactionId}`,
                            `Time:           ${adminNotifyTimestamp()} (Europe/Amsterdam)`,
                            '',
                            'View in Command Center: https://emotionlock.app/command',
                        ],
                    }).catch(() => {});
                })
                .catch(() => {});
        }
    } catch (err) {
        console.error('[purchase] Unexpected error:', err);
        res.status(500).json({ error: 'Unexpected error. Please try again.' });
    }
});

// =====================
// App Store Server Notifications V2 webhook
// =====================
// Apple POSTs subscription lifecycle events here. Configure the URL in
// App Store Connect under "App Information → App Store Server Notifications".
// Set the production URL to:
//   https://emotionlock-backend-production.up.railway.app/apple/notifications
// Sandbox notifications arrive at the same URL (Apple sets environment field).
//
// Endpoint MUST:
//   - return 200 within a few seconds (Apple retries on non-2xx with backoff)
//   - verify the JWS signature against Apple Root CA G3
//   - be safe to call repeatedly (Apple may redeliver the same notification)
const APP_BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'com.emotionlock.EmotionLock';

app.post('/apple/notifications', async (req, res) => {
    const signedPayload = req.body?.signedPayload;
    if (!signedPayload || typeof signedPayload !== 'string') {
        // Apple never sends an empty body; treat as a probe/scanner.
        return res.status(400).json({ error: 'Missing signedPayload' });
    }

    let notification;
    try {
        notification = verifyAppleNotification(signedPayload, APP_BUNDLE_ID);
    } catch (err) {
        // 401 instead of 500 so a forged or malformed body does not look
        // like a server error to Apple (which would trigger their retry).
        console.error('[apple-notify] JWS verification failed:', err.message);
        return res.status(401).json({ error: 'Invalid notification signature' });
    }

    // Send the 200 response IMMEDIATELY so Apple does not retry while we
    // do the Supabase work. Any failure after this is logged for investigation.
    res.json({ received: true });

    try {
        await handleAppleNotification(notification);
    } catch (err) {
        console.error('[apple-notify] Handler error after 200 response:', err.message);
    }
});

// Maps the verified notification onto our purchases row + cleanup actions.
// Returns the new subscription_status when applicable.
async function handleAppleNotification(notification) {
    const { notificationType, subtype, transactionInfo, renewalInfo, environment } = notification;
    if (!transactionInfo) {
        console.log(`[apple-notify] ${notificationType}/${subtype} arrived without transactionInfo, skipping.`);
        return;
    }

    const originalTransactionId = transactionInfo.originalTransactionId ?? null;
    const appAccountToken       = transactionInfo.appAccountToken ?? null;
    const productId             = transactionInfo.productId ?? null;
    const expiresDate           = transactionInfo.expiresDate ?? null;
    const offerType             = transactionInfo.offerType ?? null;

    console.log(
        `[apple-notify] ${notificationType}${subtype ? '/' + subtype : ''} ` +
        `env=${environment} product=${productId} txOriginal=${originalTransactionId} ` +
        `appAccountToken=${appAccountToken ? appAccountToken.slice(0,8) : 'none'}`
    );

    // Subscriptions only — license (one-time non-consumable) doesn't generate
    // renewal events. We do still record refunds on the license below.
    const isSubscription = productId === 'app.emotionlock.monthly';
    const isLicense      = productId === 'app.emotionlock.mt5license';

    // 1) Map notification → userId. Prefer appAccountToken (set on purchases
    //    after the iOS update). Fall back to originalTransactionId for users
    //    who subscribed before that update landed.
    const userId = await resolveUserIdFromAppleIds(appAccountToken, originalTransactionId);
    if (!userId) {
        console.log(`[apple-notify] No matching user for tx ${originalTransactionId} / token ${appAccountToken}. Will store transaction for future reconciliation if it appears later.`);
        return;
    }

    // 2) Decide the new subscription_status based on the notification type.
    //    Keep this conservative: any state we are unsure about → leave the
    //    row alone instead of guessing.
    let newStatus = null;
    if (isSubscription) {
        switch (notificationType) {
            case 'SUBSCRIBED':
                // INITIAL_BUY with an intro offer = trial; otherwise active.
                newStatus = (subtype === 'INITIAL_BUY' && offerType === 1) ? 'trialing' : 'active';
                break;
            case 'DID_RENEW':
                newStatus = 'active';
                break;
            case 'DID_FAIL_TO_RENEW':
                // BILLING_RETRY: Apple still retries silently for up to 60 days.
                // GRACE_PERIOD: user is in grace, billing failed but access continues.
                // No subtype (auto-renew off + expired): straight to expired.
                if (subtype === 'GRACE_PERIOD' || subtype === 'BILLING_RETRY') {
                    newStatus = 'active'; // keep access during retry / grace
                } else {
                    newStatus = 'expired';
                }
                break;
            case 'EXPIRED':
            case 'GRACE_PERIOD_EXPIRED':
                newStatus = 'expired';
                break;
            case 'REFUND':
            case 'REVOKE':
                newStatus = 'expired';
                break;
            case 'DID_CHANGE_RENEWAL_STATUS':
                // User toggled auto-renew on/off. Doesn't change current
                // entitlement — the sub runs until expiresDate either way.
                // Leave status alone, only update timestamps.
                break;
            case 'DID_CHANGE_RENEWAL_PREF':
            case 'PRICE_INCREASE':
            case 'OFFER_REDEEMED':
            case 'RENEWAL_EXTENDED':
                // Informational. No subscription_status change.
                break;
            default:
                console.log(`[apple-notify] Unhandled subscription type: ${notificationType}`);
        }
    }

    // 3) Build the upsert patch.
    const patch = {
        user_id: userId,
        subscription_updated_at: new Date().toISOString(),
    };
    if (originalTransactionId) patch.original_transaction_id = originalTransactionId;
    if (appAccountToken)       patch.app_account_token       = appAccountToken;
    if (expiresDate)           patch.trial_ends_at            = new Date(expiresDate).toISOString();
    if (newStatus)             patch.subscription_status      = newStatus;

    // Refund on the LICENSE (one-time): wipe the license code so the app
    // paywalls the user. Don't touch subscription_status — that's a separate
    // entitlement.
    if (isLicense && (notificationType === 'REFUND' || notificationType === 'REVOKE')) {
        patch.license_code = null;
    }

    const { error: writeErr } = await supabase
        .from('purchases')
        .update(patch)
        .eq('user_id', userId);
    if (writeErr) {
        console.error(`[apple-notify] Supabase update failed for ${userId}:`, writeErr.message);
        return;
    }
    invalidateSubscriptionCache(userId);

    // 4) For hard-revocation events, undeploy the MetaAPI account NOW (don't
    //    wait for the 48h grace sweep). A refund is the user demanding their
    //    money back, so we have no reason to keep the account costing us.
    if ((notificationType === 'REFUND' || notificationType === 'REVOKE') && userStates[userId]?.metaApiAccountId) {
        try {
            await undeployMetaApiAccount(userStates[userId].metaApiAccountId);
            await supabase
                .from('purchases')
                .update({ meta_api_undeployed_at: new Date().toISOString() })
                .eq('user_id', userId);
            userStates[userId].mt5Connected = false;
            console.log(`[apple-notify] Immediate undeploy after ${notificationType} for ${userId.slice(0,8)}`);
        } catch (e) {
            console.error(`[apple-notify] Immediate undeploy failed for ${userId}:`, e.message);
        }
    }

    // 5) If a previously-undeployed account just resubscribed, redeploy so
    //    the user doesn't have to walk through MT5 reconnect again.
    if (newStatus === 'active' || newStatus === 'trialing') {
        const { data: row } = await supabase
            .from('purchases')
            .select('meta_api_account_id, meta_api_undeployed_at')
            .eq('user_id', userId)
            .maybeSingle();
        if (row?.meta_api_account_id && row?.meta_api_undeployed_at) {
            try {
                await deployMetaApiAccount(row.meta_api_account_id);
                await supabase
                    .from('purchases')
                    .update({ meta_api_undeployed_at: null })
                    .eq('user_id', userId);
                if (userStates[userId]) userStates[userId].mt5Connected = true;
                console.log(`[apple-notify] Redeployed MetaAPI ${row.meta_api_account_id} after resubscribe`);
            } catch (e) {
                console.error(`[apple-notify] Redeploy failed for ${userId}:`, e.message);
            }
        }
    }

    console.log(`[apple-notify] Applied ${notificationType}${subtype ? '/' + subtype : ''} → ${newStatus ?? 'no-status-change'} for ${userId.slice(0,8)}`);
}

// Look up the EmotionLock userId for a notification. Prefers appAccountToken
// (set at purchase via PurchaseOption.appAccountToken — see iOS StoreKitManager)
// and falls back to originalTransactionId for purchases made before that
// option was wired up.
async function resolveUserIdFromAppleIds(appAccountToken, originalTransactionId) {
    if (appAccountToken) {
        const { data } = await supabase
            .from('purchases')
            .select('user_id')
            .ilike('app_account_token', appAccountToken)
            .maybeSingle();
        if (data?.user_id) return data.user_id;
        // appAccountToken IS our userId by construction, so even if no row
        // exists yet, the value itself is the canonical id. The next iOS
        // /purchase call will populate the row.
        if (UUID_V4_RE.test(appAccountToken)) return appAccountToken;
    }
    if (originalTransactionId) {
        const { data } = await supabase
            .from('purchases')
            .select('user_id')
            .eq('original_transaction_id', originalTransactionId)
            .maybeSingle();
        if (data?.user_id) return data.user_id;
        // Last-resort fallback: license_code uses the prefix IAP-<transactionId>
        // for the original purchase. Try that mapping so refunds on the
        // license still find a row.
        const { data: byCode } = await supabase
            .from('purchases')
            .select('user_id')
            .eq('license_code', `IAP-${originalTransactionId}`)
            .maybeSingle();
        if (byCode?.user_id) return byCode.user_id;
    }
    return null;
}

// Save user profile (collected after MT5 license purchase in the app)
// Public endpoint, auth is the userId itself (UUID from Keychain, same pattern as all other user endpoints)
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

    // Block "plus addressing" (foo+1@gmail.com, foo+anything@gmail.com all
    // land in foo@gmail.com). Without this check a single Gmail user can
    // generate unlimited "unique" emails to claim multiple free trials.
    //
    // Allowlist: the admin's own address (janssenbart92@gmail.com) is
    // exempt because Bart relies on plus-addressing to test the trial flow
    // end-to-end with fresh "users" that all land in his real inbox.
    // The local part is checked case-insensitively against the bare name
    // (before the '+'). Any other plus address is rejected.
    if (email.includes('+')) {
        const localPart = String(email).trim().toLowerCase().split('@')[0] || '';
        const beforePlus = localPart.split('+')[0];
        const isAdminTest = beforePlus === 'janssenbart92';
        if (!isAdminTest) {
            return res.status(400).json({
                error: 'invalid_email',
                message: 'Please use your real email address, without a plus sign.',
            });
        }
    }

    try {
        // Check whether a profile already exists so we only send the
        // admin notification on the FIRST save, not on every edit.
        const { data: existingProfile } = await supabase
            .from('profiles')
            .select('user_id')
            .ilike('user_id', userId)
            .maybeSingle();
        const isNewProfile = !existingProfile;

        const cleanFirstName = firstName.trim();
        const cleanLastName  = lastName.trim();
        const cleanEmail     = email.trim().toLowerCase();

        // Email-based trial inheritance.
        //
        // Scenario: user installs the app, signs up with email X, starts their
        // 7-day trial, deletes the app, reinstalls with a different Apple ID,
        // re-signs up with the same email X. Keychain hands them a fresh
        // userId, so they would otherwise get a fresh 7-day trial. We block
        // that by looking up the email on a different userId and, if found,
        // copying the original app_trial_started_at / app_trial_ends_at over
        // to the new userId's purchases row.
        //
        // The unique index on profiles.email (migration 002) is the final
        // belt-and-braces guard, but we handle the inheritance here so
        // returning users with the same email never see a duplicate-email
        // error — they just keep their original trial window.
        let inheritedTrialStartedAt = null;
        let inheritedTrialEndsAt = null;
        if (isNewProfile) {
            const { data: emailMatch } = await supabase
                .from('profiles')
                .select('user_id')
                .eq('email', cleanEmail)
                .neq('user_id', userId)
                .maybeSingle();
            if (emailMatch?.user_id) {
                // SECURITY: Before we touch the previous owner's email + trial,
                // verify they are dormant. A user who already paid (has a
                // license OR an active subscription OR is mid-trial) must NOT
                // have their email blanked by someone else signing up with
                // their address. Otherwise an attacker can hijack the email
                // of any paying user and inherit their trial dates.
                const { data: oldPurchase } = await supabase
                    .from('purchases')
                    .select('app_trial_started_at, app_trial_ends_at, license_code, subscription_status, original_transaction_id')
                    .eq('user_id', emailMatch.user_id)
                    .maybeSingle();

                const oldHasLicense = !!oldPurchase?.license_code;
                const oldSubActive = oldPurchase?.subscription_status === 'active'
                                   || oldPurchase?.subscription_status === 'trialing';
                const oldHasOriginalTransaction = !!oldPurchase?.original_transaction_id;
                const oldAppTrialEnds = oldPurchase?.app_trial_ends_at ? new Date(oldPurchase.app_trial_ends_at).getTime() : null;
                const oldAppTrialActive = oldAppTrialEnds !== null && oldAppTrialEnds > Date.now();

                const oldIsDormant = !oldHasLicense
                    && !oldSubActive
                    && !oldHasOriginalTransaction
                    && !oldAppTrialActive;

                if (!oldIsDormant) {
                    console.warn(`[profile] Refusing email reuse: ${cleanEmail} belongs to non-dormant userId ${emailMatch.user_id.slice(0,8)}`);
                    return res.status(409).json({
                        error: 'email_in_use',
                        message: 'This email is already linked to an active EmotionLock account. Contact support if this is your account.',
                    });
                }

                if (oldPurchase?.app_trial_started_at) {
                    inheritedTrialStartedAt = oldPurchase.app_trial_started_at;
                    inheritedTrialEndsAt = oldPurchase.app_trial_ends_at;
                    console.log(`[profile] Email match found for ${cleanEmail} (dormant), inheriting trial window from previous userId`);
                }
                // Old user is dormant: free up the email so the unique index
                // does not reject our new profile row. We blank rather than
                // delete the profile because purchases references it via
                // user_id, and we still want admin to be able to audit.
                await supabase
                    .from('profiles')
                    .update({ email: null })
                    .eq('user_id', emailMatch.user_id);
            }
        }

        const { error } = await supabase.from('profiles').upsert(
            {
                user_id:    userId,
                first_name: cleanFirstName,
                last_name:  cleanLastName,
                email:      cleanEmail,
                updated_at: new Date().toISOString(),
            },
            { onConflict: 'user_id' }
        );

        if (error) {
            console.error('[profile] Supabase upsert error:', error.message);
            // 23505 = unique_violation. Surface a clean error so the iOS app
            // can show the user a helpful message rather than "Unexpected error".
            if (error.code === '23505') {
                return res.status(409).json({
                    error: 'email_in_use',
                    message: 'This email is already linked to another EmotionLock account.',
                });
            }
            return res.status(500).json({ error: 'Failed to save profile. Please try again.' });
        }

        // Propagate the inherited trial window to this userId's purchases row.
        // Upsert because the row may not exist yet (purchases is normally
        // created on first /connect-mt5 or first /purchase).
        if (inheritedTrialStartedAt) {
            await supabase.from('purchases').upsert({
                user_id: userId,
                app_trial_started_at: inheritedTrialStartedAt,
                app_trial_ends_at: inheritedTrialEndsAt,
            }, { onConflict: 'user_id' });
            invalidateSubscriptionCache(userId);
        }

        console.log(`[profile] Saved profile for user ${userId}`);
        res.json({ success: true });

        // Fire-and-forget admin notification for new signups only. Awaiting
        // would delay the iOS app for no good reason since the user does not
        // care about the email roundtrip.
        if (isNewProfile) {
            notifyAdmin({
                subject: `New EmotionLock account: ${cleanFirstName} ${cleanLastName}`,
                lines: [
                    `${cleanFirstName} ${cleanLastName} just created an account.`,
                    '',
                    `Email:   ${cleanEmail}`,
                    `User ID: ${userId}`,
                    `Time:    ${adminNotifyTimestamp()} (Europe/Amsterdam)`,
                    '',
                    'View in Command Center: https://emotionlock.app/command',
                ],
            }).catch(() => {});
        }
    } catch (err) {
        console.error('[profile] Unexpected error:', err);
        res.status(500).json({ error: 'Unexpected error. Please try again.' });
    }
});

// Delete account — required by Apple App Store policy.
// Must work even when in-memory state is empty (e.g. cold Railway restart
// before any /status call). Source of truth is Supabase + MetaAPI.
app.delete('/delete-account/:userId', async (req, res) => {
    const { userId } = req.params;

    if (!UUID_V4_RE.test(userId)) {
        return res.status(400).json({ error: 'Invalid userId format.' });
    }

    try {
        // Resolve the MetaAPI account ID from BOTH sources. In-memory if loaded,
        // otherwise Supabase. We must NOT 404 just because the user hasn't
        // opened the app this session — Apple requires deletion to succeed
        // for any account that exists server-side.
        let metaApiAccountId = userStates[userId]?.metaApiAccountId ?? null;
        if (!metaApiAccountId) {
            const { data: row } = await supabase
                .from('purchases')
                .select('meta_api_account_id')
                .eq('user_id', userId)
                .maybeSingle();
            metaApiAccountId = row?.meta_api_account_id ?? null;
        }

        // MetaAPI cleanup: undeploy AND delete the account so we stop paying
        // MetaAPI's hourly cost. Failure here must not block the rest of
        // the deletion — we log and continue.
        if (metaApiAccountId) {
            try {
                await undeployAndDeleteMetaApiAccount(metaApiAccountId);
            } catch (e) {
                console.log(`[delete-account] MetaAPI cleanup warning for ${userId}:`, e.message);
            }
        }

        // Drop in-memory state if present. Idempotent — safe to call even
        // when the entry doesn't exist.
        delete userStates[userId];
        invalidateSubscriptionCache(userId);

        // Supabase cleanup. We DELETE the purchases row entirely so a
        // re-installing user gets a clean slate. Apple still has the
        // receipt history server-side via App Store Server Notifications,
        // so we are not losing audit trail for refunds.
        const { error: purchaseErr } = await supabase
            .from('purchases')
            .delete()
            .eq('user_id', userId);
        if (purchaseErr) {
            console.error(`[delete-account] Supabase purchases delete failed for ${userId}:`, purchaseErr.message);
        }

        // Profile data (GDPR).
        const { error: profileErr } = await supabase
            .from('profiles')
            .delete()
            .eq('user_id', userId);
        if (profileErr) {
            console.error(`[delete-account] Supabase profiles delete failed for ${userId}:`, profileErr.message);
        }

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

// =====================
// Weekly Stats Digest
// Sends a transactional notification email to the admin via Resend.
// Used for one-off events (new profile, new license purchase) where we want
// to be alerted in real time. Fire-and-forget on the caller side: never
// blocks the request and silently no-ops when RESEND_API_KEY is missing so
// local development without the key keeps working.
async function notifyAdmin({ subject, lines }) {
    if (!process.env.RESEND_API_KEY) {
        debugLog('[notify] RESEND_API_KEY not set, skipping admin notification.');
        return;
    }
    try {
        const text = Array.isArray(lines) ? lines.join('\n') : String(lines);
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: 'noreply@emotionlock.app',
                to: [process.env.ADMIN_EMAIL || 'janssenbart92@gmail.com'],
                subject,
                text,
            }),
        });
        if (!res.ok) {
            const err = await res.text();
            console.error('[notify] Failed to send admin notification:', err);
        }
    } catch (err) {
        console.error('[notify] Error sending admin notification:', err?.message ?? err);
    }
}

// Formats the current moment in the Europe/Amsterdam timezone so the
// notification emails read consistently regardless of where Railway runs.
function adminNotifyTimestamp() {
    return new Date().toLocaleString('nl-NL', {
        timeZone: 'Europe/Amsterdam',
        dateStyle: 'short',
        timeStyle: 'short',
    });
}

// Sends a Monday morning email summary to the admin via Resend
// Requires RESEND_API_KEY environment variable in Railway
// =====================
async function sendWeeklyStatsDigest() {
    if (!process.env.RESEND_API_KEY) {
        debugLog('[Digest] RESEND_API_KEY not set, skipping weekly digest.');
        return;
    }

    try {
        const { data: users } = await supabase.from('user_overview').select('*');
        const { data: opps } = await supabase
            .from('opportunities')
            .select('*')
            .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());

        const totalUsers      = users?.length ?? 0;
        const activeLicense   = users?.filter(u => u.has_license).length ?? 0;
        const activeSub       = users?.filter(u => u.has_active_subscription).length ?? 0;
        const mt5Connected    = users?.filter(u => u.has_mt5).length ?? 0;
        const newOpps         = opps?.length ?? 0;
        const responded       = opps?.filter(o => o.status === 'responded').length ?? 0;
        const pending         = newOpps - responded;

        const dateStr = new Date().toLocaleDateString('en-GB', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            timeZone: 'Europe/Amsterdam'
        });

        const emailText = [
            'EmotionLock — Weekly Stats Digest',
            dateStr,
            '',
            'USERS',
            `Total accounts:       ${totalUsers}`,
            `License activated:    ${activeLicense}`,
            `Active subscription:  ${activeSub}`,
            `MT5 connected:        ${mt5Connected}`,
            '',
            'COMMUNITY OPPORTUNITIES (LAST 7 DAYS)',
            `New threads found:    ${newOpps}`,
            `Responded:            ${responded}`,
            `Pending response:     ${pending}`,
            '',
            'ACTION',
            'Review Command Center: https://emotionlock.app/command',
        ].join('\n');

        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: 'noreply@emotionlock.app',
                to: [process.env.ADMIN_EMAIL || 'janssenbart92@gmail.com'],
                subject: `EmotionLock Weekly — ${dateStr}`,
                text: emailText,
            }),
        });

        if (res.ok) {
            console.log('[Digest] Weekly stats digest sent.');
        } else {
            const err = await res.text();
            console.error('[Digest] Failed to send digest:', err);
        }
    } catch (err) {
        console.error('[Digest] Error generating weekly digest:', err?.message ?? err);
    }
}

// Schedule: every Monday at 07:00 Europe/Amsterdam
// setInterval cannot handle timezone-aware scheduling, so we use a simple
// check: run every hour, send only when it is Monday 07:xx Amsterdam time.
setInterval(async () => {
    const now = new Date();
    const amsterdam = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
    if (amsterdam.getDay() === 1 && amsterdam.getHours() === 7 && amsterdam.getMinutes() < 60) {
        await sendWeeklyStatsDigest();
    }
}, 60 * 60 * 1000); // check every hour
