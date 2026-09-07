# Architecture

---

## Layout

```
flash-sender/
├── backend/                     Node + Express + Prisma + PostgreSQL
│   ├── prisma/schema.prisma     Database schema
│   └── src/
│       ├── config.ts            Env validation — refuses to start if invalid
│       ├── app.ts               Middleware pipeline and route mounting
│       ├── lib/
│       │   ├── chain.ts         Address/chain/decimals validation
│       │   ├── crypto.ts        Argon2, JWT, API-key hashing
│       │   ├── errors.ts        AppError with stable codes
│       │   └── db.ts, logger.ts, time.ts
│       ├── middleware/          auth · validate · rateLimit · errorHandler
│       ├── routes/              auth · config · transactions · admin
│       ├── schemas/             Zod schemas — the API's outer boundary
│       └── services/            audit · configVersion · serialize · txState
│
├── desktop/                     Electron + React + TypeScript
│   ├── shared/types.ts          Types shared across the IPC boundary
│   ├── electron/                ── MAIN PROCESS (trusted) ──
│   │   ├── main.ts              Window, CSP, navigation lockdown
│   │   ├── preload.ts           The entire IPC allow-list
│   │   ├── ipc.ts               Handlers; every result is an envelope
│   │   ├── lib/
│   │   │   ├── amount.ts        Exact BigInt decimal conversion
│   │   │   ├── validation.ts    Recipient / private-key validation
│   │   │   └── errors.ts        RPC error → human sentence
│   │   └── services/
│   │       ├── vault.ts         Encrypted key storage (scrypt+GCM+DPAPI)
│   │       ├── wallet.ts        Create / import / unlock / lock
│   │       ├── blockchain.ts    ethers: balances, gas, sign, broadcast, receipts
│   │       ├── transferService.ts  The send pipeline
│   │       ├── apiClient.ts     Backend client + response re-validation
│   │       ├── configStore.ts   Config cache and version polling
│   │       ├── settings.ts      Encrypted settings (API URL/key)
│   │       └── history.ts       Local transaction store
│   └── src/                     ── RENDERER (untrusted) ──
│       ├── App.tsx              Shell, routing, env banner
│       ├── pages/               SendPage · HistoryPage · SettingsPage · WalletGate
│       ├── components/ui.tsx    Shared UI primitives
│       └── lib/                 bridge.ts (IPC wrapper) · format.ts
│
└── admin/                       React dashboard
    └── src/pages/               Assets · Networks · Clients · Audit
```

---

## The trust boundary

```
┌──────────────── RENDERER (sandboxed, no Node) ────────────────┐
│  React UI — addresses, balances, hashes, statuses              │
└───────────────────────────┬───────────────────────────────────┘
                            │ preload.ts allow-list
                            │ (no channel returns key material)
┌───────────────────────────▼───────────────────────────────────┐
│  MAIN PROCESS (trusted)                                        │
│    vault ── the key exists only here, only while unlocked      │
│    blockchain ── the only module that signs or broadcasts      │
│    apiClient ── the only holder of the backend API key         │
└───────────────┬───────────────────────────┬───────────────────┘
                │ https                     │ https/wss
        ┌───────▼────────┐          ┌───────▼────────┐
        │    Backend     │          │   RPC nodes    │
        │ (config+ledger)│          │  (real chains) │
        └────────────────┘          └────────────────┘
```

The renderer is treated as untrusted. It never handles a key, never holds the
API key, and cannot reach the filesystem or the network directly.

---

## The send pipeline

Implemented in `transferService.ts`, in two phases separated by explicit human
confirmation.

### Phase 1 — `prepareTransfer` (nothing is signed)

```
1  Wallet unlocked?                         → WALLET_LOCKED
2  Mainnet allowed for this network?        → MAINNET_DISABLED
3  Recipient valid, checksummed, not self?  → RECIPIENT_*
4  Amount parses exactly at N decimals?     → AMOUNT_*
5  eth_chainId == configured chainId?       → NETWORK_MISMATCH
6  (tokens) contract deployed?              → NOT_A_CONTRACT
   (tokens) on-chain decimals() matches?    → DECIMALS_MISMATCH
   (tokens) symbol() matches?               → warning only
7  Asset balance ≥ amount?                  → INSUFFICIENT_BALANCE
8  eth_estimateGas succeeds?                → EXECUTION_REVERTED etc.
   Native balance ≥ fee (+ amount)?         → INSUFFICIENT_GAS
                                            ↓
                          TransferQuote, held in memory, 5-min TTL
```

The quote is returned with a `clientRef`. Confirming sends **only that
reference** back — so the transaction that gets signed is exactly the one
displayed. The renderer cannot alter the amount or recipient in between.

### Phase 2 — `executeTransfer` (after explicit confirmation)

```
SIGNING       re-verify chain id, build the request
              vault.withPrivateKey(...) — key borrowed, never returned
BROADCASTING  eth_sendRawTransaction
              ↓
PENDING       ← the hash the NODE returned. Persisted immediately.
              ↓  background watcher polls eth_getTransactionReceipt
        ┌─────┴─────┐
   receipt.status=1  receipt.status=0
        ↓                 ↓
   CONFIRMED           FAILED  ("mined but reverted; gas spent, nothing moved")
```

A failure *before* broadcast is recorded as `REJECTED` — nothing reached the
chain and no fee was paid. A failure *after* is `FAILED`.

The watcher persists at every step, so a transaction that was broadcast is never
lost: on next launch `resumeUnsettled()` picks up anything still `PENDING` and
resumes watching from the stored hash.

---

## Native vs token transfers

Decided by the backend's `isNative` flag, in `buildTransferRequest`:

```ts
// Native coin — a plain value transfer
{ to: recipient, value: amountRaw }

// Token — a standard ERC-20/BEP-20 call
{ to: contractAddress,
  data: iface.encodeFunctionData('transfer', [recipient, amountRaw]),  // 0xa9059cbb
  value: 0n }
```

`amountRaw` is a `bigint` produced by `parseAmount(input, decimals)`, which is
pure BigInt arithmetic. Floating point is never used on the value path —
`parseFloat("0.1") * 1e18` is off by 8192 wei, and that error would be real
money.

---

## Configuration synchronisation

```
Admin write → configVersion++ → desktop polls /api/config/version (tiny)
                                → changed? GET /api/config
                                → re-validate every asset client-side
                                → drop anything invalid, warn the user
                                → cache to disk, notify the renderer
```

The disk cache means the app starts and displays its asset list while offline;
sends still require live RPC access.

---

## Adding a new EVM network

No code change. Add it in the dashboard: name, chain ID, RPC endpoints,
explorer, native coin details. `blockchain.ts` is chain-agnostic across EVM
chains — it reads everything it needs from the `NetworkConfig`.

## Adding a non-EVM chain

Non-EVM chains (Solana, Bitcoin, Tron) need real work, because addresses,
signing and transaction shapes all differ. The seam is `blockchain.ts`, whose
surface is:

```ts
getChainStatus(network)
getBalanceFor(asset, address)
verifyTokenContract(network, contract, decimals, symbol)
buildTransferRequest(asset, to, amountRaw)
estimateFee(network, request, from)
signAndBroadcast(network, privateKey, request)
waitForReceipt(network, hash, confirmations, timeout)
```

Introduce a `family` discriminator on `Network` (`"evm" | "solana" | …`), split
this module into per-family implementations behind that interface, and dispatch
in `transferService`. The pipeline, vault, history, ledger and UI stay as they
are. `Asset.contractAddress` becomes a family-specific identifier (an SPL mint,
say), so its validation moves behind the same seam.

---

## Adding a new token standard

`ERC20_ABI` in `blockchain.ts` holds only what is used: `transfer`, `balanceOf`,
`decimals`, `symbol`. For ERC-721/1155, add a `standard` field to `Asset` and
branch in `buildTransferRequest` (`safeTransferFrom` rather than `transfer`), and
in the balance lookup. The confirmation UI would need a token-ID field.
