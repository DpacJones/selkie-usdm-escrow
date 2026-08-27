// =====================================================================
// Selkie circuit tests
//
// SPDX-License-Identifier: MIT
//
// Drives the compiled contract against the in-process compact-runtime
// (0.15.0). This exercises circuit LOGIC .. state transitions, asserts,
// the unshielded token calls, and the disclosure boundary. Proof
// generation is not exercised here; that needs a proof server and is
// covered by the deploy harness.
//
// Run: npm test          (node --test test/selkie.test.ts)
// =====================================================================

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  Contract,
  ledger,
  EscrowStatus,
  type Ledger,
} from '../managed/selkie/contract/index.js';
import {
  createConstructorContext,
  createCircuitContext,
  dummyContractAddress,
} from '@midnight-ntwrk/compact-runtime';

import {
  witnesses,
  claimTicket,
  refundTicket,
  claimantPrivateState,
  depositorPrivateState,
  newSelkieTicket,
  padTag,
  toHex,
  type SelkiePrivateState,
} from '../src/witnesses.ts';

// ---------- fixtures ----------

const COIN_PK = '0'.repeat(64);

/** USDM on Midnight Preview, minted by the VIA Labs bridge. 6 decimals. */
const USDM_COLOR = Uint8Array.from(
  Buffer.from('003bacd9a361ba0d425e408776020e40271375e8b8de42d73eec046a44947d73', 'hex'),
);

/** 25 USDM in base units. */
const AMOUNT = 25_000_000n;

const bytes32 = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

/** A recipient's unshielded UserAddress, as raw bytes. */
const PAYEE = bytes32(0xa1);
const DEPOSITOR_REFUND_ADDR = bytes32(0xd0);

/** The ledger state carried between calls, normalised to a ChargedState. */
type ChargedState = Parameters<typeof ledger>[0];

type Deployed = {
  contract: Contract<SelkiePrivateState>;
  contractState: ChargedState;
  privateState: SelkiePrivateState;
};

const deploy = (privateState: SelkiePrivateState): Deployed => {
  const contract = new Contract<SelkiePrivateState>(witnesses);
  const init = contract.initialState(
    createConstructorContext(privateState, COIN_PK),
    USDM_COLOR,
  );
  return {
    contract,
    contractState: init.currentContractState.data,
    privateState: init.currentPrivateState,
  };
};

/**
 * Build a circuit context. `privateState` is passed per call so a test can
 * switch actors .. the depositor, the payee holding only the claim secret, or
 * an attacker holding neither.
 */
const ctxFor = (d: Deployed, privateState: SelkiePrivateState = d.privateState) =>
  createCircuitContext(dummyContractAddress(), COIN_PK, d.contractState, privateState);

/** Fold a circuit result back into the deployment so the next call sees it. */
const advance = (
  d: Deployed,
  result: { context: { currentQueryContext: { state: ChargedState }; currentPrivateState: SelkiePrivateState } },
): Deployed => ({
  contract: d.contract,
  contractState: result.context.currentQueryContext.state,
  privateState: result.context.currentPrivateState,
});

const ledgerOf = (d: Deployed): Ledger => ledger(d.contractState);

const create = (d: Deployed, amount: bigint = AMOUNT, ps?: SelkiePrivateState) =>
  d.contract.impureCircuits.create_escrow(ctxFor(d, ps), amount);

const claim = (d: Deployed, id: Uint8Array, payout: Uint8Array, ps?: SelkiePrivateState) =>
  d.contract.impureCircuits.claim(ctxFor(d, ps), id, payout);

const cancel = (d: Deployed, id: Uint8Array, refundTo: Uint8Array, ps?: SelkiePrivateState) =>
  d.contract.impureCircuits.cancel(ctxFor(d, ps), id, refundTo);

/** Deposit one escrow and return the advanced deployment plus its id. */
const openEscrow = (secrets: { claim: Uint8Array; refund: Uint8Array }, amount = AMOUNT) => {
  const depositor = depositorPrivateState(secrets.claim, secrets.refund);
  const deployed = deploy(depositor);
  const result = create(deployed, amount);
  return { d: advance(deployed, result), id: result.result, depositor };
};

// =====================================================================
// Off-chain / in-circuit agreement
// =====================================================================

test('off-chain claimTicket matches the id the circuit returns', () => {
  const claimSecret = bytes32(0x11);
  const { id } = openEscrow({ claim: claimSecret, refund: bytes32(0x22) });

  assert.equal(toHex(id), toHex(claimTicket(claimSecret)));
});

test('domain tags are distinct, so the two tickets never collide', () => {
  const secret = bytes32(0x5c);
  const id = claimTicket(secret);

  assert.notEqual(toHex(claimTicket(secret)), toHex(refundTicket(id, secret)));

  // pad(32, tag) is UTF-8, zero-filled to the right .. exactly what the
  // compiler emits. Guarding the byte layout here keeps the off-chain helper
  // from drifting away from the circuit.
  const claimTag = padTag('selkie:claim:v1');
  assert.equal(claimTag.length, 32);
  assert.equal(toHex(claimTag), '73656c6b69653a636c61696d3a7631' + '00'.repeat(17));
  assert.equal(toHex(padTag('selkie:refund:v1')), '73656c6b69653a726566756e643a7631' + '00'.repeat(16));
});

// =====================================================================
// Happy paths
// =====================================================================

test('happy path: create then claim releases the escrow to the payee', () => {
  const claimSecret = bytes32(0x11);
  const { d, id } = openEscrow({ claim: claimSecret, refund: bytes32(0x22) });

  const opened = ledgerOf(d);
  assert.equal(opened.opened_count, 1n);
  assert.equal(opened.settled_count, 0n);
  assert.equal(opened.escrows.size(), 1n);
  assert.equal(opened.escrows.lookup(id).status, EscrowStatus.open);
  assert.equal(opened.escrows.lookup(id).amount, AMOUNT);
  assert.equal(toHex(opened.escrows.lookup(id).settled_to), toHex(new Uint8Array(32)));

  // The payee holds ONLY the claim secret .. no refund secret, no identity.
  const result = claim(d, id, PAYEE, claimantPrivateState(claimSecret));
  const after = ledgerOf(advance(d, result));

  assert.equal(after.escrows.lookup(id).status, EscrowStatus.claimed);
  assert.equal(after.settled_count, 1n);
  assert.equal(toHex(after.escrows.lookup(id).settled_to), toHex(PAYEE));
  // Entry is retained, not deleted .. it is its own nullifier.
  assert.equal(after.escrows.size(), 1n);
});

test('cancel path: depositor reclaims an unclaimed escrow', () => {
  const refundSecret = bytes32(0x22);
  const { d, id, depositor } = openEscrow({ claim: bytes32(0x11), refund: refundSecret });

  const result = cancel(d, id, DEPOSITOR_REFUND_ADDR, depositor);
  const after = ledgerOf(advance(d, result));

  assert.equal(after.escrows.lookup(id).status, EscrowStatus.cancelled);
  assert.equal(after.settled_count, 1n);
  assert.equal(toHex(after.escrows.lookup(id).settled_to), toHex(DEPOSITOR_REFUND_ADDR));
});

test('claimant may direct the payout anywhere .. the address is bound into the call', () => {
  const claimSecret = bytes32(0x33);
  const elsewhere = bytes32(0xee);
  const { d, id } = openEscrow({ claim: claimSecret, refund: bytes32(0x44) });

  const result = claim(d, id, elsewhere, claimantPrivateState(claimSecret));

  assert.equal(toHex(ledgerOf(advance(d, result)).escrows.lookup(id).settled_to), toHex(elsewhere));
});

test('two independent escrows settle independently', () => {
  const a = bytes32(0x01);
  const b = bytes32(0x02);

  const first = openEscrow({ claim: a, refund: bytes32(0x0a) }, 1_000_000n);
  // Second deposit on the same contract, by a different depositor.
  const second = create(first.d, 2_000_000n, depositorPrivateState(b, bytes32(0x0b)));
  const d = advance(first.d, second);

  const l = ledgerOf(d);
  assert.equal(l.opened_count, 2n);
  assert.equal(l.escrows.size(), 2n);
  assert.equal(l.escrows.lookup(first.id).amount, 1_000_000n);
  assert.equal(l.escrows.lookup(second.result).amount, 2_000_000n);
  assert.notEqual(toHex(first.id), toHex(second.result));
});

// =====================================================================
// Rejections
// =====================================================================

test('wrong secret is rejected .. holding the id is not enough', () => {
  const { d, id } = openEscrow({ claim: bytes32(0x11), refund: bytes32(0x22) });

  // Attacker sees the escrow id on-chain but guesses the secret.
  assert.throws(
    () => claim(d, id, PAYEE, claimantPrivateState(bytes32(0xff))),
    /invalid claim secret/i,
  );
});

test('double claim is rejected .. the map entry acts as the nullifier', () => {
  const claimSecret = bytes32(0x11);
  const { d, id } = openEscrow({ claim: claimSecret, refund: bytes32(0x22) });
  const ps = claimantPrivateState(claimSecret);

  const first = claim(d, id, PAYEE, ps);
  const settled = advance(d, first);

  assert.throws(() => claim(settled, id, PAYEE, ps), /escrow is not open/i);
});

test('cancel after claim is rejected .. the depositor cannot claw back', () => {
  const claimSecret = bytes32(0x11);
  const refundSecret = bytes32(0x22);
  const { d, id, depositor } = openEscrow({ claim: claimSecret, refund: refundSecret });

  const claimed = advance(d, claim(d, id, PAYEE, claimantPrivateState(claimSecret)));

  assert.throws(() => cancel(claimed, id, DEPOSITOR_REFUND_ADDR, depositor), /escrow is not open/i);
});

test('claim after cancel is rejected', () => {
  const claimSecret = bytes32(0x11);
  const { d, id, depositor } = openEscrow({ claim: claimSecret, refund: bytes32(0x22) });

  const cancelled = advance(d, cancel(d, id, DEPOSITOR_REFUND_ADDR, depositor));

  assert.throws(
    () => claim(cancelled, id, PAYEE, claimantPrivateState(claimSecret)),
    /escrow is not open/i,
  );
});

test('double cancel is rejected', () => {
  const refundSecret = bytes32(0x22);
  const { d, id, depositor } = openEscrow({ claim: bytes32(0x11), refund: refundSecret });

  const cancelled = advance(d, cancel(d, id, DEPOSITOR_REFUND_ADDR, depositor));

  assert.throws(() => cancel(cancelled, id, DEPOSITOR_REFUND_ADDR, depositor), /escrow is not open/i);
});

test('wrong refund secret cannot cancel', () => {
  const { d, id } = openEscrow({ claim: bytes32(0x11), refund: bytes32(0x22) });

  assert.throws(
    () => cancel(d, id, DEPOSITOR_REFUND_ADDR, depositorPrivateState(bytes32(0x11), bytes32(0xff))),
    /invalid refund secret/i,
  );
});

test('domain separation: the claim secret cannot be replayed as a refund secret', () => {
  const claimSecret = bytes32(0x11);
  const { d, id } = openEscrow({ claim: claimSecret, refund: bytes32(0x22) });

  // Attacker knows the claim secret and tries to cancel with it instead.
  assert.throws(
    () => cancel(d, id, DEPOSITOR_REFUND_ADDR, depositorPrivateState(claimSecret, claimSecret)),
    /invalid refund secret/i,
  );
});

test('domain separation: the refund secret cannot be replayed as a claim secret', () => {
  const refundSecret = bytes32(0x22);
  const { d, id } = openEscrow({ claim: bytes32(0x11), refund: refundSecret });

  assert.throws(
    () => claim(d, id, PAYEE, claimantPrivateState(refundSecret)),
    /invalid claim secret/i,
  );
});

test('claiming an unknown escrow is rejected', () => {
  const { d } = openEscrow({ claim: bytes32(0x11), refund: bytes32(0x22) });

  assert.throws(
    () => claim(d, bytes32(0x7f), PAYEE, claimantPrivateState(bytes32(0x11))),
    /unknown escrow/i,
  );
});

test('zero-amount escrows are rejected', () => {
  const deployed = deploy(depositorPrivateState(bytes32(0x11), bytes32(0x22)));

  assert.throws(() => create(deployed, 0n), /amount must be positive/i);
});

test('reusing a claim secret for a second escrow is rejected', () => {
  const claimSecret = bytes32(0x11);
  const { d } = openEscrow({ claim: claimSecret, refund: bytes32(0x22) });

  assert.throws(
    () => create(d, AMOUNT, depositorPrivateState(claimSecret, bytes32(0x99))),
    /already used/i,
  );
});

test('a settled escrow id can never be reused', () => {
  const claimSecret = bytes32(0x11);
  const { d, id } = openEscrow({ claim: claimSecret, refund: bytes32(0x22) });
  const settled = advance(d, claim(d, id, PAYEE, claimantPrivateState(claimSecret)));

  assert.throws(
    () => create(settled, AMOUNT, depositorPrivateState(claimSecret, bytes32(0x99))),
    /already used/i,
  );
});

// =====================================================================
// Trust-boundary regressions
//
// These cover a Critical found in security review: the witness layer used to
// accept an all-zero secret, and the private-state shape handed every actor a
// zeroed `refundSecret`. A claimant-shaped state used to deposit therefore
// published refundTicket(0x00..00) .. a publicly computable constant .. and any
// observer could cancel the escrow and take the funds.
// =====================================================================

test('an all-zero claim secret is refused at the witness boundary', () => {
  assert.throws(() => claimantPrivateState(new Uint8Array(32)), /all zeros/i);
  assert.throws(
    () => depositorPrivateState(new Uint8Array(32), bytes32(0x22)),
    /all zeros/i,
  );
});

test('an all-zero refund secret is refused at the witness boundary', () => {
  assert.throws(
    () => depositorPrivateState(bytes32(0x11), new Uint8Array(32)),
    /all zeros/i,
  );
});

test('a claimant-shaped private state cannot create an escrow', () => {
  // The claimant holds no refund secret. create_escrow calls BOTH witnesses, so
  // this must fail loudly rather than silently minting a zero refund ticket.
  const deployed = deploy(depositorPrivateState(bytes32(0x11), bytes32(0x22)));

  assert.throws(
    () => create(deployed, AMOUNT, claimantPrivateState(bytes32(0x33))),
    /no refund secret/i,
  );
});

test('the zero-secret refund ticket is never reachable as on-chain state', () => {
  const { d, id } = openEscrow({ claim: bytes32(0x11), refund: bytes32(0x22) });
  const stored = ledgerOf(d).escrows.lookup(id).refund_commitment;

  // The constant an attacker would scan the ledger for.
  assert.throws(() => refundTicket(id, new Uint8Array(32)), /all zeros/i);
  assert.equal(toHex(stored), toHex(refundTicket(id, bytes32(0x22))));
});

test('refund tickets are bound to their escrow, so a reused refund secret does not repeat', () => {
  const sharedRefund = bytes32(0x77);
  const first = openEscrow({ claim: bytes32(0x01), refund: sharedRefund });
  const second = create(first.d, AMOUNT, depositorPrivateState(bytes32(0x02), sharedRefund));
  const d = advance(first.d, second);

  const a = ledgerOf(d).escrows.lookup(first.id).refund_commitment;
  const b = ledgerOf(d).escrows.lookup(second.result).refund_commitment;

  // Same secret, different escrows .. must NOT publish the same constant.
  assert.notEqual(toHex(a), toHex(b));
});

test("a refund secret cannot cancel a different escrow", () => {
  const sharedRefund = bytes32(0x77);
  const first = openEscrow({ claim: bytes32(0x01), refund: sharedRefund });
  const second = create(first.d, AMOUNT, depositorPrivateState(bytes32(0x02), sharedRefund));
  const d = advance(first.d, second);

  // Cancelling escrow #2 with a ticket bound to #1 must fail, even though the
  // underlying refund secret is identical.
  const cancelled = advance(d, cancel(d, first.id, DEPOSITOR_REFUND_ADDR, depositorPrivateState(bytes32(0x01), sharedRefund)));
  assert.equal(ledgerOf(cancelled).escrows.lookup(first.id).status, EscrowStatus.cancelled);
  // #2 is untouched and still open.
  assert.equal(ledgerOf(cancelled).escrows.lookup(second.result).status, EscrowStatus.open);
});

test('a zero payout address is rejected rather than burning the escrow', () => {
  const claimSecret = bytes32(0x11);
  const { d, id } = openEscrow({ claim: claimSecret, refund: bytes32(0x22) });

  assert.throws(
    () => claim(d, id, new Uint8Array(32), claimantPrivateState(claimSecret)),
    /payout address must be non-zero/i,
  );
  // Still claimable afterwards .. the failed attempt did not settle it.
  const ok = advance(d, claim(d, id, PAYEE, claimantPrivateState(claimSecret)));
  assert.equal(ledgerOf(ok).escrows.lookup(id).status, EscrowStatus.claimed);
});

test('a zero refund address is rejected', () => {
  const { d, id, depositor } = openEscrow({ claim: bytes32(0x11), refund: bytes32(0x22) });

  assert.throws(
    () => cancel(d, id, new Uint8Array(32), depositor),
    /refund address must be non-zero/i,
  );
});

test('deploying with a zero token color is rejected', () => {
  const contract = new Contract<SelkiePrivateState>(witnesses);

  assert.throws(
    () =>
      contract.initialState(
        createConstructorContext(depositorPrivateState(bytes32(0x11), bytes32(0x22)), COIN_PK),
        new Uint8Array(32),
      ),
    /token color must be non-zero/i,
  );
});

// =====================================================================
// Deployment invariants
// =====================================================================

test('token_color is sealed at deployment', () => {
  const d = deploy(depositorPrivateState(bytes32(0x11), bytes32(0x22)));

  assert.equal(toHex(ledgerOf(d).token_color), toHex(USDM_COLOR));
});

test('newSelkieTicket produces distinct, high-entropy secrets', () => {
  const a = newSelkieTicket();
  const b = newSelkieTicket();

  assert.equal(a.claimSecret.length, 32);
  assert.notEqual(toHex(a.claimSecret), toHex(a.refundSecret));
  assert.notEqual(toHex(a.claimSecret), toHex(b.claimSecret));
  assert.equal(toHex(a.escrowId), toHex(claimTicket(a.claimSecret)));
});

test('a randomly generated ticket drives a full create + claim cycle', () => {
  const ticket = newSelkieTicket();
  const { d, id } = openEscrow({ claim: ticket.claimSecret, refund: ticket.refundSecret });

  assert.equal(toHex(id), toHex(ticket.escrowId));

  const result = claim(d, id, PAYEE, claimantPrivateState(ticket.claimSecret));

  assert.equal(ledgerOf(advance(d, result)).escrows.lookup(id).status, EscrowStatus.claimed);
});
