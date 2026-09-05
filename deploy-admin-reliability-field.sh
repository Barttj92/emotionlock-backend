#!/bin/bash
# Commits and pushes the /admin/metaapi-accounts change that surfaces the raw
# 'reliability' and 'regions' fields MetaAPI actually persisted per account.
# Push = Railway auto-deploy, same as before.
#
# Run this yourself locally:
#   cd "emotionlock-backend"
#   bash deploy-admin-reliability-field.sh
#
# Once live, check the real reliability tier for any account with:
#   curl -s https://emotionlock-backend-production.up.railway.app/admin/metaapi-accounts \
#     -H "x-admin-key: YOUR_ADMIN_KEY" | python3 -m json.tool
#
# Look for your account's "reliability" field in the output. That's the
# value MetaAPI itself has stored for that account, no dashboard badge or
# monthly invoice needed to confirm it.

set -e
cd "$(dirname "$0")"

git add index.js
git commit -m "Surface raw reliability/regions fields on /admin/metaapi-accounts

The Sep 4 billing preview confirms every deployed account this period was
charged under 'G2 high reliability', with the 'G2 regular reliability'
bucket only covering undeployed/inactive hours. That's real evidence our
reliability:'regular' create request isn't being honored, even though
the code has sent it unchanged since the April 'Lock MetaAPI to G1 tier'
commit. This lets us confirm the actual stored tier per account directly
from MetaAPI's own account object, instead of guessing from dashboard
badges or waiting on invoices."
git push

echo ""
echo "Pushed. Railway will auto-deploy from this push."
echo "Then run the curl command above (with your real ADMIN_KEY) to check any account."
