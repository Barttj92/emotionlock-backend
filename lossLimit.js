'use strict';

// Loss-limit mode: pure helpers, no I/O, so they can be unit tested in
// isolation (see test/lossLimit.test.js). index.js owns persistence, pushes
// and the polling loop; this module only decides numbers and lock state.
//
// Two limit modes exist and a user always has exactly one active:
//   'trades' (default): lock when tradesCount >= maxTrades (unchanged logic)
//   'loss':             lock when the realized net P&L of today is at or
//                       below -maxDailyLoss (account currency)
//
// Loss mode is only effective when the LOSS_MODE_ENABLED feature flag is on.
// With the flag off every user behaves exactly like before this module
// existed, even if their Supabase row says limit_mode = 'loss'.

const LIMIT_MODES = Object.freeze(['trades', 'loss']);
const DEFAULT_LIMIT_MODE = 'trades';

const MAX_DAILY_LOSS_MIN = 1;
const MAX_DAILY_LOSS_MAX = 10000000;

// Only real trade executions carry P&L. Deposits, withdrawals, credit, bonus
// and broker charges (DEAL_TYPE_BALANCE, _CREDIT, _BONUS, _CHARGE, ...) are
// money movements, not trading results, and must never move the limit.
const TRADE_DEAL_TYPES = new Set(['DEAL_TYPE_BUY', 'DEAL_TYPE_SELL']);

// Money is compared in integer cents to avoid float edge cases such as
// -199.99999999 not counting as -200.
function toCents(amount) {
    return Math.round(Number(amount) * 100);
}

function fromCents(cents) {
    return cents / 100;
}

function finiteOrZero(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// Net realized amount of one deal: profit + commission + swap + fee.
// Returns null for deals that are not trade executions (never counted).
// A trade deal with no financial fields at all (e.g. some crypto deals with
// profit null) counts as 0 rather than blocking the calculation.
function dealNetAmount(deal) {
    if (!deal || !TRADE_DEAL_TYPES.has(deal.type)) return null;
    const cents = toCents(finiteOrZero(deal.profit))
        + toCents(finiteOrZero(deal.commission))
        + toCents(finiteOrZero(deal.swap))
        + toCents(finiteOrZero(deal.fee));
    return fromCents(cents);
}

// Fold a batch of deals into user.dailyNetPnl. Idempotent: every deal id is
// counted at most once per day via user.pnlDealIds, so the 60s overlap window
// of the polling loop never double counts. Mutates user. Returns true when
// the total changed.
function applyDealsToPnl(user, deals) {
    if (!Array.isArray(deals) || deals.length === 0) return false;
    if (!(user.pnlDealIds instanceof Set)) user.pnlDealIds = new Set();
    let cents = toCents(finiteOrZero(user.dailyNetPnl));
    let changed = false;
    for (const deal of deals) {
        if (!deal || deal.id === undefined || deal.id === null) continue;
        if (user.pnlDealIds.has(deal.id)) continue;
        const amount = dealNetAmount(deal);
        if (amount === null) continue;
        user.pnlDealIds.add(deal.id);
        if (amount !== 0) {
            cents += toCents(amount);
            changed = true;
        }
    }
    user.dailyNetPnl = fromCents(cents);
    return changed;
}

// Recompute today's P&L from scratch (first poll after connect or restart).
// The seed holds every deal of the day, so it is the source of truth.
function recomputePnl(user, deals) {
    user.pnlDealIds = new Set();
    user.dailyNetPnl = 0;
    applyDealsToPnl(user, deals);
    return user.dailyNetPnl;
}

function isValidMaxDailyLoss(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    if (value < MAX_DAILY_LOSS_MIN || value > MAX_DAILY_LOSS_MAX) return false;
    // At most 2 decimals.
    return Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}

function isLossLimitReached(dailyNetPnl, maxDailyLoss) {
    if (!isValidMaxDailyLoss(maxDailyLoss)) return false;
    return toCents(finiteOrZero(dailyNetPnl)) <= -toCents(maxDailyLoss);
}

// The mode that actually drives locking. Loss mode needs both the global
// flag and a valid limit; anything else falls back to trade counting.
function effectiveLimitMode(user, lossModeEnabled) {
    if (!lossModeEnabled) return 'trades';
    if (user.limitMode !== 'loss') return 'trades';
    if (!isValidMaxDailyLoss(user.maxDailyLoss)) return 'trades';
    return 'loss';
}

// Single place that answers "is this user over their limit right now".
// In trade mode this is exactly the historical tradesCount >= maxTrades.
function isLimitReached(user, lossModeEnabled) {
    if (effectiveLimitMode(user, lossModeEnabled) === 'loss') {
        return isLossLimitReached(user.dailyNetPnl, user.maxDailyLoss);
    }
    return user.tradesCount >= user.maxTrades;
}

// Loss-mode lock decision after a poll. Returns 'lock' | 'none'.
// positionClosed: at least one position was fully closed this poll.
// pnlChanged:     today's net P&L moved this poll (includes partial closes).
// lossUnlockPending: set by an emergency unlock. It grants one extra trade,
// so the lock may only come back once the NEXT position has closed; P&L
// movement from partial closes or entry commissions alone does not relock.
// Mutates user.lossUnlockPending (cleared once that trade has closed).
function decideLossLock(user, { positionClosed, pnlChanged }) {
    if (!positionClosed && !pnlChanged) return 'none';
    if (user.lossUnlockPending) {
        if (!positionClosed) return 'none';
        user.lossUnlockPending = false;
    }
    if (user.isLocked) return 'none';
    return isLossLimitReached(user.dailyNetPnl, user.maxDailyLoss) ? 'lock' : 'none';
}

// Apply a limit-mode switch that was scheduled for the daily reset.
// Mutates user, returns true when something was applied.
function applyPendingLimitMode(user) {
    const mode = user.pendingLimitMode;
    if (!mode || !LIMIT_MODES.includes(mode)) {
        user.pendingLimitMode = null;
        user.pendingLimitValue = null;
        return false;
    }
    const value = user.pendingLimitValue;
    if (mode === 'loss') {
        if (!isValidMaxDailyLoss(value)) {
            user.pendingLimitMode = null;
            user.pendingLimitValue = null;
            return false;
        }
        user.maxDailyLoss = value;
    } else if (Number.isInteger(value) && value >= 1) {
        // maxTrades is never cleared when switching to loss, so a switch back
        // without a new value simply restores the previous trade limit.
        user.maxTrades = value;
    }
    user.limitMode = mode;
    user.pendingLimitMode = null;
    user.pendingLimitValue = null;
    return true;
}

// Compare dotted version strings ("1.4.2"). Missing or malformed input sorts
// lowest, so an old app without a version header never unlocks loss mode.
function compareVersions(a, b) {
    const parse = v => (typeof v === 'string' && /^\d+(\.\d+)*$/.test(v.trim()))
        ? v.trim().split('.').map(n => parseInt(n, 10))
        : null;
    const pa = parse(a);
    const pb = parse(b);
    if (!pa && !pb) return 0;
    if (!pa) return -1;
    if (!pb) return 1;
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const x = pa[i] ?? 0;
        const y = pb[i] ?? 0;
        if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
}

function formatMoney(amount, currency) {
    const text = (Math.round(Number(amount) * 100) / 100).toFixed(2).replace(/\.00$/, '');
    return currency ? `${text} ${currency}` : text;
}

module.exports = {
    LIMIT_MODES,
    DEFAULT_LIMIT_MODE,
    MAX_DAILY_LOSS_MIN,
    MAX_DAILY_LOSS_MAX,
    toCents,
    dealNetAmount,
    applyDealsToPnl,
    recomputePnl,
    isValidMaxDailyLoss,
    isLossLimitReached,
    effectiveLimitMode,
    isLimitReached,
    decideLossLock,
    applyPendingLimitMode,
    compareVersions,
    formatMoney,
};
