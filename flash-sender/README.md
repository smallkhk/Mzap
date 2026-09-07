# Flash Sender by Nora

A Windows desktop application for sending cryptocurrency coins and tokens on EVM
networks, with the list of supported assets driven entirely by a backend you
control.

Add a token in the admin dashboard and it appears in the desktop app on its next
sync. **No rebuild, no reinstall, no contract addresses compiled into the
client.**

---

## What this is

| Component | Stack | Purpose |
|---|---|---|
| `desktop/` | Electron + React + TypeScript + ethers v6 | The Windows application. Signs and broadcasts real transactions. |
| `backend/` | Node + Express + TypeScript + Prisma + PostgreSQL | Source of truth for networks/assets, plus the transaction ledger. |
| `admin/` | React + TypeScript + Vite | Web dashboard for managing assets, networks and app keys. |

### Two guarantees the code enforces

**1. Transaction status comes from the chain, never from the UI.**

The only way a transaction becomes `CONFIRMED` is a receipt fetched from an RPC
node with `status === 1`. The only transaction hash that exists is the one
returned by `eth_sendRawTransaction`. There is no code path that generates,
derives or backfills a hash, and the backend's state machine makes `CONFIRMED`,
`FAILED` and `REJECTED` terminal — a settled transaction cannot be relabelled
afterwards. A transaction that was mined but reverted is reported as **Failed**,
with an explanation that gas was spent and no funds moved.

**2. Key material never leaves the signing process.**

There is no private key, mnemonic or wallet password in the source, the
bundles, the config files, the environment, the backend, or the installer. The
user's key is imported at runtime, sealed with a scrypt-derived AES-256-GCM key
and then wrapped with Windows DPAPI, and is only ever unsealed inside the
Electron main process for the duration of one signing call. The backend
actively **rejects** any request body containing a field that looks like key
material.

---

## Quick start

Prerequisites: **Node 20+**, **PostgreSQL 14+**. Windows builds additionally need
Windows (or Wine) — see [`docs/BUILD-WINDOWS.md`](docs/BUILD-WINDOWS.md).

```bash
# 1. Database
docker compose up -d            # or point DATABASE_URL at your own Postgres

# 2. Backend
cd backend
cp .env.example .env            # then edit: set JWT_SECRET
npm install
npm run prisma:migrate          # creates the schema
npm run seed                    # seeds BSC/Sepolia/Amoy TESTNETS only
npm run create-admin            # prompts for email + password
npm run create-api-key -- --name "My workstation"   # prints the desktop key once
npm run dev                     # http://localhost:4000

# 3. Admin dashboard
cd ../admin && npm install && npm run dev           # http://localhost:5174

# 4. Desktop app
cd ../desktop && npm install && npm run dev
```

Then in the desktop app: **Settings → Backend**, enter `http://localhost:4000`
and the API key printed in step 2.

Full command reference: [`docs/COMMANDS.md`](docs/COMMANDS.md).

---

## Safety: testnet vs mainnet

Real funds are gated behind **two independent switches**, both off by default:

| Switch | Where | Effect when off |
|---|---|---|
| `TESTNET_ONLY=true` | Backend `.env` | The backend refuses to store *or* serve any non-testnet network. |
| **Allow mainnet** | Desktop → Settings | The app refuses to send on any non-testnet network. |

The desktop app shows a permanent banner naming the current environment, and the
confirmation dialog requires an explicit tick-box acknowledgement before any
mainnet transfer.

Develop and test on testnets. Faucets: [BSC](https://www.bnbchain.org/en/testnet-faucet),
[Sepolia](https://sepoliafaucet.com), [Amoy](https://faucet.polygon.technology).

---

## How configuration reaches the app

```
Admin dashboard  ──POST /api/admin/assets──►  Backend
                                                 │  bumps configVersion
                                                 ▼
Desktop app  ──GET /api/config/version──►  { "version": 12 }
             (polls; tiny response)             │
                                                │ changed?
             ──GET /api/config────────────────►─┘
                 networks + assets, re-validated client-side
```

The desktop client does not blindly trust what the backend sends. Every asset is
re-validated on arrival — address format and EIP-55 checksum, chain ID, decimals
range, native-vs-token consistency — and anything that fails is dropped from the
list with a visible warning rather than offered as sendable. Before each send it
additionally reads the contract's own `decimals()` on-chain and **refuses to
proceed on a mismatch**, because a wrong decimals value silently changes the
amount transferred by orders of magnitude.

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/COMMANDS.md`](docs/COMMANDS.md) | Every command: install, run, test, build, package. |
| [`docs/ADDING-A-TOKEN.md`](docs/ADDING-A-TOKEN.md) | Adding your first token through the dashboard. |
| [`docs/BUILD-WINDOWS.md`](docs/BUILD-WINDOWS.md) | Building `Flash-Sender-by-Nora-Setup.exe`, code signing. |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Production backend deployment, TLS, hardening. |
| [`docs/API.md`](docs/API.md) | Full endpoint reference. |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Threat model, key handling, what is and isn't protected. |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Module layout and the send pipeline. |

---

## Tests

```bash
cd backend && npm test     # 38 tests: chain validation, tx state machine
cd desktop && npm test     # 32 unit tests: exact amount arithmetic, address validation

# Live read-only tests against BSC testnet (no wallet or funds needed):
cd desktop && RUN_CHAIN_TESTS=1 npm test    # 44 total
```

---

## Extending to another network

No code change is required for another EVM chain — add it in the dashboard under
**Networks** (name, chain ID, RPC endpoints, explorer, native coin), then add its
assets. Non-EVM chains (Solana, Bitcoin, Tron) would need a new implementation
behind the `blockchain.ts` service interface; see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
