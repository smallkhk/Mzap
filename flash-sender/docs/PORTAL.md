# Customer portal

A self-service web panel for exactly one API key.

Give a customer the ability to manage their own sending permissions —
adding tokens to the catalog, granting and editing their own spending
limits — without ever giving them access to the admin dashboard, a way to
issue a new key, or a way to see anyone else's key.

---

## What it can and can't do

A key with portal access can, for **itself only**:

- add a token to the shared catalog
- see the full catalog (every network and asset, so it knows what already
  exists before adding a duplicate)
- grant itself a spending limit for any asset — which is also how it turns
  sending on, since [an asset with no limit can't be sent at all](CUSTODIAL.md)
- edit or pause an existing limit
- revoke its own access to an asset

There is no route in the portal's API surface — not a disabled button, an
absent one — that can:

- create a new API key
- see any other key's name, prefix, status or limits
- touch a network, or any admin-only setting
- see this key's own value (it already has it — that's how it signed in —
  but the panel never echoes it back)

That last point is the whole design: the portal has **no endpoint that
accepts a client id from the caller**. Every route acts on whichever key
authenticated the request and nothing else can be named. A bug in a
permission check could someday be wrong; an endpoint that was never
written can't be.

---

## Setting it up

### 1. Issue the key, same as any installation

```bash
cd backend
npm run create-api-key -- --name "Acme Corp"
```

### 2. Turn on portal access for that one key

In the dashboard: **App keys** → find the key → toggle **Portal access**.

Or over the API:

```bash
curl -X PATCH https://send.example.com/api/admin/clients/CLIENT_ID/portal \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"enabled": true}'
```

Issuing a key does **not** grant portal access by itself — a key created
for the desktop app stays desktop-only until this is flipped. Flipping it
back off shuts the panel out immediately; the next request from that key
against `/api/portal/*` gets a 403.

### 3. Give the customer the API key and the portal link

That's the whole handoff. They open the link, paste the key, and land on
their own limits screen — no account to create, no separate password.

---

## Deploying the panel itself

Same shape as the admin dashboard: `portal/prebuilt/` holds the built
output, committed so a host with no build toolchain can deploy it by
copying three files. See `portal/PREBUILT.md`.

```bash
cd backend
# .env
PORTAL_DIST_PATH=/home/USER/send/portal-dist
```

It's served under `/portal` on the same origin as the API — a subpath
rather than the root, so it can run alongside the admin dashboard (which
owns the root) on the same domain. `ADMIN_DIST_PATH` and
`PORTAL_DIST_PATH` are independent; set either, both, or neither.

---

## Why self-service limits are safe to hand out

Handing a customer their own key already means trusting them with
whatever it's allowed to do. Letting them set that allowance themselves,
rather than filing a request each time, doesn't add a new class of risk —
it just moves an existing one from "you typed the number" to "they typed
the number." What actually bounds the damage is unchanged from
[`CUSTODIAL.md`](CUSTODIAL.md):

- **The limit only ever applies to their own key.** Nothing here can move
  another installation's ceiling.
- **The token catalog is shared, sending access is not.** A token this
  customer adds is visible to everyone, same as one an admin adds — but
  nobody, including this same customer, can send it until a limit exists
  for their specific key.
- **Revoking the key or the portal flag is immediate and total.** Every
  portal route re-checks both on every request; there is no cached
  session to outlive the revoke.
- **Every grant, edit and token addition is in the audit log**, tagged as
  coming from this client rather than an admin, so what the customer
  changed is always distinguishable from what you changed.

The one thing worth deciding deliberately: a portal-enabled key can raise
its own limit to any amount, for any asset — including one it just added
itself. If that's more room than you want to hand a given customer, don't
enable their portal access; grant limits for them from the admin
dashboard instead, the same as any other key.
