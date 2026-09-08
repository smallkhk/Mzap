# Custodial mode

One sending wallet, held by the backend, that several people can send from
without ever holding a key themselves.

This is the mode where **your** wallet does the sending and your users just
install the app and go. It is optional — leave it unconfigured and each
installation keeps its own key, signing locally.

---

## Read this part first

In custodial mode a spendable private key lives on your server so it can sign
unattended. That has a consequence there is no way to engineer around:

> **Whoever controls the server controls the funds.** A machine that can sign
> without a human present can be made to sign by anyone who owns the machine.

Encryption at rest helps against a stolen *file*, not against someone with
access to the running process. So the honest framing is:

- Keep in this wallet only what you can afford to lose to a host compromise.
- Keep the reserve in a wallet this server has never seen.
- On shared hosting (cPanel), assume the blast radius includes anything that
  compromises your cPanel account — a weak password, a stale plugin on another
  site in the same account, a support-desk mistake. Enable 2FA.
- If the balance ever becomes significant, move the backend to a VPS you
  control, or switch to local signing where each sender holds their own key.

What the implementation *does* do to bound the damage:

| Control | Effect |
|---|---|
| Encrypted vault (scrypt N=2¹⁷ + AES-256-GCM) | A copied vault file is useless without the passphrase |
| Passphrase supplied via environment, never stored by the app | The two halves are not sitting in the same place |
| Vault path refused inside a web root | The file cannot be fetched over HTTP |
| Key held only in a private buffer, never logged or serialised | No route out through logs or the API |
| **Spending limits, opt-in per asset** | A leaked API key can move at most that client's daily cap |
| Full audit log of every broadcast | You can see what moved, when, and which installation did it |
| Address verified against the vault at startup | A swapped vault file fails closed instead of signing from elsewhere |

The spending limits are the important one. A client with **no limit row for an
asset cannot send that asset at all** — access is granted per installation, per
asset, deliberately.

---

## Setting it up

### 1. Choose a location outside the web root

```bash
mkdir -p ~/secure
chmod 700 ~/secure
```

Not `public_html`, not inside the app directory if that sits under a document
root. The backend refuses to start if the path looks web-served.

### 2. Import the wallet

```bash
cd ~/send                     # your application root
npm run import-wallet -- --out ~/secure/wallet.vault
```

It prompts for the private key and a passphrase, both hidden. Neither is taken
from the command line, so neither lands in shell history or the process table.

The passphrase needs 16+ characters with mixed case and a digit. It is the only
thing protecting the key if the vault file is ever copied off the server —
generate it rather than inventing it:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

### 3. Point the backend at it

In `.env`:

```bash
WALLET_VAULT_PATH=/home/USER/secure/wallet.vault
WALLET_PASSPHRASE=<the passphrase you chose>
```

Restart. The startup log confirms the mode and the address:

```
Custodial mode: this server holds the sending key and signs for clients.
  address: 0x…
```

If the passphrase is wrong or the vault is missing, the process **refuses to
start** rather than running a sending service that cannot sign.

### 4. Grant each installation a spending limit

Nothing can send until you do this. Per client, per asset.

**In the dashboard** (the usual way, once it is deployed — see
`admin/PREBUILT.md` for the three files to copy): open **App keys**. In custodial mode the
page shows the sending address at the top and an **Allowed to send** column;
an installation with nothing granted reads `nothing` and cannot send. Click
**Spending limits** on its row, pick the asset, enter the per-transaction and
per-day caps in human units, and save. The same panel edits a cap, pauses one
without losing the amounts, or revokes the asset outright.

**Or from a shell on the server**, which needs no login and no `jq`:

```bash
cd ~/send
npm run grant-limit                       # lists installations and assets
npm run grant-limit -- --client <id> --asset <id> --per-tx 100 --per-day 500
npm run grant-limit -- --client <id> --asset <id> --revoke
```

If the Prisma query engine panics on your host (`PANIC: timer has gone
away` — a thread the shared-hosting process limit would not let it keep),
the same commands are available without Prisma, through the `mysql`
client:

```bash
node src/scripts/grantLimitSql.mjs
node src/scripts/grantLimitSql.mjs --client <id> --asset <id> --per-tx 100 --per-day 500
node src/scripts/grantLimitSql.mjs --client <id> --asset <id> --revoke
```

It reads `DATABASE_URL` from `.env`, and if `mysql` is missing too it
prints the SQL to paste into phpMyAdmin.

**Or over the API**, which is what the dashboard calls:

```bash
TOKEN=$(curl -s -X POST https://send.eclipselivecam.online/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"…"}' | jq -r .accessToken)

curl -X PUT https://send.eclipselivecam.online/api/admin/clients/CLIENT_ID/limits \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"assetId":"usdt-bsc","maxPerTx":"500","maxPerDay":"2000"}'
```

Amounts are in human units — the API converts using the asset's decimals.

To revoke an installation's access to one asset:

```bash
curl -X DELETE https://send.eclipselivecam.online/api/admin/clients/CLIENT_ID/limits/usdt-bsc \
  -H "Authorization: Bearer $TOKEN"
```

To cut an installation off entirely, revoke its API key under **App keys**.

---

## What the user sees

Nothing about keys. The app detects custodial mode from `/api/config` and:

- skips wallet setup and unlock completely
- shows the shared wallet's address and live balance
- shows that installation's remaining limit next to the balance
- sends exactly as before — pick asset, recipient, amount, confirm

History comes from the server, so every installation sees the same ledger for
the shared wallet.

---

## How a send actually works

```
Desktop                    Backend                          Chain
   │                          │                               │
   ├─ POST /api/send/prepare ─►│                               │
   │                          ├─ validate recipient/amount     │
   │                          ├─ check THIS client's limits    │
   │                          ├─ verify chain id ──────────────►│ eth_chainId
   │                          ├─ verify contract decimals ─────►│ decimals()
   │                          ├─ read balances ────────────────►│
   │                          ├─ estimate gas ─────────────────►│ eth_estimateGas
   │◄──── quote (held server-side, by reference) ───────────────┤
   │                          │                               │
   │  [user reviews and confirms]                              │
   │                          │                               │
   ├─ POST /api/send/confirm ─►│  (clientRef only)             │
   │                          ├─ re-verify chain id ───────────►│
   │                          ├─ take per-chain nonce lock      │
   │                          ├─ sign with server key           │
   │                          ├─ broadcast ────────────────────►│
   │◄──── the node's hash ─────┤                               │
   │                          ├─ poll for receipt ─────────────►│
   │                          └─ CONFIRMED only on status === 1 │
```

Two things worth noting:

**Confirm sends back only a reference.** The amount and recipient stay on the
server with the quote, so a tampered client cannot change what gets signed
between the confirmation screen and the signature.

**Sends are serialised per chain.** One wallet with several clients would
otherwise race for the same nonce and silently drop transactions. Each chain's
broadcasts queue, and the nonce is read inside the lock.

---

## Switching back to local signing

Remove `WALLET_VAULT_PATH` and `WALLET_PASSPHRASE` from `.env` and restart. The
backend reports `signingMode: "local"`, and desktop clients go back to asking
each user to set up their own wallet. Delete the vault file if you are done
with it.

---

## Operational notes

**Top up the sending wallet's native coin.** Every token transfer costs gas in
the network's native coin. If that runs out, sends fail at the estimate step
with a message naming the shortfall — no funds move, but nothing sends either.

**Watch the audit log.** `/api/admin/audit` records every broadcast with the
installation that requested it, the recipient, and the amount. An entry you
cannot account for is the signal that matters.

**Pending transactions survive a restart.** Passenger recycles idle apps; the
backend re-attaches its receipt watchers on startup, so a transaction broadcast
just before a restart still settles correctly.

**Rotating the key.** Import a new vault, restart, then move the funds. The old
address stays in past transaction records, which is correct — those really were
sent from it.
