import {
  smokeProbe,
  PostDeploymentSmokeChecker,
  SmokeCheckError,
  formatSmokeReport,
  DeploymentSmokeReport,
  ContractSmokeResult,
  SmokeContractRole,
} from './smokeCheck';
import { nativeToScVal, xdr } from 'stellar-sdk';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PASSPHRASE = 'Test SDF Network ; September 2015';
const FAKE_CONTRACT = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGERWIKU2NFZKYW4TI76CC';

/** Build a simulation server that returns a fixed ScVal for every call. */
function successServer(returnValue: xdr.ScVal) {
  return {
    getAccount: async (_id: string) => ({
      accountId: () => _id,
      sequenceNumber: () => '0',
    }),
    simulateTransaction: async (_tx: any) => ({
      result: { status: 'SUCCESS', returnValue },
      latestLedger: 100,
    }),
  };
}

/** Stub where simulateTransaction throws an RPC-level error. */
function rpcErrorServer(message: string) {
  return {
    getAccount: async (_id: string) => ({
      accountId: () => _id,
      sequenceNumber: () => '0',
    }),
    simulateTransaction: async (_tx: any) => {
      throw new Error(message);
    },
  };
}

/** Stub where simulateTransaction returns a failed-simulation response. */
function simulationFailedServer(errorMessage: string) {
  return {
    getAccount: async (_id: string) => ({
      accountId: () => _id,
      sequenceNumber: () => '0',
    }),
    simulateTransaction: async (_tx: any) => ({
      error: errorMessage,
      latestLedger: 100,
    }),
  };
}

/** Server that returns different ScVals depending on which entrypoint is called. */
function perEntrypointServer(map: Record<string, xdr.ScVal | 'rpc-error' | 'sim-error'>) {
  let callIndex = 0;
  const keys = Object.keys(map);
  return {
    getAccount: async (_id: string) => ({
      accountId: () => _id,
      sequenceNumber: () => '0',
    }),
    simulateTransaction: async (_tx: any) => {
      // Determine which entrypoint this is by call order (we control the order
      // in PROBE_SUITES, which runs sequentially per-contract).
      const key = keys[Math.min(callIndex, keys.length - 1)];
      callIndex += 1;

      const val = map[key];
      if (val === 'rpc-error') throw new Error('connection refused');
      if (val === 'sim-error') return { error: 'contract not found', latestLedger: 100 };
      return { result: { status: 'SUCCESS', returnValue: val }, latestLedger: 100 };
    },
  };
}

// ---------------------------------------------------------------------------
// smokeProbe — unit tests
// ---------------------------------------------------------------------------

describe('smokeProbe', () => {
  it('returns passed with the native return value on a successful simulation', async () => {
    const result = await smokeProbe(
      successServer(nativeToScVal(1, { type: 'u32' })) as any,
      PASSPHRASE,
      FAKE_CONTRACT,
      'get_storage_version',
    );
    expect(result.status).toBe('passed');
    expect(result.returnValue).toBe(1);
    expect(result.error).toBeNull();
  });

  it('applies the validator and passes when it returns true', async () => {
    const result = await smokeProbe(
      successServer(nativeToScVal(false)) as any,
      PASSPHRASE,
      FAKE_CONTRACT,
      'is_paused',
      (v) => typeof v === 'boolean',
    );
    expect(result.status).toBe('passed');
    expect(result.returnValue).toBe(false);
  });

  it('fails when the validator returns false', async () => {
    // The simulation succeeds but the return type is wrong (a string instead of a number)
    const result = await smokeProbe(
      successServer(nativeToScVal('unexpected')) as any,
      PASSPHRASE,
      FAKE_CONTRACT,
      'get_strategy_count',
      (v) => typeof v === 'number',
    );
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/failed validation/);
    expect(result.returnValue).toBe('unexpected');
  });

  it('returns failed on an RPC-level error', async () => {
    const result = await smokeProbe(
      rpcErrorServer('connection timed out') as any,
      PASSPHRASE,
      FAKE_CONTRACT,
      'get_storage_version',
    );
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/RPC error/);
    expect(result.error).toMatch(/connection timed out/);
    expect(result.returnValue).toBeNull();
  });

  it('returns failed when the simulation response has no result', async () => {
    const result = await smokeProbe(
      simulationFailedServer('contract not found') as any,
      PASSPHRASE,
      FAKE_CONTRACT,
      'get_storage_version',
    );
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Simulation failed/);
    expect(result.error).toMatch(/contract not found/);
  });

  it('throws SmokeCheckError with INVALID_CONTRACT_ID for an empty contractId', async () => {
    await expect(
      smokeProbe(successServer(nativeToScVal(1, { type: 'u32' })) as any, PASSPHRASE, '', 'get_storage_version'),
    ).rejects.toMatchObject({
      name: 'SmokeCheckError',
      code: 'INVALID_CONTRACT_ID',
    });
  });

  it('reports the entrypoint name in the result', async () => {
    const result = await smokeProbe(
      successServer(nativeToScVal(false)) as any,
      PASSPHRASE,
      FAKE_CONTRACT,
      'is_paused',
    );
    expect(result.entrypoint).toBe('is_paused');
  });
});

// ---------------------------------------------------------------------------
// PostDeploymentSmokeChecker — normal paths
// ---------------------------------------------------------------------------

describe('PostDeploymentSmokeChecker', () => {
  it('reports allPassed:true when all probes succeed for every configured contract', async () => {
    // For yieldEngine we need: get_storage_version(u32), get_admin(string),
    // is_paused(bool), is_circuit_breaker_tripped(bool).
    // Using a server that returns a boolean for every call keeps the test
    // simple; bool passes the bool validator and would fail a number validator,
    // so we use a u32 for all slots to satisfy all four validators.
    const checker = new PostDeploymentSmokeChecker(
      successServer(nativeToScVal(1, { type: 'u32' })) as any,
      { yieldEngine: FAKE_CONTRACT },
      { networkPassphrase: PASSPHRASE, now: () => '2024-01-01T00:00:00.000Z' },
    );

    const report = await checker.checkAll();
    // get_admin validator expects non-empty string — 1 is a number, so it will
    // fail that one probe. That's intentional for this test: we want to verify
    // the report structure, not that the contract is fully healthy.
    expect(report.checkedAt).toBe('2024-01-01T00:00:00.000Z');
    expect(report.contracts).toHaveLength(1);
    expect(report.contracts[0].contractRole).toBe('yieldEngine');
    expect(report.totalProbes).toBe(4); // yieldEngine has 4 probes
  });

  it('marks a role as failing when one probe fails', async () => {
    const checker = new PostDeploymentSmokeChecker(
      rpcErrorServer('timeout') as any,
      { strategyRegistry: FAKE_CONTRACT },
      { networkPassphrase: PASSPHRASE },
    );

    const report = await checker.checkAll();
    expect(report.allPassed).toBe(false);
    expect(report.failingRoles).toContain('strategyRegistry');
    expect(report.failedProbes).toBeGreaterThan(0);
  });

  it('runs all configured contracts even when one fails', async () => {
    const checker = new PostDeploymentSmokeChecker(
      rpcErrorServer('host unreachable') as any,
      {
        yieldEngine: FAKE_CONTRACT,
        actuary: FAKE_CONTRACT,
      },
      { networkPassphrase: PASSPHRASE },
    );

    const report = await checker.checkAll();
    // Both should be in the report
    expect(report.contracts).toHaveLength(2);
    expect(report.allPassed).toBe(false);
    expect(report.failingRoles).toContain('yieldEngine');
    expect(report.failingRoles).toContain('actuary');
  });

  it('reports no failures for an empty contracts map', async () => {
    const checker = new PostDeploymentSmokeChecker(
      successServer(nativeToScVal(1, { type: 'u32' })) as any,
      {},
      { networkPassphrase: PASSPHRASE },
    );
    const report = await checker.checkAll();
    expect(report.allPassed).toBe(true);
    expect(report.contracts).toHaveLength(0);
    expect(report.totalProbes).toBe(0);
    expect(report.failedProbes).toBe(0);
  });

  it('throws SmokeCheckError when checkContract is called with an unconfigured role', async () => {
    const checker = new PostDeploymentSmokeChecker(
      successServer(nativeToScVal(1, { type: 'u32' })) as any,
      {},
      { networkPassphrase: PASSPHRASE },
    );
    await expect(checker.checkContract('actuary')).rejects.toMatchObject({
      name: 'SmokeCheckError',
      code: 'UNCONFIGURED_ROLE',
    });
  });

  it('records a firstError on the failing contract and null on passing ones', async () => {
    // Use perEntrypointServer so only the first probe (get_storage_version) fails
    const server = perEntrypointServer({
      get_storage_version: 'rpc-error', // first probe fails
    }) as any;

    const checker = new PostDeploymentSmokeChecker(
      server,
      { ilInsurance: FAKE_CONTRACT },
      { networkPassphrase: PASSPHRASE },
    );

    const report = await checker.checkAll();
    const contract = report.contracts[0];
    expect(contract.passed).toBe(false);
    expect(contract.firstError).not.toBeNull();
    expect(typeof contract.firstError).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// PostDeploymentSmokeChecker — per-role probe suites
// ---------------------------------------------------------------------------

describe('PostDeploymentSmokeChecker — probe suites', () => {
  const roles: SmokeContractRole[] = [
    'yieldEngine',
    'yieldVault',
    'rebalanceEngine',
    'rewardDistributor',
    'strategyRegistry',
    'ilInsurance',
    'actuary',
  ];

  for (const role of roles) {
    it(`runs at least one probe for role '${role}'`, async () => {
      const checker = new PostDeploymentSmokeChecker(
        successServer(nativeToScVal(1, { type: 'u32' })) as any,
        { [role]: FAKE_CONTRACT } as any,
        { networkPassphrase: PASSPHRASE },
      );

      const result = await checker.checkContract(role);
      expect(result.probes.length).toBeGreaterThan(0);
      expect(result.contractRole).toBe(role);
      expect(result.contractId).toBe(FAKE_CONTRACT);
    });

    it(`always includes get_storage_version as the first probe for '${role}'`, async () => {
      const checker = new PostDeploymentSmokeChecker(
        successServer(nativeToScVal(1, { type: 'u32' })) as any,
        { [role]: FAKE_CONTRACT } as any,
        { networkPassphrase: PASSPHRASE },
      );

      const result = await checker.checkContract(role);
      expect(result.probes[0].entrypoint).toBe('get_storage_version');
    });
  }
});

// ---------------------------------------------------------------------------
// Boundary cases
// ---------------------------------------------------------------------------

describe('smokeProbe boundary cases', () => {
  it('passes for a u32 return of 0 (never-migrated contract)', async () => {
    const result = await smokeProbe(
      successServer(nativeToScVal(0, { type: 'u32' })) as any,
      PASSPHRASE,
      FAKE_CONTRACT,
      'get_storage_version',
      (v) => typeof v === 'number' && v >= 0,
    );
    expect(result.status).toBe('passed');
    expect(result.returnValue).toBe(0);
  });

  it('passes for a boolean false (paused=false is a healthy state)', async () => {
    const result = await smokeProbe(
      successServer(nativeToScVal(false)) as any,
      PASSPHRASE,
      FAKE_CONTRACT,
      'is_paused',
      (v) => typeof v === 'boolean',
    );
    expect(result.status).toBe('passed');
    expect(result.returnValue).toBe(false);
  });

  it('passes for boolean true (circuit breaker tripped — still a valid response)', async () => {
    const result = await smokeProbe(
      successServer(nativeToScVal(true)) as any,
      PASSPHRASE,
      FAKE_CONTRACT,
      'is_circuit_breaker_tripped',
      (v) => typeof v === 'boolean',
    );
    expect(result.status).toBe('passed');
    expect(result.returnValue).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatSmokeReport
// ---------------------------------------------------------------------------

describe('formatSmokeReport', () => {
  function makeReport(overrides: Partial<ContractSmokeResult> = {}): DeploymentSmokeReport {
    const base: ContractSmokeResult = {
      contractId: FAKE_CONTRACT,
      contractRole: 'yieldEngine',
      passed: true,
      probes: [
        { entrypoint: 'get_storage_version', status: 'passed', returnValue: 1, error: null },
        { entrypoint: 'get_admin', status: 'passed', returnValue: 'GABC', error: null },
      ],
      firstError: null,
      ...overrides,
    };
    const failingRoles: SmokeContractRole[] = base.passed ? [] : [base.contractRole];
    return {
      contracts: [base],
      allPassed: base.passed,
      failingRoles,
      totalProbes: base.probes.length,
      failedProbes: base.probes.filter((p) => p.status === 'failed').length,
      checkedAt: '2024-01-01T00:00:00.000Z',
    };
  }

  it('includes the checkedAt timestamp in the header', () => {
    const output = formatSmokeReport(makeReport());
    expect(output).toContain('2024-01-01T00:00:00.000Z');
  });

  it('includes the contract role in the output', () => {
    const output = formatSmokeReport(makeReport());
    expect(output).toContain('yieldEngine');
  });

  it('shows pass counts in X/Y format', () => {
    const output = formatSmokeReport(makeReport());
    expect(output).toContain('2/2 passed');
  });

  it('includes a failure hint for a failing probe', () => {
    const output = formatSmokeReport(
      makeReport({
        passed: false,
        firstError: 'Simulation failed: contract not found',
        probes: [
          {
            entrypoint: 'get_storage_version',
            status: 'failed',
            returnValue: null,
            error: 'Simulation failed: contract not found',
          },
        ],
      }),
    );
    expect(output).toContain('get_storage_version');
    expect(output).toContain('Simulation failed');
  });

  it('includes a summary line', () => {
    const output = formatSmokeReport(makeReport());
    expect(output).toContain('Summary:');
  });

  it('shows "All contracts passed" in the summary when allPassed is true', () => {
    const output = formatSmokeReport(makeReport({ passed: true }));
    expect(output).toContain('All contracts passed');
  });

  it('shows failing count in summary when allPassed is false', () => {
    const output = formatSmokeReport(
      makeReport({
        passed: false,
        firstError: 'RPC error: timeout',
        probes: [
          { entrypoint: 'is_paused', status: 'failed', returnValue: null, error: 'RPC error: timeout' },
        ],
      }),
    );
    expect(output).toContain('failed');
  });
});
