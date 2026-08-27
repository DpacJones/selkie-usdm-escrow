#!/usr/bin/env node
/**
 * Selkie CLI .. deploy and drive the private USDM escrow contract on Midnight.
 *
 * SPDX-License-Identifier: MIT
 *
 *   node selkie.mjs deploy
 *   node selkie.mjs create <amount>              # lock USDM, print the ticket
 *   node selkie.mjs claim  <claimSecret> [payoutAddress]
 *   node selkie.mjs cancel <escrowId> <refundSecret> [refundAddress]
 *   node selkie.mjs status [escrowId]
 *   node selkie.mjs balance
 *
 * USDM custody is at the CONTRACT layer: create_escrow calls receiveUnshielded
 * and claim/cancel call sendUnshielded, so the tokens sit in contract state
 * between the two. Nothing here moves USDM by itself .. this CLI only builds,
 * proves, and submits circuit calls.
 */
import 'dotenv/config'

import { deployContract, findDeployedContract, getUnshieldedBalances } from '@midnight-ntwrk/midnight-js-contracts'
import { CompiledContract } from '@midnight-ntwrk/compact-js'
import { MidnightBech32m, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format'

import * as fs from 'node:fs'
import * as path from 'node:path'

import {
    ARTIFACTS_DIR,
    PROJECT_ROOT,
    USDM_TOKEN_COLOR,
    USDM_DECIMALS,
    assertProofServerReachable,
    configureProviders,
    configuration,
    deriveMidnightAddress,
    formatUnits,
    initWallet,
    parseUsdm,
    saveWalletState,
    walletBalances,
} from './src/wallet.mjs'

import { Contract, ledger as readLedger } from './contract/managed/selkie/contract/index.js'
import {
    claimTicket,
    claimantPrivateState,
    depositorPrivateState,
    fromHex,
    newSelkieTicket,
    toHex,
    witnesses,
} from './contract/src/witnesses.ts'

const PRIVATE_STATE_ID = 'selkie'
const DEPLOY_FILE = path.join(PROJECT_ROOT, 'deploy.json')

/* ------------------------------------------------------------------ setup -- */

/** A contract handle wired to the given private state (role decides witnesses). */
async function connect(privateState, { deploy = false } = {}) {
    await assertProofServerReachable()
    const ctx = await initWallet()
    const providers = await configureProviders(ctx)
    // make() takes the generated Contract CLASS; the witness implementations
    // are attached as a separate layer.
    const cc = CompiledContract.make('selkie', Contract).pipe(
        CompiledContract.withWitnesses(witnesses),
        CompiledContract.withCompiledFileAssets(ARTIFACTS_DIR),
    )

    if (deploy) {
        const deployed = await deployContract(providers, {
            compiledContract: cc,
            privateStateId: PRIVATE_STATE_ID,
            initialPrivateState: privateState,
            args: [fromHex(USDM_TOKEN_COLOR)],
        })
        return { ctx, providers, contract: deployed }
    }

    const contractAddress = contractAddressOrDie()
    const found = await findDeployedContract(providers, {
        compiledContract: cc,
        contractAddress,
        privateStateId: PRIVATE_STATE_ID,
        initialPrivateState: privateState,
    })
    return { ctx, providers, contract: found, contractAddress }
}

function contractAddressOrDie() {
    const fromEnv = process.env.SELKIE_CONTRACT_ADDRESS
    if (fromEnv) return fromEnv
    if (fs.existsSync(DEPLOY_FILE)) {
        const d = JSON.parse(fs.readFileSync(DEPLOY_FILE, 'utf8'))
        if (d.contractAddress) return d.contractAddress
    }
    throw new Error('No contract address. Run `node selkie.mjs deploy`, or set SELKIE_CONTRACT_ADDRESS in .env.')
}

/** Accept a bech32m mn_addr… or a raw 64-char hex address; return 32 raw bytes. */
function addressToBytes(addr) {
    const clean = addr.trim()
    if (/^(0x)?[0-9a-fA-F]{64}$/.test(clean)) return fromHex(clean)
    const parsed = UnshieldedAddress.codec.decode(configuration.networkId, MidnightBech32m.parse(clean))
    return new Uint8Array(parsed.data)
}

const usdm = (v) => `${formatUnits(v, USDM_DECIMALS)} USDM`

/**
 * USDM the indexer reports as held by `address`, or null when it has nothing
 * for that contract yet. The shape has moved between SDK versions (Map, plain
 * object, and an array of {tokenType, amount}), so all three are accepted.
 */
async function indexedUsdm(publicDataProvider, address) {
    try {
        const raw = await getUnshieldedBalances(publicDataProvider, address)
        if (!raw) return null
        if (Array.isArray(raw)) {
            if (raw.length === 0) return null
            const hit = raw.find((e) => (e?.tokenType ?? e?.type ?? e?.color ?? '').toString().replace(/^0x/, '') === USDM_TOKEN_COLOR)
            return hit ? BigInt(hit.amount ?? hit.value ?? 0n) : 0n
        }
        const obj = raw instanceof Map ? Object.fromEntries(raw) : raw
        const keys = Object.keys(obj)
        if (keys.length === 0) return null
        return BigInt(obj[USDM_TOKEN_COLOR] ?? obj[`0x${USDM_TOKEN_COLOR}`] ?? 0n)
    } catch {
        return null
    }
}

async function finish(ctx, code = 0) {
    try {
        await saveWalletState(ctx.wallet)
        await ctx.wallet.stop()
    } catch {}
    process.exit(code)
}

/* --------------------------------------------------------------- commands -- */

async function cmdDeploy() {
    // Deployment runs the constructor only; it takes no secrets, but the
    // provider still needs a well-formed private state, so use a throwaway
    // depositor ticket that is never used to fund anything.
    const seedTicket = newSelkieTicket()
    const { ctx, contract } = await connect(
        depositorPrivateState(seedTicket.claimSecret, seedTicket.refundSecret),
        { deploy: true },
    )
    const address = contract.deployTxData.public.contractAddress
    const txId = contract.deployTxData.public.txId ?? contract.deployTxData.public.txHash

    fs.writeFileSync(
        DEPLOY_FILE,
        JSON.stringify({ network: 'preview', contractAddress: address, deployTx: txId, usdmTokenColor: USDM_TOKEN_COLOR }, null, 2),
    )

    console.log('\nSelkie deployed to Midnight Preview')
    console.log(`  contract address: ${address}`)
    console.log(`  deploy tx:        ${txId}`)
    console.log(`  escrowed token:   USDM (${USDM_TOKEN_COLOR.slice(0, 12)}…)`)
    console.log(`\nSaved to ${path.relative(PROJECT_ROOT, DEPLOY_FILE)}`)
    await finish(ctx)
}

async function cmdCreate(amountHuman) {
    if (!amountHuman) throw new Error('usage: node selkie.mjs create <amount>')
    const amount = parseUsdm(amountHuman)
    const ticket = newSelkieTicket()

    const { ctx, contract } = await connect(depositorPrivateState(ticket.claimSecret, ticket.refundSecret))

    const before = await walletBalances(ctx)
    if (before.usdm < amount) {
        console.error(`Not enough USDM: wallet holds ${usdm(before.usdm)}, need ${usdm(amount)}.`)
        console.error('Bridge some over from Cardano first (see the Tidal front-end or usdm-bridge CLI).')
        await finish(ctx, 1)
    }

    console.log(`Locking ${usdm(amount)} .. proving create_escrow (this takes a minute)…`)
    const result = await contract.callTx.create_escrow(amount)
    const escrowId = toHex(result.private.result)

    console.log('\nEscrow created')
    console.log(`  escrow id:     ${escrowId}`)
    console.log(`  amount:        ${usdm(amount)}`)
    console.log(`  tx:            ${result.public.txId ?? result.public.txHash}`)
    console.log('\n  GIVE THE PAYEE THIS (whoever holds it can claim the funds):')
    console.log(`    claim secret: ${toHex(ticket.claimSecret)}`)
    console.log('\n  KEEP THIS PRIVATE (your only way to cancel):')
    console.log(`    refund secret: ${toHex(ticket.refundSecret)}`)
    await finish(ctx)
}

async function cmdClaim(claimSecretHex, payoutAddr) {
    if (!claimSecretHex) throw new Error('usage: node selkie.mjs claim <claimSecret> [payoutAddress]')
    const claimSecret = fromHex(claimSecretHex)

    // The claimant needs no refund secret .. and must not have one, or a
    // deposit made with this state would publish a derivable refund ticket.
    const { ctx, contract } = await connect(claimantPrivateState(claimSecret))

    const to = payoutAddr ? addressToBytes(payoutAddr) : fromHex(deriveMidnightAddress().addressHex)
    // The escrow id IS the claim ticket, so the claimant derives it locally
    // from the secret .. no lookup, and nothing extra to be told.
    const escrowIdBytes = claimTicket(claimSecret)
    const escrowId = toHex(escrowIdBytes)

    console.log(`Claiming escrow ${escrowId.slice(0, 16)}… .. proving claim…`)
    const result = await contract.callTx.claim(escrowIdBytes, to)

    console.log('\nClaimed')
    console.log(`  escrow id: ${escrowId}`)
    console.log(`  paid to:   ${payoutAddr ?? deriveMidnightAddress().address}`)
    console.log(`  tx:        ${result.public.txId ?? result.public.txHash}`)
    await finish(ctx)
}

async function cmdCancel(escrowIdHex, refundSecretHex, refundAddr) {
    if (!escrowIdHex || !refundSecretHex)
        throw new Error('usage: node selkie.mjs cancel <escrowId> <refundSecret> [refundAddress]')
    const escrowId = fromHex(escrowIdHex)
    const refundSecret = fromHex(refundSecretHex)

    // cancel only needs the refund secret, but the private state type pairs
    // them; the claim secret is unused by the cancel circuit.
    const { ctx, contract } = await connect(depositorPrivateState(refundSecret, refundSecret))

    const to = refundAddr ? addressToBytes(refundAddr) : fromHex(deriveMidnightAddress().addressHex)
    console.log(`Cancelling escrow ${escrowIdHex.slice(0, 16)}… .. proving cancel…`)
    const result = await contract.callTx.cancel(escrowId, to)

    console.log('\nCancelled .. funds returned')
    console.log(`  tx: ${result.public.txId ?? result.public.txHash}`)
    await finish(ctx)
}

async function cmdStatus(escrowIdHex) {
    await assertProofServerReachable()
    const ctx = await initWallet()
    const providers = await configureProviders(ctx)
    const address = contractAddressOrDie()

    const state = await providers.publicDataProvider.queryContractState(address)
    if (!state) {
        console.error(`No contract found at ${address}`)
        await finish(ctx, 1)
    }
    const l = readLedger(state.data)
    const STATUS = ['nonexistent', 'open', 'claimed', 'cancelled']

    // Authoritative: sum the escrows the contract still owes. The indexer's
    // unshielded-balance view for contracts is reported alongside when it has
    // caught up, but it lags (and returns [] until then), so it is not the
    // source of truth here.
    let owed = 0n
    for (const [, e] of l.escrows) if (e.status === 1) owed += e.amount
    const indexed = await indexedUsdm(providers.publicDataProvider, address)

    console.log(`\nSelkie @ ${address}`)
    console.log(`  escrowed token:   USDM (${toHex(l.token_color).slice(0, 12)}…)`)
    console.log(`  held (per ledger): ${usdm(owed)}`)
    if (indexed !== null) console.log(`  held (per indexer): ${usdm(indexed)}`)
    console.log(`  opened: ${l.opened_count}   settled: ${l.settled_count}   live entries: ${l.escrows.size()}`)
    if (escrowIdHex) {
        const id = fromHex(escrowIdHex)
        if (!l.escrows.member(id)) {
            console.log(`\n  ${escrowIdHex}: not found`)
        } else {
            const e = l.escrows.lookup(id)
            console.log(`\n  ${escrowIdHex}`)
            console.log(`    amount:     ${usdm(e.amount)}`)
            console.log(`    status:     ${STATUS[e.status] ?? e.status}`)
            if (e.status !== 1) console.log(`    settled to: ${toHex(e.settled_to)}`)
        }
    } else {
        console.log('\n  escrows:')
        for (const [id, e] of l.escrows) {
            console.log(`    ${toHex(id).slice(0, 24)}…  ${usdm(e.amount).padEnd(18)} ${STATUS[e.status] ?? e.status}`)
        }
    }
    await finish(ctx)
}

async function cmdBalance() {
    const ctx = await initWallet()
    const b = await walletBalances(ctx)
    const { address } = deriveMidnightAddress()
    console.log(`\nMidnight Preview wallet`)
    console.log(`  address: ${address}`)
    console.log(`  USDM:    ${formatUnits(b.usdm, USDM_DECIMALS)}`)
    console.log(`  NIGHT:   ${formatUnits(b.night, 6)}`)
    console.log(`  DUST:    ${formatUnits(b.dust, 15)}`)
    await finish(ctx)
}

/* ------------------------------------------------------------------- main -- */

const [cmd, ...args] = process.argv.slice(2)
const commands = {
    deploy: () => cmdDeploy(),
    create: () => cmdCreate(args[0]),
    claim: () => cmdClaim(args[0], args[1]),
    cancel: () => cmdCancel(args[0], args[1], args[2]),
    status: () => cmdStatus(args[0]),
    balance: () => cmdBalance(),
}

if (!cmd || !commands[cmd]) {
    console.log(`Selkie .. private USDM escrow on Midnight

  node selkie.mjs deploy
  node selkie.mjs create <amount>
  node selkie.mjs claim  <claimSecret> [payoutAddress]
  node selkie.mjs cancel <escrowId> <refundSecret> [refundAddress]
  node selkie.mjs status [escrowId]
  node selkie.mjs balance
`)
    process.exit(cmd ? 1 : 0)
}

commands[cmd]().catch((e) => {
    console.error(`\nselkie: ${e?.message ?? e}`)
    process.exit(1)
})
