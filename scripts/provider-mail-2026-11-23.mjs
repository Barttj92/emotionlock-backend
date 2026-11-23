// One-off: update on the new MT5 provider plus compensation (D-049).
// Trial group: trial affected by the outage + signups since 19 Nov that could not connect.
// Paying group: license holders (all in activation month or subscribed).
// Usage: node scripts/provider-mail-2026-11-23.mjs          (dry run, lists recipients)
//        node scripts/provider-mail-2026-11-23.mjs --send   (sends)
// Reads keys from ../emotionlock-website/.env.local, prints no secrets.
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync(new URL('../../emotionlock-website/.env.local', import.meta.url), 'utf8')
  .split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^"|"$/g, '')]; }));
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) { console.error('missing env'); process.exit(1); }
const SEND = process.argv.includes('--send');

const TRIAL = [
  // trial running during the outage
  'derantsuh200@gmail.com', 'simplegiven.info@gmail.com', 'keihanforouhari@gmail.com', 'melinegrm@hotmail.com',
  'emmanuel.odi09@gmail.com', 'dhotredadaram@gmail.com',
  // signed up since 19 Nov, could not connect MT5 yet
  'jamesokwera953@gmail.com', 'mielwis@gmail.com', 'dimpu.b2085@gmail.com', 'happymagnet6666@gmail.com',
  'wanessab001509@gmail.com', 'ebrahemosman423@gmail.com', 'dr.yahia1992@hotmail.com', 'inamulhaq86@gmail.com',
  'r_hansen04@hotmail.com',
];
const PAYING = [
  'jayjaybarnes@hotmail.com', 'zozo.shanpor12345@mail.ru', 'rboutin6903@gmail.com', 'mohdrasheei1@gmail.com',
  'idreeszia2@gmail.com', 'georgessalgi.gs@gmail.com',
];

const intro = [
  'Hi,', '',
  'A quick update on the outage you may have noticed in EmotionLock.', '',
];
const why = 'Since November 19, MetaApi, the service we used to connect to your MT5 account, has been down worldwide. Because of that, EmotionLock could not see your trades and could not lock when you hit your limit.';
const doing = ['What we are doing:', 'We are building a connection with a new MT5 provider, so EmotionLock no longer depends on a single service. This is well underway and the app will be available again soon.', ''];
const outro = (thanks) => ['We will email you as soon as it is live, with a short step to reconnect your MT5 account. Until then, please keep an eye on your daily limit yourself.', '',
  'Questions? Just reply to this email.', '', thanks, 'Bart', 'EmotionLock'];

const MAILS = {
  trial: {
    to: TRIAL, templateKey: 'provider_20261123_trial', subject: 'EmotionLock update: your trial starts fresh',
    lines: [...intro, why + ' We know that is exactly what you count on, and we are sorry your trial was affected.', '', ...doing,
      'What this means for you:', 'Your trial will be fully reactivated. Once the new connection is live, you get a brand new 4-day free trial, so you can test EmotionLock the way it is meant to work. No credit card, no commitment.', '',
      ...outro('Thanks for your patience,')],
  },
  paying: {
    to: PAYING, templateKey: 'provider_20261123_paying', subject: 'EmotionLock update: a free month on us',
    lines: [...intro, why + ' You pay us to protect your trading, and for these days we could not. We are sorry about that.', '', ...doing,
      'What this means for you:', 'As compensation, you get one month of EmotionLock for free. We add it to your account automatically once the new connection is live. You do not need to do anything for it.', '',
      ...outro('Thanks for sticking with us,')],
  },
};

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
for (const [group, m] of Object.entries(MAILS)) {
  const text = m.lines.join('\n');
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:520px">`
    + m.lines.map(l => l === '' ? '<br>' : `<div>${esc(l)}</div>`).join('') + '</div>';
  console.log(`\n== ${group}: ${m.to.length} recipients, "${m.subject}"`);
  for (const to of m.to) {
    if (!SEND) { console.log(`  (dry) ${to}`); continue; }
    try {
      const r = await fetch(`${URL_}/functions/v1/send-email`, {
        method: 'POST',
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject: m.subject, text, html, kind: 'transactional', templateKey: m.templateKey, replyTo: 'support@emotionlock.app' }),
        signal: AbortSignal.timeout(30000),
      });
      const d = await r.json().catch(() => ({}));
      console.log(`  ${to}: HTTP ${r.status} ${d?.ok ? 'sent' : JSON.stringify(d).slice(0, 150)}`);
    } catch (e) { console.log(`  ${to}: error ${e.message}`); }
  }
}
