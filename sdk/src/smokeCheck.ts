/**
 * Post-deployment smoke checks for critical contract entrypoints (Issue #511).
 *
 * After deploying or upgrading any of the seven contracts in this crate, an
 * operator should verify that the new code responds correctly on its critical
 * read-only entrypoints before directing traffic or running migrations. This
 * module provides that verification.
 *
 * Every check in this module is a no-auth read-only simulation — no signer,
 * no funded account, and no on-chain state changes. The blank source account
 * (`GAAA...WHF`) is used throughout, consistent with every other read-only
 * call in the SDK.
 *
 * ## What is checked per contract
 *
 * | Role             | Entrypoints checked                                                      |
 * |------------------|--------------------------------------------------------------------------|
 * | yieldEngine      | get_storage_version, get_admin, is_paused, is_circuit_breaker_tripped    |
 * | yieldVault       | get_storage_version, get_vault_info, get_metrics, get_treasury           |
 * | rebalanceEngine  | get_storage_version, is_paused, get_strategy_count, get_max_slippage_bps |
 * | rewardDistributor| get_storage_version, get_state                                           |
 * | strategyRegistry | get_storage_version, is_paused_view, get_strategy_count                  |
 * | ilInsurance      | get_storage_version, reserve_pool, get_collateralization_ratio           |
 * | actuary          | get_storage_version, get_simulation_params, get_pricing_params           |
 *
 * `get_storage_version` is a universal probe: it returns `0` on a contract
 * deployed before the versioning module existed, and ≥ 1 on a correctly
 * initialized contract. Any check failure (simulation error, unexpected return
 * type, or contract not responding) is captured per-entrypoint and reported
 * rather than thrown, so a single failing probe does not block the rest.
 *
 * ## Usage
 *
 * ```ts
 * import { PostDeploymentSmokeChecker } from './smokeCheck';
 * import { SorobanRpc, Networks } from 'stellar-sdk';
 *
 * const server = new SorobanRpc.Server('https://soroban-testnet.stellar.org');
 * const checker = new PostDeploymentSmokeChecker(server, {
 *   yieldEngine:       process.env.YIELD_ENGINE_CONTRACT_ID!,
 *   rebalanceEngine:   process.env.REBALANCE_ENGINE_CONTRACT_ID!,
 * }, { networkPassphrase: Networks.TESTNET });
 *
 * const report = await checker.checkAll();
 * if (!report.allPassed) {
 *   console.error(formatSmokeReport(report));
 *   process.exit(1);
 * }
 * ```
 *
 * See `docs/UPGRADING.md` for the full operational context.
 */

import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  scValToNative,
  Networks,
} from 'stellar-sdk';

// ---------------------------------------------------------------------------
// Re-use types from contractVersion.ts for consistency
// ---------------------------------------------------------------------------

/** Roles that identify the seven deployable contracts in this crate. */
export type SmokeContractRole =
  | 'yieldEngine'
  | 'yieldVault'
  | 'rebalanceEngine'
  | 'rewardDistributor'
  | 'strategyRegistry'
  | 'ilInsurance'
  | 'actuary';

/**
 * Map of roles to deployed contract addresses. Any role can be omitted;
 * omitted roles are skipped in the report.
 */
export type SmokeContracts = Partial<Record<SmokeContractRole, string>>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Blank public key used as the transaction source for all read-only
 * simulations. No funds, no signing — the host only needs an account object
 * to build a valid transaction envelope.
 */
const SIMULATION_SOURCE =
  'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

// ---------------------------------------------------------------------------
// Structural server interface (same as contractVersion.ts)
// ---------------------------------------------------------------------------

/**
 * The slice of `SorobanRpc.Server` that this module uses.
 *
 * Declaring it structurally keeps smoke checks testable without a network:
 * `SorobanRpc.Server` satisfies it, and so does a stub in a test.
 */
export interface SmokeSimulationServer {
  simulateTransaction(
    tx: Parameters<SorobanRpc.Server['simulateTransaction']>[0],
  ): Promise<SorobanRpc.Api.SimulateTransactionResponse>;
  getAccount(accountId: string): Promise<{ accountId(): string; sequenceNumber(): string }>;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Outcome of a single entrypoint probe. */
export type ProbeStatus = 'passed' | 'failed' | 'skipped';

/** Result of probing one entrypoint on one contract. */
export interface EntrypointProbeResult {
  /** The on-chain entrypoint function name, e.g. `get_storage_version`. */
  entrypoint: string;
  status: ProbeStatus;
  /**
   * The parsed return value on success. `null` when the probe failed or was
   * skipped.
   */
  returnValue: unknown;
  /** Human-readable failure reason. `null` on success. */
  error: string | null;
}

/** Aggregated smoke-check result for one contract. */
export interface ContractSmokeResult {
  contractId: string;
  contractRole: SmokeContractRole;
  /** `true` only when every probe for this contract passed. */
  passed: boolean;
  probes: EntrypointProbeResult[];
  /** First error message, for quick log display. `null` when `passed`. */
  firstError: string | null;
}

/** Aggregated smoke-check result for a full deployment. */
export interface DeploymentSmokeReport {
  contracts: ContractSmokeResult[];
  /** `true` only when every configured contract passed all its probes. */
  allPassed: boolean;
  /** Roles where at least one probe failed. */
  failingRoles: SmokeContractRole[];
  /** Total number of probes that ran. */
  totalProbes: number;
  /** Number of probes that failed. */
  failedProbes: number;
  /** ISO-8601 timestamp for when the check ran. */
  checkedAt: string;
}

/** Options for {@link PostDeploymentSmokeChecker}. */
export interface SmokeCheckerOptions {
  /**
   * Network passphrase used to build simulated transactions.
   * Defaults to `Networks.TESTNET`.
   */
  networkPassphrase?: string;
  /**
   * Clock, injectable for tests. Defaults to `() => new Date().toISOString()`.
   */
  now?: () => string;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link smokeProbe} when the contractId is invalid. Per-contract
 * failures during a full smoke check are captured inside the report rather
 * than thrown.
 */
export class SmokeCheckError extends Error {
  readonly contractId: string;
  readonly code: string;

  constructor(message: string, contractId: string, code: string) {
    super(message);
    this.name = 'SmokeCheckError';
    this.contractId = contractId;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Low-level probe
// ---------------------------------------------------------------------------

/**
 * Call a single no-auth read-only entrypoint on a deployed contract and return
 * whether it succeeded and what it returned.
 *
 * The simulation uses the standard blank source account; no signer is needed.
 *
 * @param server           Soroban RPC server or test stub.
 * @param networkPassphrase Network passphrase, e.g. `Networks.TESTNET`.
 * @param contractId       On-chain contract address.
 * @param entrypoint       Name of the entrypoint to call, e.g. `is_paused`.
 * @param validate         Optional predicate applied to `scValToNative(returnValue)`.
 *                         When provided, a simulation that succeeds but whose
 *                         return value fails validation is treated as a failure.
 */
export async function smokeProbe(
  server: SmokeSimulationServer,
  networkPassphrase: string,
  contractId: string,
  entrypoint: string,
  validate?: (value: unknown) => boolean,
): Promise<EntrypointProbeResult> {
  if (!contractId || typeof contractId !== 'string') {
    throw new SmokeCheckError(
      `contractId must be a non-empty string (entrypoint: ${entrypoint})`,
      contractId ?? '',
      'INVALID_CONTRACT_ID',
    );
  }

  let simResult: SorobanRpc.Api.SimulateTransactionResponse;
  try {
    const account = await server.getAccount(SIMULATION_SOURCE);
    const tx = new TransactionBuilder(account as any, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(new Contract(contractId).call(entrypoint))
      .setTimeout(30)
      .build();

    simResult = await server.simulateTransaction(tx);
  } catch (err: any) {
    return {
      entrypoint,
      status: 'failed',
      returnValue: null,
      error: `RPC error: ${err?.message ?? String(err)}`,
    };
  }

  if (
    !('result' in simResult) ||
    simResult.result == null ||
    (simResult as any).result?.status !== 'SUCCESS'
  ) {
    const msg =
      (simResult as any).error ??
      (simResult as any).result?.error ??
      'simulation did not succeed';
    return {
      entrypoint,
      status: 'failed',
      returnValue: null,
      error: `Simulation failed: ${msg}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = scValToNative((simResult as any).result.returnValue);
  } catch (err: any) {
    return {
      entrypoint,
      status: 'failed',
      returnValue: null,
      error: `Could not parse return value: ${err?.message ?? String(err)}`,
    };
  }

  if (validate !== undefined && !validate(parsed)) {
    return {
      entrypoint,
      status: 'failed',
      returnValue: parsed,
      error: `Return value failed validation: ${JSON.stringify(parsed)}`,
    };
  }

  return {
    entrypoint,
    status: 'passed',
    returnValue: parsed,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Per-contract probe suites
// ---------------------------------------------------------------------------

/** Returns `true` for any value that is a non-negative finite number. */
function isNonNegativeNumber(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** Returns `true` for a boolean (paused / tripped flags). */
function isBool(v: unknown): boolean {
  return typeof v === 'boolean';
}

/** Returns `true` for a non-empty string (address returned as strkey). */
function isNonEmptyString(v: unknown): boolean {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Returns `true` for a plain object (struct/map returned by the contract, e.g.
 * `VaultInfo`, `SimulationParams`, `ReservePool`).
 */
function isObject(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

type ProbeSpec = {
  entrypoint: string;
  validate?: (v: unknown) => boolean;
};

const PROBE_SUITES: Record<SmokeContractRole, ProbeSpec[]> = {
  yieldEngine: [
    { entrypoint: 'get_storage_version', validate: isNonNegativeNumber },
    { entrypoint: 'get_admin', validate: isNonEmptyString },
    { entrypoint: 'is_paused', validate: isBool },
    { entrypoint: 'is_circuit_breaker_tripped', validate: isBool },
  ],
  yieldVault: [
    { entrypoint: 'get_storage_version', validate: isNonNegativeNumber },
    { entrypoint: 'get_vault_info', validate: isObject },
    { entrypoint: 'get_metrics', validate: isObject },
    { entrypoint: 'get_treasury', validate: isNonEmptyString },
  ],
  rebalanceEngine: [
    { entrypoint: 'get_storage_version', validate: isNonNegativeNumber },
    { entrypoint: 'is_paused', validate: isBool },
    { entrypoint: 'get_strategy_count', validate: isNonNegativeNumber },
    { entrypoint: 'get_max_slippage_bps', validate: isNonNegativeNumber },
  ],
  rewardDistributor: [
    { entrypoint: 'get_storage_version', validate: isNonNegativeNumber },
    // get_state returns (paused, emergency_mode, stream_count, treasury) as a
    // map/Vec — we just assert it is an object or array (non-null).
    { entrypoint: 'get_state', validate: (v) => v !== null && v !== undefined },
  ],
  strategyRegistry: [
    { entrypoint: 'get_storage_version', validate: isNonNegativeNumber },
    { entrypoint: 'is_paused_view', validate: isBool },
    { entrypoint: 'get_strategy_count', validate: isNonNegativeNumber },
  ],
  ilInsurance: [
    { entrypoint: 'get_storage_version', validate: isNonNegativeNumber },
    { entrypoint: 'reserve_pool', validate: isObject },
    { entrypoint: 'get_collateralization_ratio', validate: isNonNegativeNumber },
  ],
  actuary: [
    { entrypoint: 'get_storage_version', validate: isNonNegativeNumber },
    { entrypoint: 'get_simulation_params', validate: isObject },
    { entrypoint: 'get_pricing_params', validate: isObject },
  ],
};

// ---------------------------------------------------------------------------
// PostDeploymentSmokeChecker
// ---------------------------------------------------------------------------

/**
 * Runs post-deployment smoke checks for every configured contract in a
 * deployment.
 *
 * Each contract is probed on its critical no-auth read-only entrypoints. All
 * probes run in parallel across contracts (sequential per-contract to avoid
 * confusing interleaved failures). Per-contract failures are captured in the
 * report rather than thrown, so a single unreachable contract does not prevent
 * the rest from being checked.
 *
 * ```ts
 * const checker = new PostDeploymentSmokeChecker(server, {
 *   yieldEngine: 'GAB...CONTRACT_ID',
 *   yieldVault:  'GCD...CONTRACT_ID',
 * }, { networkPassphrase: Networks.TESTNET });
 *
 * const report = await checker.checkAll();
 * if (!report.allPassed) {
 *   console.error(formatSmokeReport(report));
 *   process.exit(1);
 * }
 * ```
 */
export class PostDeploymentSmokeChecker {
  private readonly server: SmokeSimulationServer;
  private readonly contracts: SmokeContracts;
  private readonly networkPassphrase: string;
  private readonly now: () => string;

  constructor(
    server: SmokeSimulationServer,
    contracts: SmokeContracts,
    options: SmokeCheckerOptions = {},
  ) {
    this.server = server;
    this.contracts = contracts;
    this.networkPassphrase = options.networkPassphrase ?? Networks.TESTNET;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Run smoke checks for every configured contract in parallel.
   * Returns a {@link DeploymentSmokeReport}.
   */
  async checkAll(): Promise<DeploymentSmokeReport> {
    const roles = Object.keys(this.contracts) as SmokeContractRole[];

    const results = await Promise.all(roles.map((role) => this.checkContract(role)));

    const failingRoles = results.filter((r) => !r.passed).map((r) => r.contractRole);
    const totalProbes = results.reduce((n, r) => n + r.probes.length, 0);
    const failedProbes = results.reduce(
      (n, r) => n + r.probes.filter((p) => p.status === 'failed').length,
      0,
    );

    return {
      contracts: results,
      allPassed: failingRoles.length === 0,
      failingRoles,
      totalProbes,
      failedProbes,
      checkedAt: this.now(),
    };
  }

  /**
   * Run smoke checks for a single contract by role.
   *
   * @throws {SmokeCheckError} when the role is not configured or is unknown.
   */
  async checkContract(role: SmokeContractRole): Promise<ContractSmokeResult> {
    const contractId = this.contracts[role];
    if (!contractId) {
      throw new SmokeCheckError(
        `No contract ID configured for role '${role}'`,
        '',
        'UNCONFIGURED_ROLE',
      );
    }

    const suite = PROBE_SUITES[role];
    if (!suite) {
      throw new SmokeCheckError(
        `Unknown contract role '${role}'`,
        contractId,
        'UNKNOWN_ROLE',
      );
    }

    // Run probes sequentially per-contract — easier to read in logs and avoids
    // hammering a single RPC node with many requests in one tick.
    const probes: EntrypointProbeResult[] = [];
    for (const spec of suite) {
      probes.push(
        await smokeProbe(
          this.server,
          this.networkPassphrase,
          contractId,
          spec.entrypoint,
          spec.validate,
        ),
      );
    }

    const failed = probes.filter((p) => p.status === 'failed');
    return {
      contractId,
      contractRole: role,
      passed: failed.length === 0,
      probes,
      firstError: failed.length > 0 ? failed[0].error : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Report formatter
// ---------------------------------------------------------------------------

/**
 * Format a {@link DeploymentSmokeReport} as a human-readable multiline string
 * suitable for operator logs and CI output.
 *
 * ```
 * Post-deployment smoke check  2024-01-15T12:00:00.000Z
 *   yieldEngine      GAB...  3/3 passed
 *   yieldVault       GCD...  2/3 passed  ← get_vault_info: Simulation failed: ...
 *   rebalanceEngine  GEF...  4/4 passed
 * Summary: 2 of 3 contracts passed  (9/10 probes)
 * ```
 */
export function formatSmokeReport(report: DeploymentSmokeReport): string {
  const lines: string[] = [`Post-deployment smoke check  ${report.checkedAt}`];

  for (const c of report.contracts) {
    const total = c.probes.length;
    const passed = c.probes.filter((p) => p.status === 'passed').length;
    const passStr = `${passed}/${total} passed`;
    const errorHint = c.firstError ? `  \u2190 ${c.firstError.slice(0, 100)}` : '';
    lines.push(
      `  ${c.contractRole.padEnd(20)} ${c.contractId.slice(0, 8)}...  ${passStr}${errorHint}`,
    );

    // List any individual failing probes
    for (const p of c.probes) {
      if (p.status === 'failed') {
        lines.push(`    \u2718 ${p.entrypoint}: ${p.error}`);
      }
    }
  }

  const statusStr = report.allPassed ? 'All contracts passed' : `${report.failingRoles.length} contract(s) failed`;
  lines.push(
    `Summary: ${statusStr}  (${report.totalProbes - report.failedProbes}/${report.totalProbes} probes)`,
  );

  return lines.join('\n');
}
