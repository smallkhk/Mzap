# Adding a token

This is the workflow the whole system is built around: **you add a token here,
and every desktop installation can send it — without a rebuild, a reinstall, or
an update of any kind.**

---

## Before you start

You need four facts about the token, from a source you trust — its own project
documentation, or the block explorer for the chain it lives on:

| Fact | Example | Why it matters |
|---|---|---|
| Contract address | `0x337610d2…` | Where the tokens actually live. Wrong address = funds sent to the wrong contract, unrecoverable. |
| Decimals | `18` | Determines the amount actually transferred. Off by one = 10× the intended amount. |
| Symbol | `USDT` | Display only. |
| Chain | BSC testnet (97) | A token exists on one chain; the same symbol on another chain is a different token. |

> **Verify the contract address on the block explorer before entering it.**
> Many chains host multiple tokens using the same symbol, and search results and
> aggregator sites are a common source of counterfeit addresses. The
> authoritative source is the token issuer's own documentation.
>
> The application defends against a wrong *decimals* value — it reads the
> contract's own `decimals()` before every send and refuses to proceed on a
> mismatch. It cannot defend against a wrong *contract address*, because a
> different contract is a perfectly valid contract. That one is on you.

---

## Step 1 — make sure the network exists

**Networks** tab. If the chain you need is not listed, add it:

| Field | Example (BSC testnet) | Example (BSC mainnet) |
|---|---|---|
| Key | `bsc-testnet` | `bsc` |
| Name | `BNB Smart Chain Testnet` | `BNB Smart Chain` |
| Chain ID | `97` | `56` |
| RPC endpoints | `https://bsc-testnet-rpc.publicnode.com` | `https://bsc-dataseed.bnbchain.org` |
| Block explorer | `https://testnet.bscscan.com` | `https://bscscan.com` |
| Native symbol | `tBNB` | `BNB` |
| Native decimals | `18` | `18` |
| Is testnet | ✔ ticked | ✗ unticked |

Notes:

- Enter **more than one RPC endpoint**, one per line. They are tried in order,
  so a single provider going down does not take the app offline.
- Endpoints must be `https://` or `wss://`. Plaintext HTTP is rejected — it
  would let a network attacker rewrite the balances and gas prices you see.
- The chain ID is checked against what the RPC endpoint actually reports before
  every send. A mismatch aborts the transaction.
- A backend running with `TESTNET_ONLY=true` will refuse to save a network with
  "is testnet" unticked.

---

## Step 2 — add the token

**Assets** tab → **+ Add asset**.

### Worked example: test USDT on BSC testnet

| Field | Value |
|---|---|
| Asset ID | `usdt-bsc-testnet` |
| Symbol | `USDT` |
| Name | `Tether USD (testnet)` |
| Network | BNB Smart Chain Testnet — chain 97 |
| Native coin? | ✗ unticked |
| Contract address | `0x337610d27c682E347C9cD60BD4b3b107C9d34dDd` |
| Decimals | `18` |
| Explorer override | *(blank — inherits the network's)* |
| Enabled | ✔ |

**Asset ID** is a permanent identifier used in transaction records. Use
lowercase with hyphens, and include the chain, since the same token on two
chains needs two entries: `usdt-bsc`, `usdt-polygon`.

### Worked example: a native coin

Native coins (BNB on BSC, ETH on Ethereum, POL on Polygon) have **no contract
address** — they are the chain's own currency, moved by a value transfer rather
than a contract call.

| Field | Value |
|---|---|
| Asset ID | `tbnb` |
| Symbol | `tBNB` |
| Name | `Test BNB` |
| Network | BNB Smart Chain Testnet |
| Native coin? | ✔ **ticked** |
| Decimals | `18` (must equal the network's native decimals) |

The contract field disappears when you tick "native coin". A network can have
only one native asset, and the backend enforces both rules.

---

## Step 3 — confirm it reached the app

Saving increments the **configuration version**, shown in the dashboard header.

In the desktop app the token appears within the poll interval (60s by default),
or immediately via **Settings → Refresh assets now**. It will then be in the
Asset dropdown for its network.

To check from the command line what the app will see:

```bash
curl -s http://localhost:4000/api/config \
  -H "X-API-Key: fsk_your_key" | jq '.assets[] | {id, symbol, contractAddress, decimals, chainId}'
```

---

## Step 4 — test with a small amount first

Before relying on a newly added token — **especially on mainnet** — send a
deliberately tiny amount to an address you control and confirm it arrives.

The app will, before broadcasting anything:

1. Verify the RPC endpoint really is the configured chain.
2. Confirm a contract is actually deployed at the configured address.
3. Read the contract's own `decimals()` and **abort on a mismatch** with your
   configured value.
4. Compare the contract's own `symbol()` and warn if it differs from yours.
5. Check the token balance covers the amount, and the native balance covers the
   fee.
6. Run `eth_estimateGas`, which executes the transfer against current state — so
   a paused token or a blocked address fails *here*, before you have spent
   anything.

If any of these fail you get a specific message naming the problem, not a
generic error.

---

## Removing or disabling a token

**Disable** (the switch in the Assets table) — the token vanishes from every
desktop app on their next sync. History for it is preserved. This is reversible
and is what you want almost every time.

**Delete** — permanently removes the configuration row. Existing transaction
records keep their own copies of the symbol, decimals and contract address, so
history stays readable. Prefer disabling.

Both actions are recorded in the audit log with the before/after values and the
administrator who made the change.

---

## Common problems

| Message | Meaning |
|---|---|
| *"Address has an invalid checksum"* | The address has mixed capitalisation that fails EIP-55 — at least one character is wrong. Re-copy from the explorer; do not retype. |
| *"An asset with that identifier … already exists"* | The Asset ID or the contract-address-on-that-network is already registered. |
| *"There is no contract deployed at 0x… "* | Right format, wrong address, or the address is from a different chain. |
| *"…reports 18 decimals, but this asset is configured with 6"* | Your decimals value is wrong. Use the number the contract reports. |
| *"A native coin has no contract address"* | Untick "native coin", or clear the contract field. |
| *"This deployment is configured for testnets only"* | The backend has `TESTNET_ONLY=true`. Deliberate — see the deployment guide before changing it. |
| Token not appearing in the desktop app | Check it is Enabled, its network is Enabled, and — if it is a mainnet asset — that "Allow mainnet" is on in the app's Settings. |
