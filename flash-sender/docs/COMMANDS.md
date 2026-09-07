# Command reference

Exact commands for every task. Run each block from the directory named in its
heading.

---

## 1. Installing dependencies

```bash
# From flash-sender/
cd backend  && npm install && npx prisma generate
cd ../admin && npm install
cd ../desktop && npm install
```

Node 20 or newer is required by all three.

---

## 2. Database

The backend uses PostgreSQL. Either use the bundled compose file:

```bash
# From flash-sender/
docker compose up -d          # postgres on localhost:5432, user/pass/db = flash
docker compose logs -f db     # follow startup
docker compose down           # stop (keeps the volume)
docker compose down -v        # stop and DELETE all data
```

…or point `DATABASE_URL` in `backend/.env` at any Postgres you already run.

Create the schema:

```bash
cd backend
npm run prisma:migrate        # development: creates + applies a migration
npm run prisma:deploy         # production: applies existing migrations only
npm run prisma:studio         # optional: browse the data in a GUI
```

---

## 3. Starting the backend

```bash
cd backend
cp .env.example .env

# Generate a real signing secret and put it in .env as JWT_SECRET:
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"

npm run seed                  # seeds TESTNET networks + their native coins
npm run dev                   # development, with reload — http://localhost:4000
```

Verify it is up:

```bash
curl http://localhost:4000/health
# {"status":"ok","version":3,"testnetOnly":true,"time":"…"}
```

Production:

```bash
npm run build && npm start
```

---

## 4. Creating the first administrator

```bash
cd backend
npm run create-admin -- --email you@example.com --role ADMIN
```

The password is prompted for and hidden — it is never passed on the command
line, so it does not land in your shell history or the process table. It must be
12+ characters with upper case, lower case and a digit.

---

## 5. Issuing a desktop application key

Either from the CLI:

```bash
cd backend
npm run create-api-key -- --name "Nora's workstation"
```

…or in the dashboard under **App keys → Issue key**.

The key is printed **once** (only its SHA-256 is stored). Paste it into the
desktop app under **Settings → Backend → API key**.

---

## 6. Starting the admin dashboard

```bash
cd admin
cp .env.example .env          # set VITE_API_BASE_URL if not localhost:4000
npm run dev                   # http://localhost:5174
```

The backend's `ADMIN_ORIGINS` must contain this origin or the browser will be
blocked by CORS.

---

## 7. Starting the Windows application in development

```bash
cd desktop
npm run dev
```

This launches Vite and the Electron window together with hot reload. On first
run, configure it in this order:

1. **Settings → Backend** — API base URL and the key from step 5.
2. **Wallet setup** — create a new wallet, or import a private key / recovery
   phrase, and choose a vault passphrase.
3. Fund the address from a testnet faucet.

---

## 8. Running tests

```bash
cd backend  && npm test       # 38 tests — no database or network needed
cd desktop  && npm test       # 32 tests — no network needed

# Live read-only checks against BSC testnet (no wallet, no funds):
cd desktop && RUN_CHAIN_TESTS=1 npm test     # 44 total

# Watch mode
npm run test:watch

# Typechecking
cd backend  && npx tsc --noEmit
cd desktop  && npm run typecheck    # checks renderer and main separately
cd admin    && npx tsc --noEmit
```

---

## 9. Building the Windows application

```bash
cd desktop
npm run build                 # typecheck + bundle renderer, main and preload
```

Output: `dist/` (renderer) and `dist-electron/` (main + preload).

---

## 10. Creating the Windows installer

Run on Windows (see [BUILD-WINDOWS.md](BUILD-WINDOWS.md) for cross-building):

```cmd
cd desktop
npm run package:win
```

Produces:

```
desktop\release\Flash-Sender-by-Nora-Setup-1.0.0.exe
```

Other targets:

```cmd
npm run package:win:portable     :: single .exe, no installer
npm run package:dir              :: unpacked folder, for quick testing
```

---

## 11. Configuring production API credentials

Nothing environment-specific is compiled into the executable. A shipped build is
pointed at a backend entirely at runtime:

**Desktop app** — Settings → Backend:
- API base URL (must be `https://`, except `localhost`)
- API key

Both are encrypted with Windows DPAPI and stored in
`%APPDATA%\flash-sender-desktop\settings.json`.

**Backend** — set in the environment of the running process, never committed:

```bash
NODE_ENV=production
DATABASE_URL=postgresql://user:pass@host:5432/flashsender?sslmode=require
JWT_SECRET=<48 random bytes, base64url>
ADMIN_ORIGINS=https://admin.yourdomain.com
REQUIRE_HTTPS=true
TRUST_PROXY=true          # if TLS terminates at a proxy
TESTNET_ONLY=false        # ONLY on the deployment intended for real funds
```

See [DEPLOYMENT.md](DEPLOYMENT.md).

---

## 12. Adding the first token through the dashboard

Full walkthrough with worked examples: [ADDING-A-TOKEN.md](ADDING-A-TOKEN.md).

In short — dashboard → **Assets** → **+ Add asset**:

| Field | Example |
|---|---|
| Asset ID | `usdt-bsc-testnet` |
| Symbol | `USDT` |
| Name | `Tether USD` |
| Network | BNB Smart Chain Testnet |
| Native coin? | unticked |
| Contract | `0x337610d27c682E347C9cD60BD4b3b107C9d34dDd` |
| Decimals | `18` |

Save. The config version increments; the desktop app picks the token up within
its poll interval (default 60s), or immediately via **Settings → Refresh assets
now**.

Equivalent via the API:

```bash
TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"…"}' | jq -r .accessToken)

curl -X POST http://localhost:4000/api/admin/assets \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "assetId": "usdt-bsc-testnet",
    "name": "Tether USD",
    "symbol": "USDT",
    "networkKey": "bsc-testnet",
    "isNative": false,
    "contractAddress": "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd",
    "decimals": 18
  }'
```

---

## 13. Useful one-liners

```bash
# What the desktop app sees
curl -s localhost:4000/api/config -H "X-API-Key: fsk_…" | jq '.assets[] | {symbol, contractAddress, decimals}'

# Cheap version poll
curl -s localhost:4000/api/config/version -H "X-API-Key: fsk_…"

# Recent audit entries
curl -s localhost:4000/api/admin/audit -H "Authorization: Bearer $TOKEN" | jq '.logs[:10]'

# Reset the local database completely
cd backend && npx prisma migrate reset
```
