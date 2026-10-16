/**
 * Load-test data validator (Phase 21), implementing iSmartPay's "Test-Data Rules
 * and Validation Requirements". A data set is rejected unless it is provably
 * synthetic: tagged, free of secrets, free of real-looking card numbers, using
 * the synthetic ID conventions, and with phone numbers that are either
 * deliberately invalid (Class A) or explicitly provider-authorised (Class B).
 *
 * Violation messages never echo the offending value — a rejected PAN must not
 * be copied into an API response or a log line.
 */

export interface DataViolation {
  path: string;
  code: string;
  message: string;
}

export interface DataSetInput {
  name?: string | undefined;
  environment?: string | undefined;
  records: unknown[];
}

export interface DataValidationOptions {
  approvedCardFixtures: string[];
}

const SECRET_KEYS = new Set([
  'cvv',
  'cvc',
  'cvv2',
  'cvc2',
  'pin',
  'password',
  'passwd',
  'otp',
  'secret',
  'clientsecret',
  'apikey',
  'apisecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'track1',
  'track2',
  'trackdata',
]);

/** `{{secret:NAME}}` — a reference resolved at run time from the secrets manager. */
const SECRET_REF = /^\{\{secret:[A-Za-z0-9_.-]+\}\}$/;

const ID_CONVENTIONS: Record<string, RegExp> = {
  customerid: /^CUS-TST-\d{6,}$/,
  merchantid: /^MER-TST-\d{6,}$/,
  walletid: /^WLT-TST-\d{6,}$/,
  accountref: /^ACC-TST-\d{6,}$/,
  accountreference: /^ACC-TST-\d{6,}$/,
  transactionref: /^TXN-TST-\d{6,}$/,
  transactionreference: /^TXN-TST-\d{6,}$/,
  idempotencykey: /^IDEM-TST-\d{6,}$/,
};

/** Any field whose name mentions a phone number: phone, msisdn, mobile, payerMsisdn, … */
const isPhoneKey = (nk: string): boolean => /(phone|msisdn|mobile)/.test(nk);
const EMAIL_KEYS = new Set(['email', 'username']);
const NON_PRODUCTION_ENVS = new Set(['mock', 'sandbox', 'staging']);

const norm = (k: string): string => k.toLowerCase().replace(/[^a-z0-9]/g, '');

export function luhnValid(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export type MsisdnResult =
  | { ok: true; e164: string }
  | { ok: false; reason: 'characters' | 'length' | 'country_code' | 'range' };

/**
 * Normalises a Ghanaian number to E.164 (+233 followed by 9 national digits).
 * Display separators are tolerated; anything else is rejected. Range check is
 * structural only (national number may not start with 0) — it says nothing
 * about whether the number is allocated, so it is never proof of a safe number.
 */
export function normalizeGhanaMsisdn(input: string): MsisdnResult {
  const raw = input.trim();
  if (!/^[+\d\s().-]+$/.test(raw)) return { ok: false, reason: 'characters' };
  let d = raw.replace(/[\s().-]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = `233${d.slice(1)}`;
  if (!/^\d+$/.test(d)) return { ok: false, reason: 'characters' };
  if (!d.startsWith('233')) return { ok: false, reason: 'country_code' };
  const national = d.slice(3);
  if (national.length !== 9) return { ok: false, reason: 'length' };
  if (national.startsWith('0')) return { ok: false, reason: 'range' };
  return { ok: true, e164: `+233${national}` };
}

export function validateDataSet(
  set: DataSetInput,
  opts: DataValidationOptions,
): { valid: boolean; violations: DataViolation[]; recordCount: number } {
  const violations: DataViolation[] = [];
  const add = (path: string, code: string, message: string): void => {
    violations.push({ path, code, message });
  };
  const approved = new Set(opts.approvedCardFixtures);

  if (!set.environment || !NON_PRODUCTION_ENVS.has(set.environment.toLowerCase())) {
    add(
      'environment',
      'ENVIRONMENT',
      'Data set must declare environment mock, sandbox or staging.',
    );
  }

  const walk = (value: unknown, path: string, record: Record<string, unknown>): void => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`, record));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        visit(k, v, `${path}.${k}`, record);
      }
      return;
    }
  };

  const visit = (
    key: string,
    value: unknown,
    path: string,
    record: Record<string, unknown>,
  ): void => {
    const nk = norm(key);
    if (typeof value === 'string') {
      const isRef = SECRET_REF.test(value);
      if (SECRET_KEYS.has(nk) && !isRef) {
        add(
          path,
          'SECRET_FIELD',
          'Secrets (PIN/CVV/OTP/password/token) must be {{secret:NAME}} references.',
        );
        return;
      }
      if (ID_CONVENTIONS[nk] && !ID_CONVENTIONS[nk].test(value)) {
        add(
          path,
          'NON_SYNTHETIC_ID',
          'Identifier does not follow the synthetic *-TST-###### convention.',
        );
      }
      if (EMAIL_KEYS.has(nk) && value.includes('@') && !/@[^@]+\.test$/i.test(value)) {
        add(path, 'NON_TEST_EMAIL', 'Test identities must use the reserved .test domain.');
      }
      if (isPhoneKey(nk) && !isRef) {
        const n = normalizeGhanaMsisdn(value);
        if (n.ok) {
          // Syntactically valid → might belong to a real subscriber (Class B only).
          if (
            record['providerAuthorized'] !== true ||
            typeof record['authorizationRef'] !== 'string'
          ) {
            add(
              path,
              'UNAUTHORIZED_REAL_NUMBER',
              'A valid-format number needs providerAuthorized=true and an authorizationRef (or a {{secret:…}} reference).',
            );
          }
        }
        // Invalid-format numbers are Class A fixtures — allowed, never routable.
      }
      const compact = value.replace(/[\s-]/g, '');
      if (/^\d{13,19}$/.test(compact) && luhnValid(compact) && !approved.has(compact)) {
        add(
          path,
          'REAL_PAN_SUSPECTED',
          'Luhn-valid card number that is not an approved processor fixture.',
        );
      }
      return;
    }
    if (typeof value === 'number' && Number.isInteger(value)) {
      const s = String(value);
      if (s.length >= 13 && s.length <= 19 && luhnValid(s) && !approved.has(s)) {
        add(
          path,
          'REAL_PAN_SUSPECTED',
          'Luhn-valid card number that is not an approved processor fixture.',
        );
      }
      if (SECRET_KEYS.has(nk))
        add(path, 'SECRET_FIELD', 'Secrets must be {{secret:NAME}} references.');
      return;
    }
    if (value !== null && typeof value === 'object') {
      if (SECRET_KEYS.has(nk))
        add(path, 'SECRET_FIELD', 'Secrets must be {{secret:NAME}} references.');
      walk(value, path, record);
    }
  };

  set.records.forEach((rec, idx) => {
    const base = `records[${idx}]`;
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) {
      add(base, 'RECORD_SHAPE', 'Each record must be an object.');
      return;
    }
    const r = rec as Record<string, unknown>;
    if (r['test_data'] !== true)
      add(`${base}.test_data`, 'UNTAGGED', 'Record must carry test_data: true.');
    if (typeof r['test_case_id'] !== 'string' || !r['test_case_id'])
      add(`${base}.test_case_id`, 'UNTAGGED', 'Record must carry a test_case_id.');
    const env = typeof r['environment'] === 'string' ? r['environment'].toLowerCase() : '';
    if (!NON_PRODUCTION_ENVS.has(env))
      add(
        `${base}.environment`,
        'UNTAGGED',
        'Record must be tagged environment mock, sandbox or staging.',
      );
    for (const [k, v] of Object.entries(r)) visit(k, v, `${base}.${k}`, r);
  });

  return { valid: violations.length === 0, violations, recordCount: set.records.length };
}
