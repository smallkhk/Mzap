# Security

What this application protects, how, and what it explicitly does not protect.

---

## 1. Wallet key handling

### Where the key lives

The signing key exists in exactly three forms:

| Form | Location | Protection |
|---|---|---|
| At rest | `%APPDATA%\flash-sender-desktop\wallet.vault` | scrypt (N=2¹⁷) + AES-256-GCM, then wrapped with Windows DPAPI |
| Unlocked | A module-private `Buffer` in the Electron **main** process | Never serialised; zeroed on lock |
| In use | A local variable inside one `signTransaction` call | Discarded when the call returns |

Two independent layers guard the file:

1. **Passphrase layer** — AES-256-GCM with a key derived by scrypt at
   N=131072, r=8 (~128 MiB, ~0.5–1s per attempt). Without the passphrase the
   ciphertext is useless even to someone holding the file, and the cost
   parameters make offline guessing expensive.
2. **OS layer** — `safeStorage`, which on Windows is DPAPI bound to the current
   user account. Copying the vault to another machine, or another Windows user
   on the same machine, makes it undecryptable regardless of the passphrase.

### Where the key never goes

There is no code path in this repository that puts key material into:

- source code, bundles, or the installer
- configuration files or environment variables
- the backend, in any request, in any field
- log output (the logger has a redaction list covering `privateKey`,
  `mnemonic`, `seedPhrase`, `password` and friends)
- the renderer process — the IPC allow-list in `preload.ts` has **no channel
  that returns a key**

The backend enforces this from its side too: `rejectKeyMaterial` middleware
scans every request body and rejects anything containing a field named like key
material, before it can be stored or logged.

### Process isolation

The renderer runs with `contextIsolation: true`, `nodeIntegration: false` and
`sandbox: true`. It is a plain web page whose only capability is the explicit
function list exposed by the preload script. It cannot reach `fs`,
`child_process`, `ipcRenderer`, or any channel not on that list. Signing happens
entirely in the main process; the renderer sees addresses, balances and hashes.

### Auto-lock

The vault re-locks after a configurable idle period (default 5 minutes) and on
application exit. Locking overwrites the key buffer with random bytes rather
than just dropping the reference.

---

## 2. Transaction integrity

The product's core claim is that it never reports something as sent when it
was not. That is enforced structurally, not by convention:

- **Hashes only come from the network.** The only assignment of `txHash` is from
  the response to `eth_sendRawTransaction`. There is no hash generation,
  derivation, or placeholder anywhere in the codebase.
- **Status only comes from receipts.** `CONFIRMED` is set only when a receipt
  with `status === 1` has been fetched and has the required confirmations.
  A receipt with `status === 0` (mined but reverted) produces **FAILED**, with a
  message explaining that gas was spent and no funds moved.
- **Settled states are immutable.** The backend's state machine makes
  `CONFIRMED`, `FAILED` and `REJECTED` terminal, and refuses any transition out
  of them. A buggy or malicious client cannot relabel a failure as a success
  after the fact.
- **A confirmed record must have an identity.** The API rejects any record
  reported as `BROADCASTING`/`PENDING`/`CONFIRMED` without a hash, and refuses
  to reassign a hash once one is set.

## 3. Pre-flight validation

Before a transaction is signed:

| Check | Failure behaviour |
|---|---|
| Recipient address format, EIP-55 checksum, not zero, not self | Specific error naming the exact problem |
| Amount parses exactly at the token's decimals | Rejected; no float arithmetic anywhere on the value path |
| RPC endpoint's real chain ID matches configuration | **Aborts** — queried via raw `eth_chainId`, bypassing the static pin |
| A contract is deployed at the configured address | Aborts |
| Contract's own `decimals()` matches configuration | **Aborts** — a mismatch would change the amount by orders of magnitude |
| Contract's `symbol()` matches configuration | Warns on the confirmation screen |
| Token balance covers the amount | Aborts, showing both figures |
| Native balance covers the fee (plus amount, for native sends) | Aborts, naming the shortfall |
| `eth_estimateGas` succeeds | Aborts — catches reverts before any gas is spent |

The confirmation dialog then shows the network, chain ID, asset, **contract
address**, amount, sender, recipient and estimated fee. Mainnet transfers require
an explicit acknowledgement tick-box.

## 4. Replay and duplication

- **EIP-155**: the chain ID is part of the signed payload, so a signature valid
  on one chain cannot be replayed on another.
- **Nonces** come from `eth_getTransactionCount(pending)`.
- **Idempotency**: each prepared transfer carries a client-generated UUID.
  The ledger is unique on `(client, clientRef)`, so a retried POST cannot create
  a second row, and unique on `(txHash, chainId)`, so one broadcast cannot be
  recorded twice.
- **Quote binding**: confirming sends back the quote's reference, not the
  parameters. The transaction that gets signed is exactly the one displayed —
  the renderer cannot alter the amount or recipient between the confirmation
  screen and the signature.

## 5. Transport and configuration

- The desktop client **refuses a non-HTTPS backend URL** (except loopback). A
  plaintext connection would let an attacker rewrite the contract addresses the
  app sends to.
- RPC endpoints must be `https://` or `wss://` for the same reason.
- `REQUIRE_HTTPS=true` makes the backend reject plaintext requests and emit
  HSTS.
- **The client re-validates everything the backend sends.** Addresses, chain
  IDs, decimals and native/token consistency are all checked on arrival, and
  anything failing is dropped from the asset list with a visible warning. A
  compromised backend cannot hand the client a malformed address.

## 6. Backend authentication and authorisation

| Surface | Mechanism |
|---|---|
| Admin dashboard | Argon2id passwords; 15-minute JWT access tokens; rotating single-use refresh tokens with reuse detection (a replayed token revokes the whole family) |
| Desktop clients | `X-API-Key`, stored only as SHA-256, revocable, shown once |
| Roles | `ADMIN` writes; `VIEWER` is read-only |

A desktop API key grants **read access to configuration and the ability to
record its own transactions — nothing else.** It can never modify an asset or a
contract address. Ordinary users therefore cannot introduce a contract address
of their own; only authenticated administrators can, and every such change is
audited.

Login responses are identical for "no such user", "wrong password" and "disabled
account", and the miss path spends comparable time, so the endpoint cannot be
used to enumerate accounts.

## 7. Rate limiting

Per-client (or per-IP) limits on all endpoints, a stricter limit on credential
endpoints keyed by IP **and** submitted email, and a tighter limit on ledger
writes. IPv6 clients are bucketed by /64 prefix, since a single subscriber is
typically handed a whole /64 and keying on the full address would make the limit
trivially avoidable.

## 8. Audit logging

Append-only records of every configuration change (with before/after values),
every authentication outcome, and every transaction state change — including
actor, IP and user agent. Viewable in the dashboard.

## 9. Testnet/mainnet separation

Two independent switches, both defaulting to off:

- Backend `TESTNET_ONLY=true` — refuses to store or serve any non-testnet
  network.
- Desktop **Allow mainnet** — refuses to send on any non-testnet network, and
  turning it on requires confirming a warning dialog.

A permanent banner names the current environment.

---

## What this does NOT protect against

Stated plainly, because believing otherwise is itself a risk:

- **A compromised Windows account.** DPAPI is bound to the user account, so
  malware running *as that user* can ask the OS to unwrap the vault. It still
  needs the passphrase for the inner layer, but a keylogger defeats that. Use a
  hardware wallet for balances you cannot afford to lose.
- **A wrong contract address you configured.** The app verifies a contract
  exists and that its decimals match, but a different valid contract is still a
  valid contract. Verify addresses at their source.
- **Sending to the wrong recipient.** Blockchain transfers are irreversible.
  The app validates the address is well-formed and warns you, but it cannot know
  who owns it.
- **A malicious administrator.** Anyone with an `ADMIN` account can point an
  asset at any contract they like. Audit logs record it; they do not prevent it.
  Limit who holds `ADMIN`.
- **A compromised RPC endpoint** can lie about balances and gas prices. It
  cannot forge a confirmation you can verify independently — always check the
  explorer link for anything significant.
- **Physical access to an unlocked machine** with the vault unlocked.

## Reporting a vulnerability

Do not open a public issue. Contact the maintainer directly with reproduction
steps.
