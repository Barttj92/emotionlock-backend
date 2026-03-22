const express = require('express');
const app = express();
app.use(express.json());

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
            lastTokenReset: new Date().toISOString()
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
        console.log(`User ${userId}: trade closed. Total today: ${user.tradesCount}`);
    }

    res.json({
        success: true,
        tradesCount: user.tradesCount,
        isLocked: user.isLocked,
        emergencyUnlocked: user.emergencyUnlocked,
        emergencyTokens: user.emergencyTokens
    });
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
