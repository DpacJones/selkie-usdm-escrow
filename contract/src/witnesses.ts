// Selkie witness implementations and off-chain ticket helpers.
//
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Dennis Zarelli (Atlantis)
//
// The two witnesses hand the circuit the secrets that authorize claim and
// cancel. They run entirely on the prover's machine; nothing they return is
// ever placed in a transaction. The circuit only ever publishes
// persistentCommit(<domain tag>, secret), which is hiding.

import {
  CompactTypeBytes,
  CompactTypeVector,
  persistentCommit,
  type WitnessContext,
} from '@midnight-ntwrk/compact-runtime';

import type { Ledger } from '../managed/selkie/contract/index.js';

// ---------------------------------------------------------------------------
// Private state
// ---------------------------------------------------------------------------

/**
 * Everything Selkie keeps off-chain.
 *
 * This is a discriminated union on purpose. An earlier shape gave every actor
 * both fields and filled the unused one with zeros, which was a critical bug:
 * `create_escrow` calls BOTH witnesses, so a claimant-shaped state used to
 * deposit would publish `refundTicket(0x00..00)` .. a publicly computable
 * constant that lets any observer cancel the escrow and take the funds. The
 * union makes that state unrepresentable rather than merely discouraged.
 */
export type SelkiePrivateState =
  | {
      readonly role: 'depositor';
      readonly claimSecret: Uint8Array;
      readonly refundSecret: Uint8Array;
    }
  | {
      readonly role: 'claimant';
      readonly claimSecret: Uint8Array;
    };

/** Private state for the party who can only claim. Cannot create an escrow. */
export const claimantPrivateState = (claimSecret: Uint8Array): SelkiePrivateState => ({
  role: 'claimant',
  claimSecret: assertSecret(claimSecret, 'claimSecret'),
});

/** Private state for the depositor, who can create and cancel. */
export const depositorPrivateState = (
  claimSecret: Uint8Array,
  refundSecret: Uint8Array,
): SelkiePrivateState => ({
  role: 'depositor',
  claimSecret: assertSecret(claimSecret, 'claimSecret'),
  refundSecret: assertSecret(refundSecret, 'refundSecret'),
});

// ---------------------------------------------------------------------------
// Witnesses .. must match the Witnesses<PS> type in the generated index.d.ts
//
// These are the trust boundary. The circuit cannot tell a real secret from an
// unset one .. the commitment of 32 zero bytes is just as valid a commitment as
// any other .. so the guard has to live here.
// ---------------------------------------------------------------------------

export const witnesses = {
  selkie_claim_secret: ({
    privateState,
  }: WitnessContext<Ledger, SelkiePrivateState>): [SelkiePrivateState, Uint8Array] => [
    privateState,
    assertSecret(privateState.claimSecret, 'claimSecret'),
  ],

  selkie_refund_secret: ({
    privateState,
  }: WitnessContext<Ledger, SelkiePrivateState>): [SelkiePrivateState, Uint8Array] => {
    if (privateState.role !== 'depositor') {
      throw new Error(
        'selkie: this private state holds no refund secret. Only a depositor ' +
          'state can create or cancel an escrow .. refusing to build a ' +
          'publicly-derivable refund ticket.',
      );
    }
    return [privateState, assertSecret(privateState.refundSecret, 'refundSecret')];
  },
};

// ---------------------------------------------------------------------------
// Off-chain ticket maths
//
// These reproduce the in-circuit commitments byte for byte by calling the same
// runtime primitive the compiled circuit calls. That matters: the depositor
// needs the escrow id before the transaction confirms so they can hand the
// claim ticket to the counterparty, and any drift between this framing and the
// circuit's would silently produce unclaimable escrows.
// ---------------------------------------------------------------------------

const BYTES_32 = new CompactTypeBytes(32);
/** The `Vector<2, Bytes<32>>` frame the refund ticket commits to. */
const REFUND_FRAME = new CompactTypeVector(2, BYTES_32);

/** `pad(32, tag)` as the Compact compiler emits it: UTF-8, zero-filled right. */
export const padTag = (tag: string): Uint8Array => {
  const encoded = new TextEncoder().encode(tag);
  if (encoded.length > 32) {
    throw new Error(`selkie: domain tag "${tag}" exceeds 32 bytes`);
  }
  const out = new Uint8Array(32);
  out.set(encoded);
  return out;
};

export const CLAIM_TAG = padTag('selkie:claim:v1');
export const REFUND_TAG = padTag('selkie:refund:v1');

/**
 * The escrow id. Mirrors the `claim_ticket` circuit:
 * `persistentCommit<Bytes<32>>(pad(32, "selkie:claim:v1"), secret)`.
 */
export const claimTicket = (claimSecret: Uint8Array): Uint8Array =>
  persistentCommit(BYTES_32, CLAIM_TAG, assertSecret(claimSecret, 'claimSecret'));

/**
 * Mirrors the `refund_ticket` circuit:
 * `persistentCommit<Vector<2, Bytes<32>>>([pad(32, "selkie:refund:v1"), id], secret)`.
 *
 * The escrow id is bound in, so reusing one refund secret across escrows yields
 * distinct on-chain values instead of a shared, linkable constant.
 */
export const refundTicket = (escrowId: Uint8Array, refundSecret: Uint8Array): Uint8Array =>
  persistentCommit(
    REFUND_FRAME,
    [REFUND_TAG, assert32(escrowId, 'escrowId')],
    assertSecret(refundSecret, 'refundSecret'),
  );

// ---------------------------------------------------------------------------
// Ticket generation
// ---------------------------------------------------------------------------

export type SelkieTicket = {
  /** Share this with the payee. Whoever holds it can claim the escrow. */
  readonly claimSecret: Uint8Array;
  /** Depositor keeps this. It is the only way to cancel. */
  readonly refundSecret: Uint8Array;
  /** Public escrow id, derivable from claimSecret alone. */
  readonly escrowId: Uint8Array;
};

/**
 * Mint a fresh escrow ticket from the platform CSPRNG. Works in Node and in the
 * browser; both expose `globalThis.crypto.getRandomValues`.
 *
 * Entropy is load-bearing. The escrow id is a commitment whose only hiding
 * input is the secret, so a low-entropy secret is brute-forceable and the
 * escrow is effectively unlocked. Always generate, never let a user choose.
 */
export const newSelkieTicket = (): SelkieTicket => {
  const claimSecret = randomBytes32();
  const refundSecret = randomBytes32();
  return {
    claimSecret,
    refundSecret,
    escrowId: claimTicket(claimSecret),
  };
};

const randomBytes32 = (): Uint8Array => {
  const out = new Uint8Array(32);
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('selkie: no CSPRNG available (globalThis.crypto.getRandomValues)');
  }
  globalThis.crypto.getRandomValues(out);
  return out;
};

// ---------------------------------------------------------------------------

export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export const fromHex = (hex: string): Uint8Array => {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error('selkie: hex string has an odd length');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

function assert32(value: Uint8Array, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new Error(`selkie: ${name} must be exactly 32 bytes`);
  }
  return value;
}

/**
 * A secret must be 32 bytes AND not all zero.
 *
 * The all-zero check is load-bearing, not hygiene. Both tickets are commitments
 * whose only non-constant input is the secret, so their hiding property rests
 * entirely on the secret's entropy. An unset (all-zero) secret produces a fixed,
 * publicly computable ticket, which converts the escrow into a bearer
 * instrument anyone reading the ledger can settle.
 */
function assertSecret(value: Uint8Array, name: string): Uint8Array {
  assert32(value, name);
  if (value.every((byte) => byte === 0)) {
    throw new Error(
      `selkie: ${name} is all zeros .. refusing to build a publicly-derivable ` +
        'ticket. Generate secrets with newSelkieTicket().',
    );
  }
  return value;
}
