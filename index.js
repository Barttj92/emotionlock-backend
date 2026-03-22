const express = require('express');
const app = express();
app.use(express.json());

const userStates = {};

app.post('/webhook', (req, res) => {
    const { userId, action, isWin } = req.body;

    if (!userId) {
        return res.status(400).json({ error: 'userId is required' });
    }

    if (!userStates[userId]) {
        userStates[userId] = {
            tradesCount: 0,
            isLocked: false,
            emergencyUnlocked: false,
            lastReset: new Date().toDateString()
        };
    }

    const user = userStates[userId];

    const today = new Date().toDateString();
    if (user.lastReset !== today) {
        user.tradesCount = 0;
        user.isLocked = false;
        user.emergencyUnlocked = false;
        user.lastReset = today;
    }

    if (action === 'trade_closed') {
        user.tradesCount += 1;
        console.log(`User ${userId}: trade closed. Total today: ${user.tradesCount}`);
    }

    res.json({
        success: true,
        tradesCount: user.tradesCount,
        isLocked: user.isLocked,
        emergencyUnlocked: user.emergencyUnlocked
    });
});

app.get('/status/:userId', (req, res) => {
    const { userId } = req.params;
    const user = userStates[userId];

    if (!user) {
        return res.json({ tradesCount: 0, isLocked: false, emergencyUnlocked: false });
    }

    const today = new Date().toDateString();
    if (user.lastReset !== today) {
        user.tradesCount = 0;
        user.isLocked = false;
        user.emergencyUnlocked = false;
        user.lastReset = today;
    }

    res.json({
        tradesCount: user.tradesCount,
        isLocked: user.isLocked,
        emergencyUnlocked: user.emergencyUnlocked
    });
});

app.post('/unlock/:userId', (req, res) => {
    const { userId } = req.params;

    if (!userStates[userId]) {
        userStates[userId] = {
            tradesCount: 0,
            isLocked: false,
            emergencyUnlocked: true,
            lastReset: new Date().toDateString()
        };
    } else {
        userStates[userId].isLocked = false;
        userStates[userId].emergencyUnlocked = true;
    }

    console.log(`User ${userId}: UNLOCKED via emergency token`);
    res.json({ success: true, isLocked: false, emergencyUnlocked: true });
});

app.post('/lock/:userId', (req, res) => {
    const { userId } = req.params;

    if (!userStates[userId]) {
        userStates[userId] = {
            tradesCount: 0,
            isLocked: true,
            emergencyUnlocked: false,
            lastReset: new Date().toDateString()
        };
    } else {
        userStates[userId].isLocked = true;
    }

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
