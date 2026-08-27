/**
 * Headless Midnight wallet + contract providers for Selkie.
 *
 * SPDX-License-Identifier: MIT
 *
 * The wallet-start / provider-wiring shape here follows the proven headless path
 * in @via-labs-tech/usdm-bridge (MIT), including its two workarounds for wallet
 * SDK 3.x bugs around intent signing .. see signTransactionIntents below. Those
 * are not obvious and were expensive to rediscover, so they are kept verbatim in
 * spirit with credit rather than reinvented.
 *
 * Secrets come from .env and never leave this machine. Proving runs on a local
 * proof server; the seed is used only to derive keys and sign.
 */
import 'dotenv/config'

import * as ledger from '@midnight-ntwrk/ledger-v8'
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet'
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade'
import { HDWallet, Roles, validateMnemonic } from '@midnight-ntwrk/wallet-sdk-hd'
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded'
import {
    createKeystore,
    InMemoryTransactionHistoryStorage,
    PublicKey as UnshieldedPublicKey,
    UnshieldedWallet,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet'
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id'
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider'
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider'
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider'
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider'
import { mnemonicToSeedSync } from '@scure/bip39'

import { Buffer } from 'node:buffer'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Rx from 'rxjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = path.resolve(HERE, '..')

/** Compiled circuit assets (keys/, zkir/) produced by `compact compile`. */
export const ARTIFACTS_DIR = path.join(PROJECT_ROOT, 'contract', 'managed', 'selkie')

export const PROOF_SERVER_URL = process.env.PROOF_SERVER_URL ?? 'http://localhost:6300'
export const MIDNIGHT_NETWORK_ID = process.env.MIDNIGHT_NETWORK_ID ?? 'preview'
const NODE_URL = process.env.MIDNIGHT_NODE_URL ?? 'wss://rpc.preview.midnight.network'
const INDEXER_URL =
    process.env.MIDNIGHT_INDEXER_URL ?? 'https://indexer.preview.midnight.network/api/v4/graphql'
const INDEXER_WS_URL =
    process.env.MIDNIGHT_INDEXER_WS_URL ?? 'wss://indexer.preview.midnight.network/api/v4/graphql/ws'
const WALLET_STATE_FILE = process.env.WALLET_STATE_FILE ?? path.join(PROJECT_ROOT, 'wallet-state.json')

/**
 * USDM on Midnight Preview, as minted by the VIA Labs bridge. Selkie escrows
 * this token; the color is written into the contract at deployment and sealed.
 */
export const USDM_TOKEN_COLOR = '003bacd9a361ba0d425e408776020e40271375e8b8de42d73eec046a44947d73'
export const USDM_DECIMALS = 6

export const configuration = {
    networkId: MIDNIGHT_NETWORK_ID,
    costParameters: { additionalFeeOverhead: 300000000000000n, feeBlocksMargin: 5 },
    relayURL: new URL(NODE_URL),
    provingServerUrl: new URL(PROOF_SERVER_URL),
    indexerClientConnection: { indexerHttpUrl: INDEXER_URL, indexerWsUrl: INDEXER_WS_URL },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(),
}
setNetworkId(configuration.networkId)

/** Proving is remote; fail before the (slow) wallet sync rather than after it. */
export async function assertProofServerReachable() {
    try {
        await fetch(PROOF_SERVER_URL, { signal: AbortSignal.timeout(5000) })
    } catch {
        throw new Error(
            `No Midnight proof server reachable at ${PROOF_SERVER_URL}. Start one with:\n` +
                '  docker run -d -p 6300:6300 midnightntwrk/proof-server:8.0.3\n' +
                'or set PROOF_SERVER_URL in .env.',
        )
    }
}

/** Seed from MIDNIGHT_MNEMONIC[_PREVIEW] (BIP39) or MIDNIGHT_SEED (32-byte hex). */
export const getSeed = () => {
    const mnemonic = process.env.MIDNIGHT_MNEMONIC_PREVIEW ?? process.env.MIDNIGHT_MNEMONIC
    if (mnemonic) {
        if (!validateMnemonic(mnemonic)) throw new Error('Invalid MIDNIGHT_MNEMONIC phrase')
        return Buffer.from(mnemonicToSeedSync(mnemonic))
    }
    const seedHex = process.env.MIDNIGHT_SEED_PREVIEW ?? process.env.MIDNIGHT_SEED
    if (!seedHex) throw new Error('Set MIDNIGHT_MNEMONIC_PREVIEW (or MIDNIGHT_SEED) in .env')
    return Buffer.from(seedHex, 'hex')
}

/** Own unshielded address .. pure key derivation, no network access. */
export const deriveMidnightAddress = (seed = getSeed()) => {
    const hd = HDWallet.fromSeed(seed)
    if (hd.type !== 'seedOk') throw new Error('Failed to initialize HDWallet')
    const derived = hd.hdWallet.selectAccount(0).selectRole(Roles.NightExternal).deriveKeyAt(0)
    if (derived.type === 'keyOutOfBounds') throw new Error('Unshielded key out of bounds')
    const pk = UnshieldedPublicKey.fromKeyStore(createKeystore(derived.key, configuration.networkId))
    return { address: pk.address, addressHex: pk.addressHex }
}

export const initWallet = async (seed = getSeed()) => {
    const hd = HDWallet.fromSeed(seed)
    if (hd.type !== 'seedOk') throw new Error('Failed to initialize HDWallet')
    const acct = hd.hdWallet.selectAccount(0)
    const dShielded = acct.selectRole(Roles.Zswap).deriveKeyAt(0)
    const dUnshielded = acct.selectRole(Roles.NightExternal).deriveKeyAt(0)
    const dDust = acct.selectRole(Roles.Dust).deriveKeyAt(0)
    if (
        dShielded.type === 'keyOutOfBounds' ||
        dUnshielded.type === 'keyOutOfBounds' ||
        dDust.type === 'keyOutOfBounds'
    )
        throw new Error('Some key is out of bounds')

    const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(dShielded.key)
    const dustSecretKey = ledger.DustSecretKey.fromSeed(dDust.key)
    const unshieldedKeystore = createKeystore(dUnshielded.key, configuration.networkId)
    const unshieldedPublicKey = UnshieldedPublicKey.fromKeyStore(unshieldedKeystore)

    const saved = loadWalletState()
    const wallet = await WalletFacade.init({
        configuration,
        shielded: (cfg) =>
            saved ? ShieldedWallet(cfg).restore(saved.shielded) : ShieldedWallet(cfg).startWithSecretKeys(shieldedSecretKeys),
        unshielded: (cfg) =>
            saved
                ? UnshieldedWallet(cfg).restore(saved.unshielded)
                : UnshieldedWallet(cfg).startWithPublicKey(unshieldedPublicKey),
        dust: (cfg) =>
            saved
                ? DustWallet(cfg).restore(saved.dust)
                : DustWallet(cfg).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
    })
    await wallet.start(shieldedSecretKeys, dustSecretKey)

    console.log(saved ? 'Restoring Midnight wallet state…' : 'Syncing from genesis (several minutes on first run)…')
    const started = Date.now()
    let applied = 0
    const sub = wallet.state().subscribe((s) => {
        const p = s?.shielded?.state?.progress ?? s?.shielded?.progress
        applied = Number(p?.appliedIndex ?? 0n) || applied
    })
    const render = setInterval(() => {
        process.stderr.write(`\r  syncing… ${applied.toLocaleString()} indexes  ${((Date.now() - started) / 60000).toFixed(1)}min   `)
    }, 2000)
    try {
        await wallet.waitForSyncedState()
    } finally {
        clearInterval(render)
        sub.unsubscribe()
        process.stderr.write(`\r  synced .. ${applied.toLocaleString()} indexes in ${((Date.now() - started) / 60000).toFixed(1)}min\n`)
    }

    const ctx = { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore, unshieldedPublicKey }
    await saveWalletState(wallet)
    return ctx
}

export const configureProviders = async (ctx, artifactsDir = ARTIFACTS_DIR) => {
    const walletAndMidnightProvider = await createWalletAndMidnightProvider(ctx)
    const zkConfigProvider = new NodeZkConfigProvider(artifactsDir)
    return {
        proofProvider: httpClientProofProvider(configuration.provingServerUrl.toString(), zkConfigProvider),
        publicDataProvider: indexerPublicDataProvider(
            configuration.indexerClientConnection.indexerHttpUrl,
            configuration.indexerClientConnection.indexerWsUrl,
        ),
        privateStateProvider: levelPrivateStateProvider({
            midnightDbName: path.join(PROJECT_ROOT, '.selkie-private-state'),
            privateStateStoreName: 'selkie-private-state',
            accountId: 'selkie',
            // Encrypts the local private-state store only .. it is not a wallet
            // secret, but the provider enforces a complexity rule, so the
            // default below satisfies it. Override in .env for a shared machine.
            privateStoragePasswordProvider: () =>
                process.env.SELKIE_PRIVATE_STATE_PASSWORD ?? 'Selkie-Local-Dev-7',
        }),
        zkConfigProvider,
        walletProvider: walletAndMidnightProvider,
        midnightProvider: walletAndMidnightProvider,
    }
}

/**
 * Sign every intent in a transaction.
 *
 * Workaround (from usdm-bridge, MIT): wallet SDK 3.x `signRecipe` hardcodes the
 * 'pre-proof' marker when cloning intents, which fails for already-proven
 * intents whose data carries the 'proof' marker. We clone with the right marker
 * and attach signatures ourselves.
 */
const signTransactionIntents = (tx, signFn, proofMarker) => {
    if (!tx.intents || tx.intents.size === 0) return
    const intents = tx.intents
    for (const segment of intents.keys()) {
        const intent = intents.get(segment)
        if (!intent) continue
        const cloned = ledger.Intent.deserialize('signature', proofMarker, 'pre-binding', intent.serialize())
        const signature = signFn(cloned.signatureData(segment))
        if (cloned.fallibleUnshieldedOffer) {
            const sigs = cloned.fallibleUnshieldedOffer.inputs.map(
                (_, i) => cloned.fallibleUnshieldedOffer.signatures.at(i) ?? signature,
            )
            cloned.fallibleUnshieldedOffer = cloned.fallibleUnshieldedOffer.addSignatures(sigs)
        }
        if (cloned.guaranteedUnshieldedOffer) {
            const sigs = cloned.guaranteedUnshieldedOffer.inputs.map(
                (_, i) => cloned.guaranteedUnshieldedOffer.signatures.at(i) ?? signature,
            )
            cloned.guaranteedUnshieldedOffer = cloned.guaranteedUnshieldedOffer.addSignatures(sigs)
        }
        intents.set(segment, cloned)
    }
    tx.intents = intents
}

export const createWalletAndMidnightProvider = async (ctx) => {
    const state = await Rx.firstValueFrom(ctx.wallet.state().pipe(Rx.filter((s) => s.isSynced)))
    return {
        getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
        getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
        async balanceTx(tx, ttl) {
            const recipe = await ctx.wallet.balanceUnboundTransaction(
                tx,
                { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
                { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
            )
            const signFn = (payload) => ctx.unshieldedKeystore.signData(payload)
            signTransactionIntents(recipe.baseTransaction, signFn, 'proof')
            if (recipe.balancingTransaction) signTransactionIntents(recipe.balancingTransaction, signFn, 'pre-proof')
            return ctx.wallet.finalizeRecipe(recipe)
        },
        submitTx: (tx) => ctx.wallet.submitTransaction(tx),
    }
}

/** Wallet's own unshielded balances, keyed by token color. */
export const walletBalances = async (ctx) => {
    const s = await Rx.firstValueFrom(ctx.wallet.state().pipe(Rx.filter((x) => x.isSynced)))
    const b = s.unshielded?.balances
    const entries = b instanceof Map ? Object.fromEntries(b) : (b ?? {})
    let dust = 0n
    try {
        dust = BigInt(s.dust?.balance?.(new Date()) ?? 0n)
    } catch {
        dust = 0n
    }
    return {
        usdm: BigInt(entries[USDM_TOKEN_COLOR] ?? 0n),
        night: BigInt(entries['00'.repeat(32)] ?? 0n),
        dust,
    }
}

const loadWalletState = () => {
    if (!fs.existsSync(WALLET_STATE_FILE)) return null
    try {
        return JSON.parse(fs.readFileSync(WALLET_STATE_FILE, 'utf8'))
    } catch {
        return null
    }
}

export const saveWalletState = async (wallet) => {
    const [shielded, unshielded, dust] = await Promise.all([
        wallet.shielded.serializeState(),
        wallet.unshielded.serializeState(),
        wallet.dust.serializeState(),
    ])
    fs.writeFileSync(WALLET_STATE_FILE, JSON.stringify({ shielded, unshielded, dust }, null, 2))
}

export const formatUnits = (v, decimals) => {
    const base = 10n ** BigInt(decimals)
    return `${v / base}.${(v % base).toString().padStart(decimals, '0')}`
}

export const parseUsdm = (human) => {
    if (!/^\d+(\.\d{1,6})?$/.test(human)) throw new Error(`Invalid USDM amount: ${human}`)
    const [whole, frac = ''] = human.split('.')
    return BigInt(whole) * 10n ** 6n + BigInt(frac.padEnd(6, '0'))
}
