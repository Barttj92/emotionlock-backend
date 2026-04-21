# EmotionLock Backend

Node.js/Express backend hosted on Railway. Handles MT5 trade monitoring via MetaAPI, app state per user, and push notifications via APNs.

## Setup

```bash
npm install
cp .env.example .env
# Fill in all values in .env
node index.js
```

## Environment variables

See `.env.example` for all required variables.

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-side only) |
| `METAAPI_TOKEN` | MetaAPI token for MT5 read-only access |
| `ADMIN_KEY` | Secret key for admin endpoints (x-admin-key header) |
| `TWITTER_BEARER_TOKEN` | X/Twitter API v2 bearer token for scout agent |
| `APNS_KEY_BASE` | APNs auth key (base64-encoded .p8 file contents) |
| `APNS_KEY_ID` | APNs key ID |
| `APNS_TEAM_ID` | Apple Developer Team ID |
| `APNS_BUNDLE_ID` | App bundle ID (`com.emotionlock.EmotionLock`) |
| `APNS_PRODUCTION` | Set to `true` for production APNs, omit for sandbox |
| `PORT` | Port to listen on (Railway sets this automatically) |
| `NODE_ENV` | `production` or `development` |

## Key endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/status/:userId` | Returns tradesUsed, isLocked for a user |
| GET | `/settings/:userId` | Returns maxTrades, countWinningTrades |
| POST | `/settings/:userId` | Update user settings |
| POST | `/admin/generate-code` | Generate demo license code (admin only) |
