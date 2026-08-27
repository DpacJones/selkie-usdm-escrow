# Selkie

**A private USDM escrow, built on [Midnight](https://midnight.network).**

This project is built on the Midnight Network.

A selkie leaves its sealskin on the shore, and whoever holds the skin holds the claim. Selkie escrows work the same way: a depositor locks USDM behind a commitment, and whoever can prove knowledge of the matching secret takes the funds. There is no allowlist, no signature check, and no identity anywhere in the claim path .. **possession of the secret is the authorization, and the secret itself never touches the chain.**

The USDM being escrowed is the same USDM that moves natively between Cardano and Midnight through [VIA Labs](https://vialabs.io) cross-chain messaging. Bridge it over, escrow it here, hand someone a secret.

Built for the Midnight Network Zealy sprint (VIA Labs Partner Module).

## Deployed on Midnight Preview

| | |
|---|---|
| **Contract address** | `e4fc8d6614ab5abf60fbe7b14e1968a98797e405b4cdc6c6f5214c9b536b56bd` |
| Deploy tx | `0024bf2086aa32be872dea428c5e9bb956c6b2d693816235ba4f6a1f970196bbe7` |
| Escrowed asset | USDM, token color `003bacd9a361ba0d425e408776020e40271375e8b8de42d73eec046a44947d73` |

Successful on-chain interactions after deployment:

| Action | Tx | Effect |
|---|---|---|
| `create_escrow` 2.5 USDM | `00df8e8059d860a632fb8ccf23f6fbe32abcb7a0ebdf81bb51a4efa7fd77faac44` | wallet 10.0 → 7.5 USDM; escrow `c9c1909c…` opened |
| `claim` | `00d301e61e23c321925c3b201fd2fe62618dd638e9d6f75070d827ed7dc8df50d3` | wallet 7.5 → 10.0 USDM; escrow marked `claimed` |

Escrow id `c9c1909c93b4241a9a368616564a1c246a3579e4339f8759a1046b89962c15a6`, settled by presenting the claim secret alone .. no identity check was involved.

## Where USDM is handled: **the contract layer**

This is a real custody contract, not a bookkeeping contract that defers settlement to an application. The tokens sit in contract state between create and claim:

- [`contract/src/selkie.compact`](contract/src/selkie.compact) → `create_escrow` calls **`receiveUnshielded(token_color, amt)`**, pulling the depositor's USDM into the contract. The ledger refuses to apply the transaction unless it is balanced by a matching unshielded input, so **a recorded escrow is always a funded escrow** .. there is no window where state says "escrowed" but no tokens moved.
- `claim` and `cancel` call **`sendUnshielded(token_color, e.amount, right<ContractAddress, UserAddress>(...))`**, releasing to the address supplied as a public circuit input.
- The token color is a **`sealed ledger`** field fixed at deployment, so an instance can never be re-pointed at a different asset.

The CLI in [`selkie.mjs`](selkie.mjs) never moves USDM by itself. It only builds, proves, and submits circuit calls; every token movement is performed by the contract inside the transaction it proves.

## What is private, and what is not

Being precise about this matters more than sounding impressive.

**Private:** the claim secret and the refund secret. They are supplied as witnesses, live only on the prover's machine, and are never placed in a transaction. The chain only ever sees `persistentCommit(<domain tag>, secret)`.

**Public:** the amount, the escrow id, the refund commitment, and the settlement address. USDM is an *unshielded* token, so the depositor's funding input and the payee's receiving output are both transparent. An observer can reconstruct who paid whom and how much.

So Selkie provides **possession-based authorization without an identity registry**, not payment privacy. Amount and counterparty privacy would need shielded tokens and a nullifier set .. a different contract, and an honest roadmap item rather than a claim.

## How it works

```
depositor                          chain                          payee
   |                                 |                              |
   |-- create_escrow(amount) ------->|                              |
   |   witness: claim + refund       | receiveUnshielded(USDM)      |
   |   secrets (never sent)          | escrows[id] = {amount, ...}  |
   |                                 |                              |
   |------------- claim secret, out of band --------------------->  |
   |                                 |                              |
   |                                 |<---- claim(id, payout) ------|
   |                                 |  witness: claim secret       |
   |                                 |  assert commit(secret) == id |
   |                                 |  sendUnshielded(USDM, payout)|
```

The escrow id **is** the claim ticket: `persistentCommit(pad(32, "selkie:claim:v1"), claim_secret)`. That has three consequences worth noting:

- The payee derives the escrow id from the secret alone .. nothing else needs to be communicated.
- Publishing the id reveals nothing, because it is a hiding commitment.
- The map entry doubles as its own nullifier. Entries are retained after settlement with a terminal status rather than deleted, so an id can never be re-created or re-claimed and **no separate nullifier set is needed**.

`payout` is a *public* circuit input, so it is bound into the proof. A mempool observer cannot re-point a claim at their own address without producing a proof they cannot make.

Cancel is authorized by a second, independent commitment .. **not** by `ownPublicKey()`. A witness-supplied public key is attacker-controlled input and proves nothing; that anti-pattern appears in the wild and is deliberately avoided here.

## Security notes

The contract was written, then adversarially reviewed, and the review found a real bug that is worth documenting rather than quietly fixing:

> The first witness implementation gave every actor both secret fields and zero-filled the unused one. Because `create_escrow` calls **both** witnesses, a claimant-shaped state used to deposit would publish `refundTicket(0x00..00)` .. a publicly computable constant. Any observer scanning for that constant could cancel the escrow to their own address.

The root cause is structural: **the circuit cannot distinguish a real secret from an unset one.** A commitment to 32 zero bytes is a perfectly valid commitment. The guard has to live at the TypeScript trust boundary, so `SelkiePrivateState` is now a discriminated union .. a claimant state has no `refundSecret` field at all .. and `assertSecret()` rejects all-zero secrets on every path. See [`contract/src/witnesses.ts`](contract/src/witnesses.ts).

Also fixed in review: refund tickets are now bound to their escrow id (so reusing one refund secret across escrows no longer publishes a linkable constant), zero payout/refund addresses are rejected rather than burning funds, and a zero token color is rejected at deployment.

**30/30 tests pass** (`npm test`), covering the happy path, wrong-secret rejection, double-claim rejection, cancel, post-settlement cancel rejection, and each of the issues above.

### Known gap: cancel has no deadline

`newSelkieTicket()` hands the depositor both secrets, and `cancel` has no time lock. A depositor can therefore claim their own escrow, or race a cancel against a payee's in-flight claim. **Selkie gives the payee no settlement guarantee**, which is fine for the release-on-proof pattern it demonstrates and not fine for adversarial counterparties. Closing it needs two things: a claim window (a block-time primitive I have not verified exists at language 0.22) and a payee-bound claim key so the depositor never holds the claim secret. Documented rather than papered over.

## Running it

Requirements: Node.js v22+, a local [Midnight proof server](https://docs.midnight.network/), and a Midnight Preview wallet holding USDM and DUST.

```bash
docker run -d -p 6300:6300 midnightntwrk/proof-server:8.0.3
npm install
cp .env.example .env        # add your Preview mnemonic
```

Get funded: request tNIGHT from the [Preview faucet](https://midnight-tmnight-preview.nethermind.dev/), register it for DUST generation, and bridge USDM over from Cardano Preprod with [`@via-labs-tech/usdm-bridge`](https://www.npmjs.com/package/@via-labs-tech/usdm-bridge) (or the [Tidal](https://github.com/DpacJones/tidal-usdm-transfer) front-end).

```bash
node selkie.mjs balance                       # wallet USDM / NIGHT / DUST
node selkie.mjs deploy                        # your own instance
node selkie.mjs create 2.5                    # lock USDM, print the ticket
node selkie.mjs claim <claimSecret> [addr]    # settle to any address
node selkie.mjs cancel <escrowId> <refundSecret> [addr]
node selkie.mjs status [escrowId]             # ledger state + escrow list
```

To use the already-deployed instance instead of your own, set `SELKIE_CONTRACT_ADDRESS` in `.env` to the address above.

### Rebuilding the circuit

```bash
npm run build:contract   # compact compile +0.30.0 src/selkie.compact managed/selkie
npm test                 # 30 in-process tests
```

Toolchain pin .. compactc 0.30.0, language 0.22, `@midnight-ntwrk/compact-runtime` 0.15.0, ledger-v8 8.0.3, midnight-js 4.0.4, proof server 8.0.3. Keep them together; drift between compiler, language, and runtime is the most common way a Midnight build breaks.

> **Note on project layout:** `contract/` is an npm workspace so the Compact runtime and the on-chain WASM runtime hoist to exactly one copy. Two copies means two WASM class identities and the SDK rejects objects across the boundary with `expected instance of ContractMaintenanceAuthority`.

## Attribution

- Built on **[Midnight](https://midnight.network)** .. Compact contracts, ZK proofs, and the Preview network.
- **USDM** by [Moneta](https://moneta.global), moved between Cardano and Midnight by **[VIA Labs](https://vialabs.io)** cross-chain messaging ([VIA Scan](https://scan.vialabs.tech)).
- The headless wallet and provider wiring in [`src/wallet.mjs`](src/wallet.mjs) follows the proven path in `@via-labs-tech/usdm-bridge` (MIT), including its workarounds for wallet SDK 3.x intent-signing bugs, which are credited in place.

## License

[MIT](LICENSE)
