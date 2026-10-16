import { describe, expect, it } from 'vitest';
import { luhnValid, normalizeGhanaMsisdn, validateDataSet } from './load-test-data.js';

const opts = { approvedCardFixtures: ['4111111111111111'] };
const tag = { test_data: true, test_case_id: 'CARD-001', environment: 'sandbox' };
const run = (records: unknown[], environment = 'sandbox') =>
  validateDataSet({ environment, records }, opts);
const codes = (records: unknown[]) => run(records).violations.map((v) => v.code);

describe('luhnValid / normalizeGhanaMsisdn', () => {
  it('checks Luhn', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
  });

  it.each([
    ['0241234567', '+233241234567'],
    ['+233 24 123 4567', '+233241234567'],
    ['00233-24-123-4567', '+233241234567'],
    ['233241234567', '+233241234567'],
  ])('normalises %s', (input, e164) => {
    expect(normalizeGhanaMsisdn(input)).toEqual({ ok: true, e164 });
  });

  it.each([
    ['024123456', 'length'],
    ['02412345678', 'length'],
    ['+441234567890', 'country_code'],
    ['024ABC4567', 'characters'],
    ['+233000000001', 'range'],
  ])('rejects %s (%s)', (input, reason) => {
    expect(normalizeGhanaMsisdn(input)).toEqual({ ok: false, reason });
  });
});

describe('validateDataSet', () => {
  it('accepts a clean synthetic record', () => {
    const r = run([
      {
        ...tag,
        customerId: 'CUS-TST-000001',
        walletId: 'WLT-TST-000001',
        idempotencyKey: 'IDEM-TST-000001',
        email: 'qa.customer.001@ismartpay.test',
        card: '4111111111111111',
        phone: '+233000000001', // Class A: invalid-format, never routable
        password: '{{secret:QA_CUSTOMER_PASSWORD}}',
      },
    ]);
    expect(r.violations).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('rejects non-production environment violations and untagged records', () => {
    expect(run([{ ...tag }], 'production').violations.map((v) => v.code)).toContain('ENVIRONMENT');
    expect(codes([{ customerId: 'CUS-TST-000001' }])).toContain('UNTAGGED');
    expect(codes([{ ...tag, environment: 'production' }])).toContain('UNTAGGED');
  });

  it('rejects secrets stored in the clear but allows secret references', () => {
    expect(codes([{ ...tag, cvv: '123' }])).toContain('SECRET_FIELD');
    expect(codes([{ ...tag, pin: 1234 }])).toContain('SECRET_FIELD');
    expect(codes([{ ...tag, auth: { password: 'hunter2' } }])).toContain('SECRET_FIELD');
    expect(codes([{ ...tag, cvv: '{{secret:CVV}}' }])).toEqual([]);
  });

  it('flags Luhn-valid PANs that are not approved fixtures, without echoing them', () => {
    const r = run([{ ...tag, pan: '5555 5555 5555 4444' }]);
    expect(r.violations.map((v) => v.code)).toContain('REAL_PAN_SUSPECTED');
    expect(JSON.stringify(r)).not.toContain('5555');
    // Invalid-checksum numbers are legitimate negative-test fixtures (CARD-003).
    expect(codes([{ ...tag, pan: '4111111111111112' }])).toEqual([]);
  });

  it('requires synthetic ID conventions and .test emails', () => {
    expect(codes([{ ...tag, walletId: 'WLT-123' }])).toContain('NON_SYNTHETIC_ID');
    expect(codes([{ ...tag, email: 'real.person@gmail.com' }])).toContain('NON_TEST_EMAIL');
  });

  it('detects phone fields by name fragment, not just exact names', () => {
    expect(codes([{ ...tag, payerMsisdn: '0241234567' }])).toContain('UNAUTHORIZED_REAL_NUMBER');
    expect(codes([{ ...tag, beneficiaryMsisdn: '233000000001' }])).toEqual([]); // documented Telecel fixture
    expect(codes([{ ...tag, destinationMsisdn: '{{secret:LT_TEST_SIM}}' }])).toEqual([]);
  });

  it('treats valid-format phones as Class B needing explicit provider authorisation', () => {
    expect(codes([{ ...tag, phone: '0241234567' }])).toContain('UNAUTHORIZED_REAL_NUMBER');
    expect(
      codes([{ ...tag, phone: '0241234567', providerAuthorized: true, authorizationRef: 'SIM-7' }]),
    ).toEqual([]);
    expect(codes([{ ...tag, phone: '{{secret:TEST_SIM_1}}' }])).toEqual([]);
  });
});
