const express = require('express');
const app = express();
app.use(express.json());

// Opslag per gebruiker (later vervangen door database)
const userStates = {};

// Webhook endpoint - ontvangt signalen van MT5
app.post('/webhook', (req, res) => {
    const { userId, action, isWin } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'userId is required' });
    }

    // Initialiseer gebruiker als die nog niet bestaat
    if (!userStates[userId]) {
        userStates[userId] = {
            tradesCount: 0,
            isLocked: false,
            lastReset: new Date().toDateString()
        };
    }

    const user = userStates[userId];

    // Reset teller als het een nieuwe dag is
    const today = new Date().toDateString();
    if (user.lastReset !== today) {
        user.tradesCount = 0;
        user.isLocked = false;
        user.lastReset = today;
    }

    // Verwerk de trade
    if (action === 'trade_closed') {
        user.tradesCount += 1;
        console.log(`User ${userId}: trade closed. Total today: ${user.tradesCount}`);
    }

    res.json({
        success: true,
        tradesCount: user.tradesCount,
        isLocked: user.isLocked
    });
});

// Status endpoint - app vraagt huidige status op
app.get('/status/:userId', (req, res) => {
    const { userId } = req.params;
    const user = userStates[userId];

    if (!user) {
        return res.json({ tradesCount: 0, isLocked: false });
    }

    // Reset als nieuwe dag
    const today = new Date().toDateString();
    if (user.lastReset !== today) {
        user.tradesCount = 0;
        user.isLocked = false;
        user.lastReset = today;
    }

    res.json({
        tradesCount: user.tradesCount,
        isLocked: user.isLocked
    });
});

// Lock endpoint - zet gebruiker op locked
app.post('/lock/:userId', (req, res) => {
    const { userId } = req.params;

    if (!userStates[userId]) {
        userStates[userId] = {
            tradesCount: 0,
            isLocked: true,
            lastReset: new Date().toDateString()
        };
    } else {
        userStates[userId].isLocked = true;
    }

    console.log(`User ${userId}: LOCKED`);
    res.json({ success: true, isLocked: true });
});

// Unlock endpoint - emergency token gebruikt
app.post('/unlock/:userId', (req, res) => {
    const { userId } = req.params;

    if (userStates[userId]) {
        userStates[userId].isLocked = false;
    }

    console.log(`User ${userId}: UNLOCKED via emergency token`);
    res.json({ success: true, isLocked: false });
});

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'EmotionLock backend running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`EmotionLock backend draait op port ${PORT}`);
});
