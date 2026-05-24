// apple-notifications.js
// JWS verification + decoding for App Store Server Notifications V2.
//
// Apple POSTs every subscription lifecycle event to the URL configured in
// App Store Connect. The payload is a single JWS (JSON Web Signature):
//
//   { "signedPayload": "<header>.<payload>.<signature>" }
//
// The header carries an x5c cert chain anchored at Apple Root CA G3.
// This module verifies the chain, verifies the signature with the leaf
// cert's public key, then decodes the inner JWS values (signedTransactionInfo,
// signedRenewalInfo) using the SAME procedure recursively.
//
// We deliberately do NOT pull in @apple/app-store-server-library because:
//   - it still requires us to bundle Apple's root certs ourselves,
//   - the verification surface area is small enough to maintain in-tree,
//   - one less third-party dep is one less supply-chain risk on Railway.
//
// Apple's official documentation for V2:
//   https://developer.apple.com/documentation/appstoreservernotifications/notification_v2

const crypto = require('crypto');

// =====================
// Apple Root CA G3 (anchor of trust)
// =====================
// PEM downloaded from https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
// SHA-256 fingerprint published by Apple:
//   63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79
//
// We compute the fingerprint at module load and bail loudly if it ever
// drifts from the constant. This protects against a build-time tamper or
// a careless paste-over of the embedded PEM.
const APPLE_ROOT_CA_G3_PEM = `-----BEGIN CERTIFICATE-----
MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwS
QXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9u
IEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcN
MTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBS
b290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9y
aXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49
AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtf
TjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517
IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySr
MA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gA
MGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4
at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM
6BgD56KyKA==
-----END CERTIFICATE-----
`;

const APPLE_ROOT_CA_G3_FINGERPRINT_SHA256 =
    '63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179';

const appleRootCert = new crypto.X509Certificate(APPLE_ROOT_CA_G3_PEM);

(function assertRootCertFingerprint() {
    const computed = appleRootCert.fingerprint256.replace(/:/g, '').toUpperCase();
    if (computed !== APPLE_ROOT_CA_G3_FINGERPRINT_SHA256) {
        // Hard fail at startup. Better to crash the backend than to accept
        // a tampered root cert and treat forged notifications as authentic.
        throw new Error(
            `[apple-notifications] FATAL: Apple Root CA G3 fingerprint mismatch. ` +
            `Expected ${APPLE_ROOT_CA_G3_FINGERPRINT_SHA256}, got ${computed}.`
        );
    }
})();

// =====================
// JWS helpers
// =====================

function base64UrlDecode(s) {
    // Base64URL → Base64 → Buffer
    const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
    return Buffer.from(padded, 'base64');
}

function parseJws(jws) {
    if (typeof jws !== 'string' || !jws.includes('.')) {
        throw new Error('Invalid JWS: not a string or missing separators');
    }
    const [headerB64, payloadB64, sigB64] = jws.split('.');
    if (!headerB64 || !payloadB64 || !sigB64) {
        throw new Error('Invalid JWS: must have header.payload.signature');
    }
    const header = JSON.parse(base64UrlDecode(headerB64).toString('utf8'));
    const payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8'));
    const signature = base64UrlDecode(sigB64);
    // Apple signs JWS-style: signature is over the ASCII bytes of
    // "headerB64.payloadB64", base64url-encoded values intact.
    const signedData = Buffer.from(`${headerB64}.${payloadB64}`, 'ascii');
    return { header, payload, signature, signedData };
}

// Walk the x5c chain from leaf to root. Each cert must be signed by the
// next one in the array, and the last cert must chain to Apple Root CA G3
// (either directly or by being the root itself).
function verifyChain(x5c) {
    if (!Array.isArray(x5c) || x5c.length < 1) {
        throw new Error('JWS header missing x5c chain');
    }
    const certs = x5c.map(b64 => new crypto.X509Certificate(Buffer.from(b64, 'base64')));

    const now = Date.now();
    for (const c of certs) {
        const notBefore = new Date(c.validFrom).getTime();
        const notAfter  = new Date(c.validTo).getTime();
        if (Number.isNaN(notBefore) || Number.isNaN(notAfter)) {
            throw new Error('Could not parse cert validity dates');
        }
        if (notBefore > now) throw new Error('x5c cert not yet valid');
        if (notAfter  < now) throw new Error('x5c cert expired');
    }

    // Each cert (except the last) must be signed by the next.
    for (let i = 0; i < certs.length - 1; i++) {
        if (!certs[i].verify(certs[i + 1].publicKey)) {
            throw new Error(`x5c chain broken at index ${i}`);
        }
    }

    // Anchor: either the last cert IS Apple's root (fingerprint match) or
    // it is signed by Apple's root.
    const last = certs[certs.length - 1];
    const lastFp = last.fingerprint256.replace(/:/g, '').toUpperCase();
    if (lastFp === APPLE_ROOT_CA_G3_FINGERPRINT_SHA256) {
        // Defensive: confirm the root signs itself (it should, by definition).
        if (!appleRootCert.verify(appleRootCert.publicKey)) {
            throw new Error('Apple root self-signature failed');
        }
    } else if (!last.verify(appleRootCert.publicKey)) {
        throw new Error('x5c does not anchor to Apple Root CA G3');
    }

    return certs[0]; // leaf certificate
}

// Verify a JWS (Apple uses ES256 = ECDSA with SHA-256 + P-256 curve) and
// return the decoded payload. Throws on any failure; callers should treat
// the throw as "drop this request".
function verifyAndDecodeJws(jws) {
    const { header, payload, signature, signedData } = parseJws(jws);

    if (header.alg !== 'ES256') {
        throw new Error(`Unexpected JWS alg: ${header.alg}`);
    }

    const leaf = verifyChain(header.x5c);

    // Apple's ES256 signature is the raw 64-byte r||s concatenation (IEEE
    // P1363), not DER. Node ≥17 lets us specify dsaEncoding so we don't
    // have to convert by hand.
    const ok = crypto.verify(
        'SHA256',
        signedData,
        { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' },
        signature
    );
    if (!ok) {
        throw new Error('JWS signature verification failed');
    }

    return payload;
}

// =====================
// Apple-specific decode
// =====================
// V2 notification body shape (after JWS verify):
//   {
//     notificationType: "SUBSCRIBED" | "DID_RENEW" | "DID_FAIL_TO_RENEW" |
//                       "EXPIRED" | "REFUND" | "DID_CHANGE_RENEWAL_STATUS" | ...,
//     subtype: "INITIAL_BUY" | "VOLUNTARY" | "BILLING_RETRY" | "AUTO_RENEW_DISABLED" | ...,
//     data: {
//       bundleId: "com.emotionlock.EmotionLock",
//       environment: "Production" | "Sandbox",
//       signedTransactionInfo: "<JWS>",
//       signedRenewalInfo: "<JWS>",
//     },
//     summary: { ... },  // for refund-related types
//   }
function verifyAndDecodeNotification(signedPayload, expectedBundleId) {
    const body = verifyAndDecodeJws(signedPayload);

    if (expectedBundleId && body?.data?.bundleId && body.data.bundleId !== expectedBundleId) {
        throw new Error(`Notification bundleId mismatch: ${body.data.bundleId}`);
    }

    let transactionInfo = null;
    let renewalInfo = null;
    if (body?.data?.signedTransactionInfo) {
        transactionInfo = verifyAndDecodeJws(body.data.signedTransactionInfo);
    }
    if (body?.data?.signedRenewalInfo) {
        renewalInfo = verifyAndDecodeJws(body.data.signedRenewalInfo);
    }

    return {
        notificationType: body?.notificationType ?? null,
        subtype:          body?.subtype ?? null,
        notificationUUID: body?.notificationUUID ?? null,
        environment:      body?.data?.environment ?? null,
        bundleId:         body?.data?.bundleId ?? null,
        transactionInfo,
        renewalInfo,
        raw: body,
    };
}

module.exports = {
    verifyAndDecodeNotification,
    // Exposed for tests / diagnostics only.
    _internal: { verifyAndDecodeJws, verifyChain, parseJws },
};
