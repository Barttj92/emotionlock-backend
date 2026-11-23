'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.METAKIT_WEBHOOK_SECRET = 'whsec_test';
process.env.METAKIT_API_KEY = 'stk_live_test';
const metakit = require('../metakit');
const { mapDeal, mapPosition, mapAccount, amsterdamDayStartMs } = metakit._test;

test('ids: prefix round trip and detection', () => {
    assert.strictEqual(metakit.toPrefixedId(56), 'mk:56');
    assert.strictEqual(metakit.toRawId('mk:56'), '56');
    assert.ok(metakit.isMetaKitId('mk:56'));
    assert.ok(!metakit.isMetaKitId('0f2c4a1e-1111-2222-3333-444455556666'));
    assert.ok(!metakit.isMetaKitId(null));
});

test('mapDeal: close deal from the Vantage demo test (23 Nov 2026) maps to MetaAPI shape', () => {
    const d = mapDeal({ comment: '', commission: 0, entry: 'out', fee: 0, magic: 0, order: 2417931272, positionId: 2417927959,
        price: 1.53602, profit: -1.63, reason: 'mobile', swap: 0, symbol: 'CHFSGD', ticket: 1909359748,
        time: '2026-11-23T12:25:46+00:00', type: 'sell', volume: 0.06 });
    assert.strictEqual(d.id, '1909359748');
    assert.strictEqual(d.type, 'DEAL_TYPE_SELL');
    assert.strictEqual(d.entryType, 'DEAL_ENTRY_OUT');
    assert.strictEqual(d.positionId, '2417927959');
    assert.strictEqual(d.profit, -1.63);
    assert.strictEqual(d.commission, 0);
    assert.strictEqual(d.time, '2026-11-23T12:25:46.000Z');
});

test('mapDeal: balance deal has no position and balance type', () => {
    const d = mapDeal({ commission: 0, entry: 'in', fee: 0, order: 0, positionId: 0, price: 0, profit: 10000,
        swap: 0, symbol: '', ticket: 1909335530, time: '2026-11-23T12:18:37+00:00', type: 'balance', volume: 0 });
    assert.strictEqual(d.type, 'DEAL_TYPE_BALANCE');
    assert.strictEqual(d.positionId, undefined);
});

test('mapDeal: inout and unknown types', () => {
    assert.strictEqual(mapDeal({ ticket: 1, entry: 'inout', type: 'buy', time: '2026-11-23T10:00:00Z' }).entryType, 'DEAL_ENTRY_INOUT');
    assert.strictEqual(mapDeal({ ticket: 2, entry: 'out_by', type: 'sell', time: '2026-11-23T10:00:00Z' }).entryType, 'DEAL_ENTRY_OUT_BY');
    assert.strictEqual(mapDeal({ ticket: 3, entry: 'in', type: 'commission', time: '2026-11-23T10:00:00Z' }).type, 'DEAL_TYPE_COMMISSION');
    assert.strictEqual(mapDeal({}), null);
});

test('loss-limit net amount of mapped deals equals MT5 history (-3.82 over 6 closes)', () => {
    const lossLimit = require('../lossLimit');
    const closes = [-1.63, -0.5, -0.5, -0.53, -0.33, -0.33].map((p, i) => mapDeal({
        ticket: 100 + i, entry: 'out', type: 'sell', positionId: 500 + i, profit: p, commission: 0, swap: 0, fee: 0,
        time: '2026-11-23T12:30:00+00:00', symbol: 'X' }));
    const user = { dailyNetPnl: 0, pnlDealIds: new Set() };
    lossLimit.applyDealsToPnl(user, closes);
    assert.strictEqual(user.dailyNetPnl, -3.82);
});

test('mapPosition and mapAccount', () => {
    assert.strictEqual(mapPosition({ ticket: 456, type: 'sell', volume: 0.2 }).id, '456');
    const a = mapAccount({ id: 56, status: 'connected', account_name: 'EmotionLock-x', account_number: 123, server: 'VantageMarkets-Demo', currency: 'USD' });
    assert.deepStrictEqual([a.id, a.state, a.connectionStatus, a.region, a.login], ['mk:56', 'DEPLOYED', 'CONNECTED', 'metakit', '123']);
    assert.strictEqual(mapAccount({ id: 1, status: 'starting' }).state, 'DEPLOYING');
    assert.strictEqual(mapAccount({ id: 1, status: 'disconnected' }).state, 'UNDEPLOYED');
    const err = mapAccount({ id: 1, status: 'error' });
    assert.deepStrictEqual([err.state, err.connectionStatus], ['DEPLOYED', 'DISCONNECTED']);
});

test('amsterdamDayStartMs: midnight Amsterdam in winter (CET) and summer (CEST)', () => {
    assert.strictEqual(new Date(amsterdamDayStartMs(Date.parse('2026-11-23T10:00:00Z'))).toISOString(), '2026-11-22T23:00:00.000Z');
    assert.strictEqual(new Date(amsterdamDayStartMs(Date.parse('2026-07-10T10:00:00Z'))).toISOString(), '2026-07-09T22:00:00.000Z');
    assert.strictEqual(new Date(amsterdamDayStartMs(Date.parse('2026-11-22T23:30:00Z'))).toISOString(), '2026-11-22T23:00:00.000Z');
});

test('verifySignature: valid, tampered, stale', () => {
    const body = '{"event":"position.closed","account_id":56}';
    const t = Math.floor(Date.now() / 1000);
    const v1 = crypto.createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');
    assert.ok(metakit.verifySignature(body, `t=${t},v1=${v1}`));
    assert.ok(!metakit.verifySignature(body + ' ', `t=${t},v1=${v1}`));
    const old = t - 3600;
    const v1old = crypto.createHmac('sha256', 'whsec_test').update(`${old}.${body}`).digest('hex');
    assert.ok(!metakit.verifySignature(body, `t=${old},v1=${v1old}`));
    assert.ok(!metakit.verifySignature(body, null));
});

test('webhookAccountId: trade and account events', () => {
    assert.strictEqual(metakit.webhookAccountId({ event: 'position.closed', account_id: 3 }), 'mk:3');
    assert.strictEqual(metakit.webhookAccountId({ event: 'account.error', account: { id: 7 } }), 'mk:7');
    assert.strictEqual(metakit.webhookAccountId({}), null);
});

test('useMetaKitFor: off by default (MT5_PROVIDER unset), on for test users only', () => {
    assert.strictEqual(metakit.cfg.provider, 'metaapi');
    assert.strictEqual(metakit.useMetaKitFor('ABC'), false);
    metakit.cfg.testUserIds.add('abc');
    assert.strictEqual(metakit.useMetaKitFor('ABC'), true);
    metakit.cfg.testUserIds.delete('abc');
});
