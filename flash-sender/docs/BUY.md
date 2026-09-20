# Generate tokens — buying via a DEX

A swap feature, deliberately not called one anywhere a customer sees it —
"Generate tokens" — since "swap" invites the wrong expectation for something
this specific: paste a token's contract address, spend from a wallet this app
already controls, and the purchase lands in that same wallet. Two versions of
it exist, sharing one backend pipeline:

- **The admin dashboard's** — spends the shared custodial wallet's own funds.
  No markup; there's no one to charge.
- **The customer portal's** — spends a deposit address generated for that one
  customer. A markup you set is real: the customer is credited less than the
  market rate, and the difference is sent on-chain to a profit address.

---

## The quote/execute pipeline

Same two-phase shape as sending, for the same reason:

```
prepare (quote)                              execute (confirm)
  │                                             │
  ├─ verify the token is a real contract        ├─ re-verify chain id
  │  (decimals(), symbol() read live —          ├─ approve the router, if the
  │   never trusted from the pasted address)    │  spend asset is a token
  ├─ check the spending wallet's real balance    ├─ swap via PancakeSwap V2
  ├─ quote PancakeSwap (on-chain), 1inch and     ├─ read the token balance
  │  LI.FI (both HTTP APIs) in parallel         │  before/after to find the
  ├─ store the route + a 1% slippage floor,     │  *actual* amount received
  │  referenced by an opaque id                 ├─ (customer buys only) send
  └─ show the comparison + what the buyer        │  the markup cut on-chain
     will actually receive                       └─ to the profit address
```

Execution only ever goes through **PancakeSwap**. 1inch and LI.FI are real,
independently-fetched quotes — genuine numbers, not estimates — shown so the
buyer sees an honest comparison, but their calldata is never signed. Routing
a signed transaction through a third-party aggregator's returned calldata is
a materially larger trust surface than a router call this app fully controls
and can reason about; that's a real feature to add later, not something to
build without giving it its own scrutiny.

`execute` takes only a reference to the quote, never the amount or token
again — exactly like `send/confirm` — so a tampered client cannot change what
gets bought between the screen and the signature.

---

## The customer deposit wallet

Every portal-enabled customer's "Generate tokens" wallet is a distinct
address, but there is only **one secret** behind all of them: a BIP-39 seed,
and every customer's address is a deterministic child of it
(`m/44'/60'/0'/0/{index}`) — the same pattern exchanges use for deposit
addresses. Nothing is ever stored per-customer except which index they were
assigned; the actual signing key is re-derived from the seed on demand and
held only for the instant it's needed.

This is a **separate** seed from the shared custodial wallet in
[`CUSTODIAL.md`](CUSTODIAL.md) — sealed in its own vault, unlocked with its
own passphrase. Either can be configured without the other; a deployment can
run local signing with no shared wallet at all and still offer the buy
feature to portal customers, or vice versa.

### Setting it up

```bash
cd backend
npm run import-buy-seed -- --out /home/USER/secure/buy-seed.vault
```

By default this **generates** a fresh 24-word phrase and shows it once —
there's nothing to import, this is a purpose-built seed. Write it down and
store it exactly as carefully as a wallet holding real funds, because within
a few clicks in the portal, it will be one.

```bash
# .env
BUY_WALLET_VAULT_PATH=/home/USER/secure/buy-seed.vault
BUY_WALLET_PASSPHRASE=<the passphrase you chose>
```

Restart. The startup log confirms it unlocked. Absent configuration just
means the buy feature stays off — the portal's "Generate tokens" tab doesn't
appear, and the admin dashboard's shows a plain "not configured" message
instead of erroring.

---

## Markup and the profit address

Set from the admin dashboard's **Generate tokens** tab, or:

```bash
curl -X PUT https://send.example.com/api/admin/buy/settings \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"buyMarkupBps": 250, "profitAddress": "0x…"}'
```

`buyMarkupBps` is basis points — 250 = 2.5%. A markup with **no** profit
address does nothing: there is deliberately no fallback destination, so a
buy can never skim funds to nowhere. Set both together, or neither.

The skim is computed against what the swap **actually** returned — read from
the wallet's real balance delta before and after, not the pre-computed quote
— so a fee-on-transfer token or any other surprise in the swap's real output
is what gets split, not an estimate.

This only ever applies to the **portal's** buy tool. The admin dashboard's
own buy spends the shared wallet's own money; there is no markup to apply
against yourself.

---

## What a wrong contract address does, and doesn't, cost

Pasting a bad address is the main way this feature can go wrong, so it's
worth being precise about what's checked and what isn't:

- **Not a contract at all** → refused before any balance is even read
  (`eth_getCode` comes back empty).
- **A contract with no `decimals()`** → refused; this app never guesses a
  token's decimals the way an EOA-quality accident could.
- **A contract that *is* a token, just the wrong one** → nothing here can
  catch that. If the address is a real, working ERC-20 that simply isn't the
  token you meant, the swap succeeds and buys exactly that token. Check the
  address against the project's own site or a block explorer before buying,
  the same discipline as checking a send recipient — this app verifies the
  contract *shape*, never the *identity* someone claims for it.

---

## Operational notes

**Gas.** Every leg — the approve (if the spend asset is a token, not native),
the swap, and the markup transfer (if one applies) — costs gas from the
*buying* wallet's own native balance, separate from whatever it's spending.
A deposit address funded with exactly enough USDT to buy but no native coin
for gas will fail cleanly at the balance-check step with a message naming
the shortfall.

**Testnet liquidity is not production liquidity.** BSC testnet's real pools
are whatever developers happened to seed and haven't drained since — quotes
against them can show wildly implausible rates. That's expected and not a
bug in this feature; it's testnet DEX liquidity doing what testnet DEX
liquidity does. Verify the mechanics there, not the prices.

**Audit trail.** Every quote's outcome, the approve (if any), the swap, and
the markup skim (if any) are recorded — the swap as a normal entry in
History, the rest via the audit log — with the installation that requested
it, same as every other money-moving action in this app.
