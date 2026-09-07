# API reference

Base URL: your backend, e.g. `https://api.example.com`.

All responses are JSON. Errors always take the shape:

```json
{ "error": { "code": "MACHINE_CODE", "message": "A sentence a person can act on.", "details": [] } }
```

---

## Authentication

Two independent schemes:

| Scheme | Header | Used by | Grants |
|---|---|---|---|
| Admin bearer token | `Authorization: Bearer <jwt>` | Admin dashboard | Full configuration management (role-dependent) |
| Client API key | `X-API-Key: fsk_…` | Desktop app | Read configuration; record its own transactions |

A client API key can **never** modify an asset, a network, or a contract
address.

---

## Public

### `GET /health`

No authentication.

```json
{ "status": "ok", "version": 12, "testnetOnly": true, "time": "2026-01-01T00:00:00.000Z" }
```

---

## Admin authentication

### `POST /api/auth/login`

```json
{ "email": "you@example.com", "password": "…" }
```

→ `200`

```json
{
  "accessToken": "eyJ…",
  "refreshToken": "…",
  "expiresIn": "15m",
  "user": { "id": "…", "email": "you@example.com", "role": "ADMIN" }
}
```

Rate limited per IP **and** email. Failures are indistinguishable between
"no such user", "wrong password" and "disabled account".

### `POST /api/auth/refresh`

```json
{ "refreshToken": "…" }
```

Returns a new access token and a **new refresh token**; the presented one is
revoked. Presenting an already-used token revokes the entire token family and
returns `401` — that is reuse detection, and it means the token leaked.

### `POST /api/auth/logout` · `GET /api/auth/me`

Revokes the token family / returns the current user.

---

## Configuration — read by the desktop app

All require `X-API-Key`.

### `GET /api/config/version`

Deliberately tiny; intended for polling.

```json
{ "version": 12 }
```

### `GET /api/config`

Everything needed for a cold start, in one round trip.

```json
{
  "version": 12,
  "testnetOnly": true,
  "networks": [
    {
      "key": "bsc-testnet",
      "name": "BNB Smart Chain Testnet",
      "chainId": 97,
      "rpcUrls": ["https://bsc-testnet-rpc.publicnode.com"],
      "explorerUrl": "https://testnet.bscscan.com",
      "nativeSymbol": "tBNB",
      "nativeName": "Test BNB",
      "nativeDecimals": 18,
      "isTestnet": true
    }
  ],
  "assets": [
    {
      "id": "usdt-bsc-testnet",
      "name": "Tether USD (testnet)",
      "symbol": "USDT",
      "network": { "...": "as above" },
      "chainId": 97,
      "contractAddress": "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd",
      "decimals": 18,
      "isNative": false,
      "explorerUrl": "https://testnet.bscscan.com",
      "enabled": true
    }
  ],
  "policy": { "minConfirmations": 1, "pendingWarningSeconds": 300 }
}
```

Disabled assets, and assets on disabled networks, are omitted entirely — that is
how "disable this token" reaches clients. When the backend runs with
`TESTNET_ONLY=true`, mainnet networks are omitted too.

### `GET /api/assets?network=<key>` · `GET /api/networks`

Narrower views of the same data.

---

## Transactions

All require `X-API-Key`. A client sees only its own records.

### `POST /api/transactions`

Records a transaction the app is performing.

```json
{
  "clientRef": "550e8400-e29b-41d4-a716-446655440000",
  "txHash": "0xabc…",
  "chainId": 97,
  "status": "PENDING",
  "assetId": "usdt-bsc-testnet",
  "symbol": "USDT",
  "decimals": 18,
  "isNative": false,
  "contractAddress": "0x337610d2…",
  "fromAddress": "0x…",
  "toAddress": "0x…",
  "amountRaw": "1500000000000000000",
  "amountDisplay": "1.5",
  "nonce": 42
}
```

Server-side checks:

- `assetId` must be a configured asset, and `chainId` must match its network.
- `contractAddress` and `isNative` must match the configured asset.
- A status of `BROADCASTING`, `PENDING` or `CONFIRMED` **requires** `txHash`.
- `amountRaw` must be a positive integer within uint256.

Idempotent on `(client, clientRef)` — a retry returns the existing record with
`"idempotent": true` rather than creating a duplicate. Unique on
`(txHash, chainId)`.

### `PATCH /api/transactions/:id`

Settles a record once a receipt exists.

```json
{
  "status": "CONFIRMED",
  "txHash": "0xabc…",
  "blockNumber": 45678901,
  "gasUsed": "51234",
  "effectiveGasPrice": "3000000000",
  "feeRaw": "153702000000000",
  "confirmations": 3
}
```

Transitions are checked against the state machine:

```
PREPARING → AWAITING_CONFIRMATION → SIGNING → BROADCASTING → PENDING → CONFIRMED
     └──────────────┴──────────────────┴──► REJECTED / FAILED
```

`CONFIRMED`, `FAILED` and `REJECTED` are **terminal**. Attempting to move out of
one returns `409 ILLEGAL_STATE_TRANSITION`. A hash cannot be changed once set
(`409 TX_HASH_IMMUTABLE`).

### `GET /api/transactions`

Query: `status`, `chainId`, `assetId`, `from`, `search`, `fromDate`, `toDate`,
`limit` (≤200), `cursor`.

```json
{ "transactions": [ { "...": "…", "explorerUrl": "https://testnet.bscscan.com/tx/0xabc…" } ], "nextCursor": null }
```

`explorerUrl` is present only when a real hash exists.

### `GET /api/transactions/:id`

---

## Admin — configuration management

All require a bearer token. Writes require the `ADMIN` role; `VIEWER` gets
read-only access. **Every write bumps `configVersion`** and is written to the
audit log.

### Assets

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/admin/assets` | Includes disabled |
| `GET` | `/api/admin/assets/:assetId` | |
| `POST` | `/api/admin/assets` | Create |
| `PUT` | `/api/admin/assets/:assetId` | Update |
| `POST` | `/api/admin/assets/:assetId/toggle` | Enable/disable |
| `DELETE` | `/api/admin/assets/:assetId` | Prefer disabling |

Create body:

```json
{
  "assetId": "usdt-bsc",
  "name": "Tether USD",
  "symbol": "USDT",
  "networkKey": "bsc",
  "isNative": false,
  "contractAddress": "0x55d398326f99059fF775485246999027B3197955",
  "decimals": 18,
  "explorerUrl": null,
  "enabled": true,
  "sortOrder": 0
}
```

Validation: addresses must pass EIP-55 and are stored checksummed; decimals must
be 0–36; a native asset must have no contract and a token asset must have one;
a network may have only one native asset, whose decimals must match the
network's.

### Networks

| Method | Path |
|---|---|
| `GET` | `/api/admin/networks` |
| `POST` | `/api/admin/networks` |
| `PUT` | `/api/admin/networks/:key` |
| `DELETE` | `/api/admin/networks/:key` |

Deleting a network that still has assets returns `409 NETWORK_IN_USE`.

### Application keys

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/admin/clients` | |
| `POST` | `/api/admin/clients` | Returns the plaintext key **once** |
| `POST` | `/api/admin/clients/:id/revoke` | |

### Audit and ledger

`GET /api/admin/audit?limit=200` · `GET /api/admin/transactions?limit=200`

---

## Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Body failed schema validation; `details` lists fields |
| `KEY_MATERIAL_REJECTED` | 400 | Body contained something resembling a private key |
| `UNKNOWN_ASSET` / `UNKNOWN_NETWORK` | 400 | Not configured |
| `CHAIN_MISMATCH` | 400 | Reported chain ≠ the asset's network |
| `CONTRACT_MISMATCH` | 400 | Reported contract ≠ the configured one |
| `TESTNET_ONLY` | 400 | Deployment refuses mainnet |
| `UNAUTHORIZED` | 401 | Missing/invalid credentials |
| `FORBIDDEN` | 403 | Role insufficient |
| `NOT_FOUND` | 404 | |
| `DUPLICATE_ASSET` / `DUPLICATE_TX_HASH` | 409 | Already exists |
| `ILLEGAL_STATE_TRANSITION` | 409 | Blocked by the state machine |
| `TX_HASH_IMMUTABLE` | 409 | Cannot reassign a hash |
| `NETWORK_IN_USE` | 409 | Network still has assets |
| `RATE_LIMITED` | 429 | Slow down |
| `HTTPS_REQUIRED` | 426 | Plaintext rejected |
| `INTERNAL_ERROR` | 500 | Logged server-side |
