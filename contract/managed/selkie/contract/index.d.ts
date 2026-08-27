import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export enum EscrowStatus { nonexistent = 0, open = 1, claimed = 2, cancelled = 3
}

export type Escrow = { amount: bigint;
                       refund_commitment: Uint8Array;
                       status: EscrowStatus;
                       settled_to: Uint8Array
                     };

export type Witnesses<PS> = {
  selkie_claim_secret(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
  selkie_refund_secret(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
}

export type ImpureCircuits<PS> = {
  create_escrow(context: __compactRuntime.CircuitContext<PS>, amount_0: bigint): __compactRuntime.CircuitResults<PS, Uint8Array>;
  claim(context: __compactRuntime.CircuitContext<PS>,
        escrow_id_0: Uint8Array,
        payout_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  cancel(context: __compactRuntime.CircuitContext<PS>,
         escrow_id_0: Uint8Array,
         refund_to_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
}

export type ProvableCircuits<PS> = {
  create_escrow(context: __compactRuntime.CircuitContext<PS>, amount_0: bigint): __compactRuntime.CircuitResults<PS, Uint8Array>;
  claim(context: __compactRuntime.CircuitContext<PS>,
        escrow_id_0: Uint8Array,
        payout_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  cancel(context: __compactRuntime.CircuitContext<PS>,
         escrow_id_0: Uint8Array,
         refund_to_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  create_escrow(context: __compactRuntime.CircuitContext<PS>, amount_0: bigint): __compactRuntime.CircuitResults<PS, Uint8Array>;
  claim(context: __compactRuntime.CircuitContext<PS>,
        escrow_id_0: Uint8Array,
        payout_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  cancel(context: __compactRuntime.CircuitContext<PS>,
         escrow_id_0: Uint8Array,
         refund_to_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
}

export type Ledger = {
  readonly token_color: Uint8Array;
  escrows: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Escrow;
    [Symbol.iterator](): Iterator<[Uint8Array, Escrow]>
  };
  readonly opened_count: bigint;
  readonly settled_count: bigint;
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>,
               usdm_color_0: Uint8Array): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
