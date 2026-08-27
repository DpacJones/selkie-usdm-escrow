# Moving USDM to Midnight and escrowing it: what the docs don't tell you

I spent a day building two things on Midnight Preview with VIA Labs' USDM bridge:

- **[Tidal](https://github.com/DpacJones/tidal-usdm-transfer)** .. a web front-end for USDM transfers in both directions, with live delivery status pulled from VIA Scan.
- **[Selkie](https://github.com/DpacJones/selkie-usdm-escrow)** .. an original Compact escrow contract that custodies USDM and releases it to whoever proves knowledge of a secret. Deployed at `e4fc8d6614ab5abf60fbe7b14e1968a98797e405b4cdc6c6f5214c9b536b56bd`.

Both work. What follows is the part I actually want to write down: the things that cost me time because they were not in any doc, and one security bug that is worth more than the working code.

---

## 1. The bridge is genuinely two different machines in two directions

Cardano → Midnight is boring in the best way. It builds a Cardano transaction, locks USDM in VIA's lock-and-release client, and emits a `send_request`. Validators pick it up and mint on Midnight. My first one:

```
Bridging 5 USDM  Cardano -> Midnight  to mn_addr_preview1mkgjwqf...
DONE: {
  direction: 'cardano-to-midnight',
  txHash: '257c176095e81cd93ddd098039f97cacbb40797cef4c2e747b76e3046a5686e6'
}
```

Delivered in **1m 49s**, one confirmation on Preprod.

Midnight → Cardano is a different animal. It calls a ZK circuit on the USDM contract, and *your machine generates the proof*. You need a local proof server, and you pay the fee in DUST, not in the token you are moving:

```
Bridging 5 USDM  Midnight -> Cardano  to addr_test1qpu480k...
DONE: {
  direction: 'midnight-to-cardano',
  txHash: '02a0526e2b541d59da548160b1964b4b2fe79adc2482a08af8e6324c0313e7cc',
  txId:   '0061f1ce3f4317fd1ed5b9840a668047c5b99d8eb43d5e135e59d12426c8b9410b'
}
```

Note it returns **two** identifiers. `txHash` is the one VIA Scan indexes; `txId` is the Midnight transaction identifier. I wired the wrong one into a UI link first and got a dead page.

## 2. DUST is not a token you can get. You grow it.

This is the single biggest conceptual gap for someone arriving from an EVM or XRPL background. There is no DUST faucet. DUST is not transferable. You cannot buy it.

What you do instead: request tNIGHT from the faucet, then **register those NIGHT UTxOs for DUST generation**, and DUST accrues over time at a rate proportional to the NIGHT you hold.

```
NIGHT UTxOs: 1 total, 1 not yet registered for dust generation
  9f33067354ae126a…#0  5000000000 units  registered=false
Registration fee estimate: 300000000000001
Proving + finalizing registration transaction…
Submitted dust registration tx: 009746478e09bc326bac10f0d005640af6b3cf60f63c6f161d2941573ea7acba4a
Confirmed — NIGHT is registered; DUST now accrues over time.
```

The registration fee is *payable from the DUST those UTxOs will generate*, which reads like a bootstrapping paradox the first time you see it. It works.

Watching it grow across the day, from the same wallet:

| time | DUST (specks) |
|---|---|
| just after registration | `465018749999999999` |
| ~20 min later | `644867334999999999` |
| a few hours later | `2177186464999999999` |

Those are specks: 10^15 per DUST. So ~465 → ~2177 DUST.

**Plan for the wait.** If you are doing a Midnight → Cardano transfer, register NIGHT *first*, go do something else, and come back. A dry wallet gives you an `OUT_OF_DUST` error that names the dust key it checked, which is a genuinely good error message, but it is still a wall.

## 3. The first wallet sync runs from genesis, and it is slower than you expect

```
Syncing Midnight wallet from genesis (this takes a while on first run)…
  syncing… 152,629 indexes (333 idx/s)  7.6min
  synced — 152,829 indexes in 7.7min
```

Nearly eight minutes. After that it caches to `wallet-state.json` and restores in well under a second:

```
Restoring Midnight wallet state…
  synced — 153,739 indexes in 0.0min
```

Two things worth knowing. First, the indexer does not report a chain tip, so a genuine percentage bar is impossible .. you can show applied index and throughput, nothing better. Second, **copy `wallet-state.json` between projects**. When I started the Selkie repo I copied the cache from the bridge project and skipped the eight minutes entirely.

You will also see this constantly, and it is harmless:

```
RPC-CORE: subscribeRuntimeVersion(): RuntimeVersion:: disconnected from
wss://rpc.preview.midnight.network/: 1000:: Normal Closure
```

Normal websocket idle-close. Ignore it.

## 4. The DUST balance is a method, not a field

The bridge package ships a `balance.mjs` that prints wallet balances. Mine kept printing:

```
--- dust ---
undefined
```

I assumed the dust wallet component had not delivered its state yet, waited, re-ran, same thing. It was not a race. In `@midnight-ntwrk/wallet-sdk-facade` 3.x, `DustWalletState` exposes:

```typescript
balance(time: Date): Balance;
```

DUST **accrues continuously**, so its balance is a function of *when you ask*. There is no `walletBalance` field to read. The fix is one line:

```javascript
const dust = s.dust.balance(new Date())
```

which gave `465018749999999999` where the property read had given `undefined`. If you are chasing an undefined DUST balance, this is almost certainly why.

## 5. Compact contracts really can custody unshielded tokens

I went in expecting to have to settle USDM at the application layer .. contract holds the state machine, app moves the money. That turned out to be unnecessary. At language 0.22 / runtime 0.15, `receiveUnshielded` and `sendUnshielded` work, and the contract itself holds the tokens.

From `selkie.compact`:

```compact
export circuit create_escrow(amount: Uint<128>): Bytes<32> {
  const amt = disclose(amount);
  assert(amt > 0, "selkie: amount must be positive");

  const id = claim_ticket(selkie_claim_secret());
  assert(!escrows.member(id), "selkie: escrow id already used");

  receiveUnshielded(token_color, amt);
  ...
}
```

The property that makes this pleasant: **the ledger refuses to apply the transaction unless it is balanced by a matching unshielded input.** So a recorded escrow is always a funded escrow. There is no window where the contract's state says "escrowed" but no tokens moved, and you do not have to write defensive code for that case.

Proof, on Preview:

| step | tx | wallet USDM |
|---|---|---|
| before | | 10.000000 |
| `create_escrow 2.5` | `00df8e8059d860a632fb8ccf23f6fbe32abcb7a0ebdf81bb51a4efa7fd77faac44` | 7.500000 |
| `claim` | `00d301e61e23c321925c3b201fd2fe62618dd638e9d6f75070d827ed7dc8df50d3` | 10.000000 |

The 2.5 USDM was in contract state in between. Escrow `c9c1909c93b4241a9a368616564a1c246a3579e4339f8759a1046b89962c15a6`, settled by presenting a secret .. no identity check anywhere in the path.

One caveat: `getUnshieldedBalances(publicDataProvider, contractAddress)` returned `[]` for my contract even while it demonstrably held tokens. The indexer's contract-balance view lags. I made the ledger state the source of truth and treat the indexer number as supplementary.

## 6. Two copies of the runtime will break you in a way the error does not explain

This one cost me the most time. Deploying failed with:

```
Error: expected instance of ContractMaintenanceAuthority
    at _assertClass (.../onchain-runtime-v3/midnight_onchain_runtime_wasm_bg.js:992:15)
```

Nothing to do with maintenance authorities. The real cause: my `contract/` folder had its own `node_modules`, so `@midnight-ntwrk/onchain-runtime-v3` was installed **twice**. Two WASM module instances means two distinct class identities, and an object built by one fails an `instanceof` check in the other.

The fix was to make `contract/` an npm workspace so everything hoists to one copy:

```json
"workspaces": ["contract"]
```

then blow away both `node_modules` and reinstall. Verify with:

```powershell
Get-ChildItem -Recurse -Directory -Filter "onchain-runtime-v*"
# exactly one result, or you are not done
```

**Any `expected instance of X` error from a Midnight WASM package is a duplicate-package error until proven otherwise.** Do not go reading the SDK source for what a ContractMaintenanceAuthority is, like I did.

## 7. Small API papercuts, collected

- **`CompiledContract.make` wants the class, not an instance.** Passing `new Contract(witnesses)` gives `context.ctor is not a constructor`. Pass `Contract` and attach witnesses with the `withWitnesses` combinator:

  ```javascript
  CompiledContract.make('selkie', Contract).pipe(
      CompiledContract.withWitnesses(witnesses),
      CompiledContract.withCompiledFileAssets(ARTIFACTS_DIR),
  )
  ```

- **The private state provider enforces password complexity.** `Password must contain at least 3 of: uppercase letters, lowercase letters, digits, special characters. Found: 2`. This encrypts a local store, not a wallet, but it will stop your deploy dead.

- **`bridgeUSDM` requires `recipient` in both directions.** The CLI makes it look optional because it defaults it for you. Calling the library directly with it omitted is a type error.

- **The bridge package's `exports` map only exposes the main entry.** `import('@via-labs-tech/usdm-bridge/dist/midnight/wallet.js')` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Everything you need is re-exported from the root.

- **VIA Scan resolves by source transaction hash**, so `https://scan.vialabs.tech/tx/<sourceTxHash>` just works .. no need to look up a message id first. There is a JSON API behind it at `https://scansite.druuu.net/api/v1/transactions/<hash>` returning `deliveredAt`, `destinationTx`, and a decoded payload, which is what Tidal polls for live status.

## 8. The bug that matters

Selkie's design is: the escrow id is a commitment to a claim secret, and a second commitment authorizes cancellation. Two witnesses, `selkie_claim_secret()` and `selkie_refund_secret()`.

The first witness implementation gave every actor both fields and zero-filled the one they did not have. An adversarial review pass found the problem:

**`create_escrow` calls both witnesses.** So a claimant-shaped private state used to deposit would publish `refundTicket(0x00…00)` .. a *publicly computable constant* .. as the cancel authority. Anyone scanning the ledger for that constant could cancel the escrow and take the funds.

The root cause is the interesting part, and it generalizes beyond this contract:

> A circuit cannot distinguish a real secret from an unset one. A commitment to 32 zero bytes is a perfectly valid commitment. `assert()` inside the circuit cannot help you, because nothing about the value is malformed.

The guard has to live at the TypeScript trust boundary, and it has to make the bad state *unrepresentable* rather than merely discouraged:

```typescript
export type SelkiePrivateState =
  | { readonly role: 'depositor'; readonly claimSecret: Uint8Array; readonly refundSecret: Uint8Array }
  | { readonly role: 'claimant';  readonly claimSecret: Uint8Array }
```

A claimant state has no `refundSecret` field at all, the refund witness throws rather than returning zeros, and `assertSecret()` rejects all-zero secrets on every path. The review also caught that refund tickets needed to be bound to their escrow id, otherwise reusing one refund secret across escrows publishes an identical constant each time and clusters them as yours.

If you write Compact, the lesson to steal is this: **your witness layer is a trust boundary, and the compiler is not watching it.** Worse, `persistentCommit` clears witness taint, so once you commit a secret the disclosure checker stops tracking values derived from it. A future edit that leaks one will compile silently. That is now a comment at the top of my contract.

## 9. What I would tell someone starting tomorrow

1. Register NIGHT for DUST **first**, before you write any code. It accrues while you work.
2. Keep a `wallet-state.json` around and copy it between projects.
3. One `node_modules`. Use workspaces from the start.
4. Pin compiler, language, and runtime together and write the versions in your README. Mine: compactc 0.30.0, language 0.22, compact-runtime 0.15.0, ledger-v8 8.0.3, midnight-js 4.0.4, proof server 8.0.3.
5. Be precise in your README about what is actually private. Selkie hides the *secrets*, but USDM is an unshielded token, so amounts and settlement addresses are public. It provides possession-based authorization without an identity registry .. not payment privacy. Overclaiming that distinction is the easiest way to mislead people.

## Repos

- **Selkie** .. private USDM escrow contract, CLI, 30 tests: https://github.com/DpacJones/selkie-usdm-escrow
- **Tidal** .. USDM transfer front-end with live VIA Scan status: https://github.com/DpacJones/tidal-usdm-transfer

Built on the [Midnight Network](https://midnight.network). USDM by [Moneta](https://moneta.global), carried between chains by [VIA Labs](https://vialabs.io).
