# Subscription cleanup deploy checklist

Deze wijzigingen sluiten de twee gaten die in het systeem zaten rond
subscription cancellation: de backend deed niets met subscription state, en
er was geen App Store Server Notifications V2 webhook. Voortaan worden
verlopen users actief geblokkeerd, MetaAPI accounts opgeruimd na 48 uur
grace, en cancellation events real-time door Apple gemeld.

## 1. Supabase migration

Run het SQL bestand `migrations/001_subscription_lifecycle.sql` in de
Supabase SQL editor (project `ixlmaqkhgjgmijlbstia`). Het voegt vier
kolommen en drie partial indexes toe aan `purchases`, alles nullable, dus
bestaande rijen blijven onaangetast.

## 2. Railway deploy

Geen nieuwe dependencies, geen env vars nodig. Push naar de Railway
branch en de nieuwe code is live. De webhook endpoint draait dan op:

    https://emotionlock-backend-production.up.railway.app/apple/notifications

## 3. App Store Connect

Open je app in App Store Connect, ga naar "App Information" en zet bij
"App Store Server Notifications" beide velden:

- Production Server URL: `https://emotionlock-backend-production.up.railway.app/apple/notifications`
- Sandbox Server URL: hetzelfde (de webhook detecteert environment uit het signed payload)
- Version: 2

Klik "Send Test Notification" en check de Railway logs op
`[apple-notify] TEST` om te bevestigen dat de signature verificatie loopt.

## 4. iOS app submit

De wijzigingen in `StoreKitManager.swift` betekenen dat alle nieuwe
purchases een `appAccountToken` (= userId UUID) krijgen. Apple stuurt
die mee in elke ASSN V2 notification, waardoor de webhook direct de
juiste user vindt zonder Supabase lookup.

Bestaande purchases (gemaakt voor deze update) blijven werken via de
fallback op `originalTransactionId`, die al wordt opgeslagen vanaf de
eerstvolgende `/purchase` call die de iOS app doet bij refresh.

## 5. Wat er nu gebeurt bij cancellation

1. User zegt subscription op via Settings → Apple
2. Apple stuurt `DID_CHANGE_RENEWAL_STATUS` webhook → backend logt het, status blijft 'active' (sub loopt door tot expiry)
3. Apple stuurt `EXPIRED` webhook bij einde betaalperiode → backend zet `subscription_status = 'expired'`
4. iOS app's volgende `/status` call krijgt 402 + de lokale `hasAccess` is al false → PaywallView
5. Polling loop slaat user over → MetaAPI blijft draaien maar zonder polling
6. Hourly cleanup job na 48 uur → MetaAPI account ge-undeployed, `meta_api_undeployed_at` gestamped
7. User re-subscribet later → webhook `SUBSCRIBED` of `DID_RENEW` → status terug naar 'active' + auto-redeploy van MetaAPI account

## 6. Refund flow

Als Apple een refund verleent, komt er een `REFUND` notification.
Backend reageert direct: subscription_status → 'expired', license_code
gewist (bij refund op de license SKU), en MetaAPI account onmiddellijk
ge-undeployed zonder grace periode. Dit is dezelfde flow als een
revocation.

## 7. Verificatie na deploy

```bash
# Check de logs op Railway na eerste production webhook:
[apple-notify] SUBSCRIBED/INITIAL_BUY env=Production product=app.emotionlock.monthly ...
[apple-notify] Applied SUBSCRIBED/INITIAL_BUY → trialing for xxxxxxxx

# Check de Command Center: subscription_status kolom moet nu actief bewegen
# tussen 'active', 'trialing', 'expired' op basis van echte Apple events.
```
