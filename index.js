const express = require('express');
const apn = require('apn');
const { createClient } = require('@supabase/supabase-js');
const app = express();
app.use(express.json());

// =====================
// Supabase setup
// =====================
const supabase = createClient(
    process.env.SUPABASE_URL || 'https://ixlmaqkhgjgmijlbstia.supabase.co',
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
    if (!apnProvider || !deviceToken) return;
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
const DEFAULT_TOKENS = 3;

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

function checkDailyReset(user) {
    const today = new Date().toDateString();
    if (user.lastReset !== today) {
        user.tradesCount = 0;
        user.isLocked = false;
        user.emergencyUnlocked = false;
        user.lastReset = today;
        user.processedDealIds = new Set();
    }
}

function shouldResetWeeklyTokens(lastTokenReset) {
    if (!lastTokenReset) return true;
    const now = new Date();
    const last = new Date(lastTokenReset);
    const nowUTC1Hour = (now.getUTCHours() + 1) % 24;
    const nowDay = now.getUTCDay();
    const isResetTime = nowDay === 0 && nowUTC1Hour >= 22;
    const lastResetDay = last.getUTCDay();
    const lastResetHourUTC1 = (last.getUTCHours() + 1) % 24;
    const wasBeforeReset = lastResetDay !== 0 || lastResetHourUTC1 < 22;
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
            console.log(`User ${userId}: MetaApi account not found`);
            return;
        }

        if (accountInfo.region) user.mt5Region = accountInfo.region;

        const isReady = accountInfo.state === 'DEPLOYED' &&
            (accountInfo.connectionStatus === 'CONNECTED' || accountInfo.connectionStatus === 'SYNCHRONIZING');

        if (!isReady) {
            console.log(`User ${userId}: account not ready yet (${accountInfo.state} / ${accountInfo.connectionStatus})`);
            return;
        }

        const todayMidnight = new Date();
        todayMidnight.setHours(0, 0, 0, 0);
        const fromTime = todayMidnight.toISOString();
        const toTime = new Date().toISOString();

        const deals = await getDeals(user.metaApiAccountId, user.mt5Region, fromTime, toTime);

        let newTradesDetected = false;

        for (const deal of deals) {
            if (user.processedDealIds.has(deal.id)) continue;

            const isTradeClosed = deal.entryType === 'DEAL_ENTRY_OUT' || deal.entryType === 'DEAL_ENTRY_INOUT';
            if (!isTradeClosed) continue;
            if (deal.type === 'DEAL_TYPE_BALANCE') continue;

            const isWin = (deal.profit || 0) > 0;
            if (!user.countWinningTrades && isWin) {
                user.processedDealIds.add(deal.id);
                continue;
            }

            user.processedDealIds.add(deal.id);
            user.tradesCount++;
            newTradesDetected = true;

            console.log(`User ${userId}: trade counted. Profit: ${deal.profit}. Total: ${user.tradesCount}/${user.maxTrades}`);
        }

        // If a new trade came in after an emergency unlock, reset the emergency so locking can trigger again
        if (newTradesDetected && user.emergencyUnlocked) {
            user.emergencyUnlocked = false;
            console.log(`User ${userId}: new trade after emergency unlock — resetting emergency state`);
        }

        if (newTradesDetected && user.tradesCount >= user.maxTrades && !user.isLocked) {
            user.isLocked = true;
            console.log(`User ${userId}: trade limit reached (${user.tradesCount}/${user.maxTrades}), sending push`);
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

app.get('/', (req, res) => {
    res.json({ status: 'EmotionLock backend running' });
});

// Activate license code
app.post('/activate', async (req, res) => {
    const { licenseCode } = req.body;
    if (!licenseCode) return res.status(400).json({ error: 'licenseCode required' });

    const key = licenseCode.toUpperCase().trim();

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
        console.log(`Restored MT5 connection for ${key}: ${purchase.mt5_server}`);
    }
    if (purchase?.max_trades) userStates[key].maxTrades = purchase.max_trades;
    if (purchase?.count_winning_trades !== undefined) userStates[key].countWinningTrades = purchase.count_winning_trades;

    console.log(`License activated: ${key}`);
    res.json({ success: true, userId: key });
});

// Connect MT5 account
app.post('/connect-mt5/:userId', async (req, res) => {
    const { userId } = req.params;
    const { server, login, password } = req.body;

    if (!userStates[userId]) {
        return res.status(404).json({ error: 'User not found. Activate your license first.' });
    }
    if (!server || !login || !password) {
        return res.status(400).json({ error: 'server, login and password are required' });
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

        console.log(`MT5 connected for user ${userId}: ${server} #${login}`);
        res.json({
            success: true,
            server,
            login: String(login),
            message: 'Connecting... it may take a few minutes to fully sync.'
        });

    } catch (err) {
        console.error(`MT5 connect error for ${userId}:`, err.message);
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
    }
});

// Status endpoint
app.get('/status/:userId', async (req, res) => {
    const { userId } = req.params;
    const isNewUser = !userStates[userId];
    initUser(userId);
    const user = userStates[userId];
    checkDailyReset(user);
    checkWeeklyTokenReset(user);

    // On server restart, reload persisted token count from Supabase
    if (isNewUser) {
        const storedTokens = await getStoredTokens(userId);
        if (storedTokens !== null) {
            user.emergencyTokens = storedTokens;
            console.log(`Server restart: restored ${storedTokens} tokens for ${userId}`);
        }
    }

    res.json({
        tradesCount: user.tradesCount,
        isLocked: user.isLocked,
        emergencyUnlocked: user.emergencyUnlocked,
        emergencyTokens: user.emergencyTokens,
        mt5Connected: user.mt5Connected,
        mt5Server: user.mt5Server,
        mt5Login: user.mt5Login,
        maxTrades: user.maxTrades,
    });
});

// Update user settings
app.post('/settings/:userId', (req, res) => {
    const { userId } = req.params;
    const { maxTrades, countWinningTrades } = req.body;
    if (!userStates[userId]) {
        initUser(userId);
    }
    const user = userStates[userId];
    if (maxTrades !== undefined) user.maxTrades = maxTrades;
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
});

// Emergency unlock
app.post('/unlock/:userId', async (req, res) => {
    const { userId } = req.params;
    initUser(userId);
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
    console.log(`User ${userId}: emergency unlock. Tokens left: ${user.emergencyTokens}`);
    res.json({ success: true, isLocked: false, emergencyUnlocked: true, emergencyTokens: user.emergencyTokens });
});

// Register device push token
app.post('/register-device/:userId', (req, res) => {
    const { userId } = req.params;
    const { deviceToken } = req.body;
    if (!deviceToken) return res.status(400).json({ error: 'deviceToken required' });
    initUser(userId);
    userStates[userId].deviceToken = deviceToken;
    console.log(`User ${userId}: device token registered`);
    res.json({ success: true });
});

// IAP: add tokens after Apple in-app purchase (called directly from the iOS app)
// No admin key needed — userId comes from the app's own session
app.post('/add-tokens-iap/:userId', async (req, res) => {
    const userId = req.params.userId;
    const tokens = parseInt(req.body && req.body.tokens) || 3;
    const transactionId = req.body && req.body.transactionId;

    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    // Idempotency: don't add tokens twice for same Apple transaction ID
    if (transactionId) {
        if (!processedIAPTransactions) global.processedIAPTransactions = new Set();
        if (global.processedIAPTransactions.has(transactionId)) {
            return res.json({ success: true, alreadyProcessed: true });
        }
        global.processedIAPTransactions.add(transactionId);
    }

    if (!userStates[userId]) initUser(userId);
    userStates[userId].emergencyTokens = (userStates[userId].emergencyTokens || 0) + tokens;

    // Persist to Supabase
    try {
        const { data: purchase } = await supabase
            .from('purchases')
            .select('emergency_tokens_remaining, emergency_tokens_purchased')
            .eq('user_id', userId)
            .single();
        if (purchase) {
            await supabase.from('purchases').update({
                emergency_tokens_remaining: (purchase.emergency_tokens_remaining ?? 0) + tokens,
                emergency_tokens_purchased: (purchase.emergency_tokens_purchased ?? 0) + tokens,
            }).eq('user_id', userId);
        }
    } catch (e) {
        console.error('IAP token persist error:', e);
    }

    console.log(`IAP: Added ${tokens} tokens to user ${userId}. Total: ${userStates[userId].emergencyTokens}`);
    res.json({ success: true, tokens: userStates[userId].emergencyTokens });
});

// Admin: generate (or register) license code (called by website after purchase)
// Note: license codes are stored in Supabase purchases table — this endpoint is kept
// for backward compatibility but the website handles Supabase insertion directly.
app.post('/admin/generate-code', async (req, res) => {
    const adminKey = req.headers['x-admin-key'];
    if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
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
    if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const { licenseCode } = req.params;
    const tokens = parseInt(req.body && req.body.tokens) || 3;

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
    if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const [redditCount, twitterCount] = await Promise.all([redditScout(), twitterScout()]);
    res.json({ success: true, reddit: redditCount, twitter: twitterCount });
});

// GET endpoint for scout status
app.get('/scout/status', (req, res) => {
    const adminKey = req.headers['x-admin-key'];
    if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
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
