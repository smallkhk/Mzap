# Generate tokens — buying via a DEX

A swap feature, deliberately not called one anywhere a customer sees it —
"Generate tokens" — since "swap" invites the wrong expectation for something
this specific: paste a token's contract address, spend from a wallet this app
already controls, and the purchase lands there. Two versions of it exist,
sharing one backend pipeline:

- **The admin dashboard's** — spends the shared custodial wallet's own funds,
  and the purchase lands right back in that same wallet. No markup; there's
  no one to charge.
- **The customer portal's** — spends a deposit address generated for that one
  customer. A markup you set is real: the customer is credited less than the
  market rate, and the difference is sent on-chain to a profit address. The
  remainder doesn't stay in the customer's deposit address — see
  [below](#the-sweep-to-the-custodial-wallet) — it moves into the shared
  custodial wallet immediately after the buy, the same balance the send
  feature actually spends from.

---

## The quote/execute pipeline

Same two-phase shape as sending, for the same reason:

```
prepare (quote)                              execute (confirm)
  │                                             │
  ├─ verify the token is a real contract        ├─ re-verify chain id
  │  (decimals(), symbol() read live —          ├─ (customer buys only) send
  │   never trusted from the pasted address)    │  the fee, straight from the
  ├─ check the spending wallet's real balance    │  spend asset, to the
  ├─ (customer buys only) take the markup        │  profit address
  │  off the spend amount — this is what's       ├─ approve LI.FI's named
  │  actually swapped, not the full amount       │  contract, if the spend
  ├─ ask LI.FI for *every* route it can find      │  asset is a token
  │  (Fly, 1inch, Nordstern, whichever on-chain   ├─ sign and broadcast LI.FI's
  │  DEX has liquidity) and pick whichever         │  own transactionRequest —
  │  actually returns the most, plus a second,    │  never hand-built calldata
  │  independent 1inch quote, in parallel         ├─ read the token balance
  ├─ turn the winning route into an already-       │  before/after to find the
  │  ready transaction via LI.FI, store it with   │  *actual* amount received —
  │  an extra 1% slippage floor, by an opaque id   │  credited in full, nothing
  └─ show the comparison + what the buyer          │  skimmed a second time
     will actually receive                        └─ (customer buys only) sweep
                                                      it to the custodial wallet
```

Execution goes through **LI.FI**. It aggregates across many underlying
on-chain routers — Fly, 1inch, Nordstern, and whichever on-chain DEX
actually has liquidity for the pair, the same pool jumper.xyz's own UI draws
from, since Jumper is LI.FI's own front-end. A single quote call only
returns LI.FI's own default pick among them, which is not always the
best one — this app instead asks for every route LI.FI can find and picks
whichever actually returns the most, shown in the dashboard as "best output
found via `<tool>`". This app never hand-builds swap calldata: it signs and
broadcasts LI.FI's own `transactionRequest` for the route it picked,
unmodified, after re-estimating gas itself immediately before signing — the
`to` and `data` are never edited, only decided whether to sign. 1inch is
queried directly too, as a second, independent quote for comparison; it is
never used to execute.

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

## The sweep to the custodial wallet

A customer's deposit wallet exists to fund and receive their buy — it isn't
a wallet the rest of the app can spend from. The **send** feature (the
actual flash-sender) only ever signs from the one shared custodial wallet in
[`CUSTODIAL.md`](CUSTODIAL.md); a customer's spending limit is an allowance
against that single shared balance, not a balance of their own. Left in
their deposit wallet, a customer's purchase would just sit there, unusable
by anything else in the app.

So immediately after a customer buy confirms — after the swap, and after the
markup skim if one applies — whatever the customer was credited is swept
on-chain from their deposit wallet into the custodial wallet, using the same
signing capability the app already holds over that address (it derived the
key from the buy seed; the customer never had it). From the customer's side
nothing changes: "credited" already meant an amount tracked by this app, not
literal custody of an address they hold the key to, the same as everywhere
else in this custodial design.

This only happens when the deployment actually runs a custodial wallet. On a
buy-only deployment with no shared wallet configured, there is nothing to
feed, so the sweep is skipped — the purchase simply stays in the customer's
deposit wallet, same as before this existed. The sweep is a plain ERC-20
`transfer`, so it costs gas from the deposit wallet's own native balance —
one more leg alongside the approve, the swap, and the markup skim; see
**Operational notes** below on funding it.

---

## Markup and the profit address

Set from the admin dashboard's **Generate tokens** tab — as a **charge
multiplier** there (3 means "charge 3x the real rate"), converted for you
into the API's own unit — or directly:

```bash
curl -X PUT https://send.example.com/api/admin/buy/settings \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"buyMarkupBps": 250, "profitAddress": "0x…"}'
```

`buyMarkupBps` is basis points of the *spend* amount taken as a fee — 250 =
2.5%. A multiplier and a percentage describe the same number two ways: a 3x
multiplier is exactly a 66.67% fee (swap 1/3 of what was spent, so the
credited amount cost 3x what it would have at the real rate); multiplier M
converts to `round((1 - 1/M) × 10000)` basis points. A markup with **no** profit
address does nothing: there is deliberately no fallback destination, so a
buy can never skim funds to nowhere. Set both together, or neither.

**The fee is taken from the spend asset, before the swap runs — not from the
token that comes back.** A 2.5% markup on a 1 USDT buy sends 0.025 USDT to
the profit address and swaps the remaining 0.975 USDT; the customer is
credited 100% of whatever that swap actually returns, none of it skimmed
afterward. This is deliberate: what the customer is quoted is what they
get, exactly, with no second deduction hiding in the token they didn't pick
the price of. The split is computed once, at quote time, and locked into
that quote — `confirm` moves exactly the fee and swaps exactly the amount
that was shown, never a live re-read of the current settings.

This only ever applies to the **portal's** buy tool. The admin dashboard's
own buy spends the shared wallet's own money; there is no markup to apply
against yourself.

---

## What you can spend to buy

Buying only accepts the chain's native coin or **the real USDT contract** —
never any asset that happens to be in the catalog. The real BNB Smart Chain
USDT address (`0x55d398326f99059fF775485246999027B3197955`, 18 decimals) is
hardcoded, and it's this hardcoded address — not a database lookup — that
actually gets read, approved and spent whenever USDT is selected to spend.
An asset row in the dashboard's Assets list named "USDT" is consulted only
for its *label*, so it can appear as a friendly option in the picker; its
own `contractAddress` field is never read for the buy feature, so it does
not matter whether that row happens to be configured correctly. This is
deliberate: an asset labeled "USDT" pointing at the wrong contract — by
mistake, or by design — could otherwise have been spent as if it were real
USDT. Deliberately scoped to BNB Smart Chain only for now — USDT spends on
any other chain are refused until a verified address is added for it too.

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

**No mainstream route is itself a signal — read it.** A well-known token
(the real USDT, the real BNB) has liquidity on more than one aggregator; a
route that exists on LI.FI through some obscure underlying tool but nowhere
else is exactly the profile of a token that no real market maker has ever
touched. Before trusting a symbol, check the contract's actual name and
symbol strings character by character — a common trick is spelling "USDT"
using look-alike characters from other alphabets (Armenian Ս/Տ, Cyrillic е,
Lisu ꓔ and similar are common stand-ins for U/S/T/e) so it reads as the real
thing in a token list while being an entirely different, unrelated contract.
`cast 4byte`, a block explorer's own token page, or just pasting the decoded
bytes through Python's `repr()` will show this immediately; the dashboard
does not do this check for you.

---

## Operational notes

**Gas.** Every leg — the approve (if the spend asset is a token, not native),
the swap, the markup transfer (if one applies), and the sweep to the
custodial wallet (customer buys, on a deployment that runs one) — costs gas
from the *buying* wallet's own native balance, separate from whatever it's
spending. A deposit address funded with exactly enough USDT to buy but no
native coin for gas will fail cleanly at the balance-check step with a
message naming the shortfall.

**Testnet liquidity is not production liquidity.** BSC testnet's real pools
are whatever developers happened to seed and haven't drained since — quotes
against them can show wildly implausible rates. That's expected and not a
bug in this feature; it's testnet DEX liquidity doing what testnet DEX
liquidity does. Verify the mechanics there, not the prices.

**Audit trail.** Every quote's outcome, the approve (if any), the swap, and
the markup skim (if any) are recorded — the swap as a normal entry in
History, the rest via the audit log — with the installation that requested
it, same as every other money-moving action in this app.
