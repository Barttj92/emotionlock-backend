const express = require('express');
const apn = require('apn');
const app = express();
app.use(express.json());

// APNs setup via environment variables
let apnProvider = null;
if (process.env.APNS_KEY_BASE64) {
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
} else {
    console.log('APNs not configured (no APNS_KEY_BASE64 env var)');
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

const userStates = {};

const DEFAULT_TOKENS = 3;

// Check of het tijd is voor weekly token reset (zondag 22:00 UTC+1 = 21:00 UTC)
function shouldResetWeeklyTokens(lastTokenReset) {
    if (!lastTokenReset) return true;
    
    const now = new Date();
    const last = new Date(lastTokenReset);
    
    // Zondag = 0 in JavaScript
    const nowUTC1Hour = (now.getUTCHours() + 1) % 24;
    const nowDay = now.getUTCDay();
    
    // Is het zondag na 22:00 UTC+1?
    const isResetTime = nowDay === 0 && nowUTC1Hour >= 22;
    
    // Was de laatste reset voor deze zondag 22:00?
    const lastResetDay = last.getUTCDay();
    const lastResetHourUTC1 = (last.getUTCHours() + 1) % 24;
    const wasBeforeReset = lastResetDay !== 0 || lastResetHourUTC1 < 22;
    
    // Reset als het reset tijd is EN de laatste reset voor deze reset tijd was
    const daysDiff = Math.floor((now - last) / (1000 * 60 * 60 * 24));
    
    return isResetTime && daysDiff >= 1 && wasBeforeReset || daysDiff >= 7;
}

function initUser(userId) {
    if (!userStates[userId]) {
        userStates[userId] = {
            tradesCount: 0,
            isLocked: false,
            emergencyUnlocked: false,
            emergencyTokens: DEFAULT_TOKENS,
            lastReset: new Date().toDateString(),
            lastTokenReset: new Date().toISOString(),
            deviceToken: null,
            maxTrades: 1
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
    }
}

function checkWeeklyTokenReset(user) {
    if (shouldResetWeeklyTokens(user.lastTokenReset)) {
        console.log('Weekly token reset uitgevoerd!');
        user.emergencyTokens = DEFAULT_TOKENS;
        user.lastTokenReset = new Date().toISOString();
    }
}

// Webhook endpoint
app.post('/webhook', (req, res) => {
    const { userId, action, isWin } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    initUser(userId);
    const user = userStates[userId];
    checkDailyReset(user);
    checkWeeklyTokenReset(user);

    if (action === 'trade_closed') {
        user.tradesCount += 1;
        const maxTrades = req.body.maxTrades || user.maxTrades || 1;
        user.maxTrades = maxTrades;
        console.log(`User ${userId}: trade closed. Total today: ${user.tradesCount}/${maxTrades}`);

        // Send push notification when limit is reached
        if (user.tradesCount >= maxTrades && !user.emergencyUnlocked) {
            console.log(`User ${userId}: limit reached, sending push notification`);
            sendPushNotification(
                user.deviceToken,
                '🔒 EmotionLock activated',
                `You've reached your limit of ${maxTrades} trade${maxTrades > 1 ? 's' : ''} today. Trading apps are now blocked.`
            );
        }
    }

    res.json({
        success: true,
        tradesCount: user.tradesCount,
        isLocked: user.isLocked,
        emergencyUnlocked: user.emergencyUnlocked,
        emergencyTokens: user.emergencyTokens
    });
});

// Register device token for push notifications
app.post('/register-device/:userId', (req, res) => {
    const { userId } = req.params;
    const { deviceToken } = req.body;

    if (!deviceToken) return res.status(400).json({ error: 'deviceToken is required' });

    initUser(userId);
    userStates[userId].deviceToken = deviceToken;
    console.log(`User ${userId}: device token registered`);

    res.json({ success: true });
});

// Status endpoint
app.get('/status/:userId', (req, res) => {
    const { userId } = req.params;
    
    initUser(userId);
    const user = userStates[userId];
    checkDailyReset(user);
    checkWeeklyTokenReset(user);

    res.json({
        tradesCount: user.tradesCount,
        isLocked: user.isLocked,
        emergencyUnlocked: user.emergencyUnlocked,
        emergencyTokens: user.emergencyTokens
    });
});

// Unlock endpoint
app.post('/unlock/:userId', (req, res) => {
    const { userId } = req.params;
    
    initUser(userId);
    const user = userStates[userId];
    checkWeeklyTokenReset(user);

    if (user.emergencyTokens <= 0) {
        return res.status(400).json({ error: 'Geen tokens meer beschikbaar' });
    }

    user.isLocked = false;
    user.emergencyUnlocked = true;
    user.emergencyTokens -= 1;

    console.log(`User ${userId}: UNLOCKED via emergency token. Tokens over: ${user.emergencyTokens}`);
    res.json({ 
        success: true, 
        isLocked: false, 
        emergencyUnlocked: true,
        emergencyTokens: user.emergencyTokens
    });
});

// Lock endpoint
app.post('/lock/:userId', (req, res) => {
    const { userId } = req.params;
    
    initUser(userId);
    userStates[userId].isLocked = true;

    console.log(`User ${userId}: LOCKED`);
    res.json({ success: true, isLocked: true });
});

app.get('/', (req, res) => {
    res.json({ status: 'EmotionLock backend running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`EmotionLock backend draait op port ${PORT}`);
});
