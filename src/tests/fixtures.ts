import type { MonitoredApi } from '../domain/target.js';

/** Builds a MonitoredApi for tests. Override only what the test cares about. */
export function makeMonitoredApi(overrides: Partial<MonitoredApi> = {}): MonitoredApi {
  const now = new Date();
  return {
    id: overrides.id ?? '00000000-0000-0000-0000-000000000001',
    name: 'test target',
    description: null,
    environment: 'sandbox',
    endpointClass: 'internal',
    severityDefault: 'LOW',
    isMoneyMoving: false,
    url: 'http://127.0.0.1:1/',
    method: 'GET',
    authenticationType: 'NONE',
    hasCredentials: false,
    headers: {},
    requestBody: null,
    expectedStatus: null,
    expectedResponse: null,
    timeoutMs: 2000,
    frequencyCron: '*/1 * * * *',
    retry: { count: 2, baseDelayMs: 10, backoffMultiplier: 2, maxDelayMs: 50 },
    slaTargetPercent: 99.95,
    ownerId: null,
    teamId: null,
    escalationPolicyId: null,
    tags: [],
    isActive: true,
    allowPrivateNetwork: true,
    bypassMinIntervalFloor: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
