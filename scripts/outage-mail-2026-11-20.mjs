// One-off: outage notice to all users with access (MetaApi outage 19-20 Nov 2026).
// Usage: node scripts/outage-mail-2026-11-20.mjs  (reads keys from ../emotionlock-website/.env.local, prints no secrets)
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync(new URL('../../emotionlock-website/.env.local', import.meta.url), 'utf8')
  .split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }));
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) { console.error('missing env'); process.exit(1); }

const TO = [
  'jayjaybarnes@hotmail.com', 'mohdrasheei1@gmail.com', 'idreeszia2@gmail.com', 'georgessalgi.gs@gmail.com', 'rboutin6903@gmail.com',
  'dhotredadaram@gmail.com', 'melinegrm@hotmail.com', 'simplegiven.info@gmail.com', 'derantsuh200@gmail.com',
  'stefan10092004@gmail.con',
];
const subject = 'Temporary outage: your EmotionLock protection is paused';
const lines = [
  'Hi,', '',
  'We want to let you know right away: since last night (19 Nov, around 22:40 CET) there is an outage at MetaApi, the service that connects EmotionLock to your MetaTrader 5 account.', '',
  'What this means for you:',
  '- EmotionLock cannot see your trades right now.',
  '- Your daily limit will not lock your trading apps until the connection is back.',
  '- Please keep an eye on your own limit while trading today.', '',
  'You do not need to do anything. Your account and settings are safe, and you do not need to reconnect. We are working on a fix together with MetaApi, and your trades will be counted again as soon as the connection is restored. We will email you when everything works again.', '',
  'If you are on a free trial, we will extend it to make up for the lost days.', '',
  'Sorry for the trouble. Questions? Just reply to this email.', '',
  'Bart', 'EmotionLock',
];
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const text = lines.join('\n');
const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:520px">`
  + lines.map(l => l === '' ? '<br>' : `<div>${esc(l)}</div>`).join('') + '</div>';

for (const to of TO) {
  try {
    const r = await fetch(`${URL_}/functions/v1/send-email`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, subject, text, html, kind: 'transactional', templateKey: 'outage_20261120', replyTo: 'support@emotionlock.app' }),
      signal: AbortSignal.timeout(30000),
    });
    const d = await r.json().catch(() => ({}));
    console.log(`${to}: HTTP ${r.status} ${d?.ok ? 'sent' : JSON.stringify(d).slice(0, 150)}`);
  } catch (e) { console.log(`${to}: error ${e.message}`); }
}
