'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lossLimit');

const deal = (id, type, fields = {}) => ({ id, type, ...fields });

test('dealNetAmount sums profit, commission, swap and fee', () => {
    assert.equal(L.dealNetAmount(deal('1', 'DEAL_TYPE_SELL', { profit: -50.1, commission: -3.5, swap: -1.2, fee: -0.2 })), -55);
});

test('dealNetAmount ignores balance, credit and bonus deals', () => {
    assert.equal(L.dealNetAmount(deal('1', 'DEAL_TYPE_BALANCE', { profit: 1000 })), null);
    assert.equal(L.dealNetAmount(deal('2', 'DEAL_TYPE_CREDIT', { profit: 500 })), null);
    assert.equal(L.dealNetAmount(deal('3', 'DEAL_TYPE_BONUS', { profit: 50 })), null);
});

test('dealNetAmount treats null profit as 0', () => {
    assert.equal(L.dealNetAmount(deal('1', 'DEAL_TYPE_BUY', { profit: null, commission: -2 })), -2);
    assert.equal(L.dealNetAmount(deal('2', 'DEAL_TYPE_BUY', {})), 0);
});

test('entry commission, partial closes and a final close add up', () => {
    const user = { dailyNetPnl: 0 };
    L.applyDealsToPnl(user, [
        deal('in1', 'DEAL_TYPE_BUY', { entryType: 'DEAL_ENTRY_IN', profit: 0, commission: -3.5 }),
        deal('out1', 'DEAL_TYPE_SELL', { entryType: 'DEAL_ENTRY_OUT', profit: -40, commission: -1.75 }),
        deal('out2', 'DEAL_TYPE_SELL', { entryType: 'DEAL_ENTRY_OUT', profit: -60, commission: -1.75, swap: -0.8 }),
        deal('dep', 'DEAL_TYPE_BALANCE', { profit: 5000 }),
    ]);
    assert.equal(user.dailyNetPnl, -107.8);
});

test('applyDealsToPnl is idempotent across overlapping windows', () => {
    const user = { dailyNetPnl: 0 };
    const batch = [deal('a', 'DEAL_TYPE_SELL', { profit: -80 })];
    L.applyDealsToPnl(user, batch);
    const changed = L.applyDealsToPnl(user, [...batch, deal('b', 'DEAL_TYPE_SELL', { profit: -20 })]);
    assert.equal(changed, true);
    assert.equal(user.dailyNetPnl, -100);
    assert.equal(L.applyDealsToPnl(user, batch), false);
});

test('recomputePnl starts from zero', () => {
    const user = { dailyNetPnl: -999, pnlDealIds: new Set(['x']) };
    L.recomputePnl(user, [deal('x', 'DEAL_TYPE_SELL', { profit: -10 })]);
    assert.equal(user.dailyNetPnl, -10);
});

test('float noise does not break the limit comparison', () => {
    const user = { dailyNetPnl: 0 };
    L.applyDealsToPnl(user, [0.1, 0.2, 0.3].map((p, i) => deal(String(i), 'DEAL_TYPE_SELL', { profit: -p })));
    assert.equal(user.dailyNetPnl, -0.6);
    assert.equal(L.isLossLimitReached(-199.999999999, 200), true);
    assert.equal(L.isLossLimitReached(-199.99, 200), false);
    assert.equal(L.isLossLimitReached(-200, 200), true);
});

test('isValidMaxDailyLoss', () => {
    assert.equal(L.isValidMaxDailyLoss(200), true);
    assert.equal(L.isValidMaxDailyLoss(99.95), true);
    assert.equal(L.isValidMaxDailyLoss(0.5), false);
    assert.equal(L.isValidMaxDailyLoss(10.123), false);
    assert.equal(L.isValidMaxDailyLoss(null), false);
    assert.equal(L.isValidMaxDailyLoss(NaN), false);
});

test('flag off keeps every user in trade mode', () => {
    const user = { limitMode: 'loss', maxDailyLoss: 200, dailyNetPnl: -500, tradesCount: 0, maxTrades: 3 };
    assert.equal(L.effectiveLimitMode(user, false), 'trades');
    assert.equal(L.isLimitReached(user, false), false);
    assert.equal(L.isLimitReached(user, true), true);
});

test('trade mode is the historical tradesCount >= maxTrades', () => {
    for (const [count, max, expected] of [[0, 2, false], [1, 2, false], [2, 2, true], [3, 2, true]]) {
        assert.equal(L.isLimitReached({ limitMode: 'trades', tradesCount: count, maxTrades: max }, true), expected);
    }
});

// Canonical loss-mode flow from the plan: limit 200, 2 tokens.
test('canonical loss flow', () => {
    const u = { limitMode: 'loss', maxDailyLoss: 200, dailyNetPnl: 0, isLocked: false, lossUnlockPending: false };
    const close = profit => { u.dailyNetPnl += profit; return L.decideLossLock(u, { positionClosed: true, pnlChanged: true }); };

    assert.equal(close(-80), 'none');               // 1. -80 of 200
    assert.equal(close(-130), 'lock'); u.isLocked = true;   // 2. -210, locked
    u.isLocked = false; u.lossUnlockPending = true;  // 3. token unlock, 1 extra trade
    assert.equal(L.decideLossLock(u, { positionClosed: false, pnlChanged: true }), 'none'); // entry commission alone never relocks
    assert.equal(u.lossUnlockPending, true);
    assert.equal(close(+50), 'none');               // 4. -160, above the limit, stays open
    assert.equal(u.lossUnlockPending, false);
    assert.equal(close(-90), 'lock'); u.isLocked = true;    // 5. -250, locked
    u.maxDailyLoss = 300; u.isLocked = L.isLossLimitReached(u.dailyNetPnl, u.maxDailyLoss); // 6. limit 300
    assert.equal(u.isLocked, false);
    assert.equal(close(-60), 'lock');               // 7. -310, locked
});

test('unlock then a losing extra trade relocks', () => {
    const u = { limitMode: 'loss', maxDailyLoss: 200, dailyNetPnl: -250, isLocked: false, lossUnlockPending: true };
    u.dailyNetPnl = -270;
    assert.equal(L.decideLossLock(u, { positionClosed: true, pnlChanged: true }), 'lock');
});

test('applyPendingLimitMode switches and keeps maxTrades for rollback', () => {
    const u = { limitMode: 'trades', maxTrades: 3, maxDailyLoss: null, pendingLimitMode: 'loss', pendingLimitValue: 250 };
    assert.equal(L.applyPendingLimitMode(u), true);
    assert.equal(u.limitMode, 'loss');
    assert.equal(u.maxDailyLoss, 250);
    assert.equal(u.maxTrades, 3);
    assert.equal(u.pendingLimitMode, null);

    u.pendingLimitMode = 'trades'; u.pendingLimitValue = 5;
    L.applyPendingLimitMode(u);
    assert.equal(u.limitMode, 'trades');
    assert.equal(u.maxTrades, 5);
    assert.equal(u.maxDailyLoss, 250);
});

test('applyPendingLimitMode drops an invalid pending loss value', () => {
    const u = { limitMode: 'trades', maxTrades: 3, pendingLimitMode: 'loss', pendingLimitValue: -5 };
    assert.equal(L.applyPendingLimitMode(u), false);
    assert.equal(u.limitMode, 'trades');
    assert.equal(u.pendingLimitMode, null);
});

test('compareVersions', () => {
    assert.equal(L.compareVersions('1.5.0', '1.5'), 0);
    assert.equal(L.compareVersions('1.10.0', '1.9.9'), 1);
    assert.equal(L.compareVersions(undefined, '1.0'), -1);
    assert.equal(L.compareVersions('abc', '1.0'), -1);
});

test('formatMoney', () => {
    assert.equal(L.formatMoney(200, 'USD'), '200 USD');
    assert.equal(L.formatMoney(99.5, 'EUR'), '99.50 EUR');
    assert.equal(L.formatMoney(150, null), '150');
});
