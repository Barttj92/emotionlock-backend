#!/bin/bash
# Commits and pushes the reliability-logging change to createMetaApiAccount,
# which triggers a Railway auto-deploy (push to the connected branch = live).
#
# Run this yourself locally, e.g.:
#   cd "emotionlock-backend"
#   bash deploy-reliability-logging.sh
#
# After it's live, connect one MT5 account (or wait for the next real user to)
# and check the Railway logs for a line like:
#   [metaapi] Created account <id> for "EmotionLock-<userId>": reliability=high
# That tells you, straight from MetaAPI's own create response, whether the
# 'regular' we request is actually being honored or silently overridden.
# You can delete this script once you've confirmed the deploy went out.

set -e
cd "$(dirname "$0")"

git add index.js
git commit -m "Log confirmed MetaAPI reliability tier on account create

Investigating why the MetaAPI dashboard shows 'high reliability' for
accounts created with reliability:'regular' in the create request.
This logs what MetaAPI's own create response actually reports back,
so the next account creation gives a direct answer without needing
to check the dashboard by hand."
git push

echo ""
echo "Pushed. Railway will auto-deploy from this push."
echo "Watch the logs for: [metaapi] Created account ... reliability=..."
