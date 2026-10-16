import type { LoadProfile } from '../../domain/enums.js';

/**
 * Compliance control library (Phase 28). Maps what the load-testing programme
 * can PROVE onto the controls of the frameworks the business answers to.
 *
 * Ground rules, encoded in the data:
 *  - It is a mapping of EVIDENCE to controls, not a certification. Every control
 *    states what testing cannot show (`limitation`).
 *  - Every mapping is DRAFT until a COMPLIANCE-role reviewer approves it for the
 *    current `LIBRARY_VERSION`. Bumping the version invalidates earlier reviews.
 *  - `refVerified: false` means the reference wording must be confirmed by the
 *    compliance owner / QSA before it is quoted to an auditor. PCI DSS and OWASP
 *    references are requirement-level and stable; Bank of Ghana and Ghana data-
 *    protection items are THEMES, with the exact directive clauses to be supplied.
 *  - `intent` paraphrases the control in our own words. It is not a quotation.
 *  - Controls this tooling cannot evidence (penetration testing, policies,
 *    incident-response process) are `out_of_scope` with how to cover them.
 */

export const LIBRARY_VERSION = '2026.10.16-draft-1';

export type Framework = 'PCI_DSS_4_0_1' | 'OWASP_API_2023' | 'BOG' | 'GH_DPA_843';

export const FRAMEWORKS: Record<Framework, { name: string; short: string; note: string }> = {
  PCI_DSS_4_0_1: {
    name: 'PCI DSS v4.0.1',
    short: 'PCI DSS',
    note: 'Requirement-level references. This programme supports, but does not replace, QSA-led assessment, ASV scans or penetration testing.',
  },
  OWASP_API_2023: {
    name: 'OWASP API Security Top 10 (2023)',
    short: 'OWASP API',
    note: 'Each category maps to the checks that probe it.',
  },
  BOG: {
    name: 'Bank of Ghana — payment-system expectations',
    short: 'Bank of Ghana',
    note: 'Themes drawn from the Payment Systems and Services Act, 2019 (Act 987) and BoG operational, cyber-security and e-money requirements. Exact directive clauses are NOT yet verified — the compliance owner must supply them.',
  },
  GH_DPA_843: {
    name: 'Ghana Data Protection Act, 2012 (Act 843)',
    short: 'Data protection',
    note: 'Security-safeguard and data-minimisation themes. Exact section references are NOT yet verified.',
  },
};

/** One piece of evidence a control relies on. */
export type EvidenceRule =
  | { kind: 'checks'; checkIds: string[]; description: string }
  | { kind: 'load'; profiles: LoadProfile[]; description: string };

export type Scope = 'testable' | 'partial' | 'out_of_scope';

export interface Control {
  id: string;
  framework: Framework;
  /** Human reference, e.g. "Requirement 6.2". */
  ref: string;
  title: string;
  /** What the control asks for, in our words. */
  intent: string;
  refVerified: boolean;
  scope: Scope;
  evidence: EvidenceRule[];
  /** What this evidence cannot show. */
  limitation: string;
  /** For out_of_scope controls: how to obtain evidence elsewhere. */
  howToCover?: string;
}

const checks = (description: string, ...checkIds: string[]): EvidenceRule => ({
  kind: 'checks',
  checkIds,
  description,
});
const load = (description: string, ...profiles: LoadProfile[]): EvidenceRule => ({
  kind: 'load',
  profiles,
  description,
});

export const CONTROLS: Control[] = [
  /* ── PCI DSS v4.0.1 ─────────────────────────────────────────────────── */
  {
    id: 'PCI-3.3',
    framework: 'PCI_DSS_4_0_1',
    ref: 'Requirement 3.3',
    title: 'Sensitive authentication data is not retained after authorization',
    intent:
      'CVV/PIN/track data must never be stored once a payment is authorised, and must not leak back out of the API.',
    refVerified: true,
    scope: 'partial',
    evidence: [
      checks(
        'API responses carry no secret, internal or card-like fields',
        'bopla.response-allowlist',
      ),
      checks('Error bodies leak no secrets or credentials', 'misconfig.error-hygiene'),
    ],
    limitation:
      'Black-box testing of responses only. It cannot prove nothing is stored in the vendor’s databases or logs.',
  },
  {
    id: 'PCI-3.4',
    framework: 'PCI_DSS_4_0_1',
    ref: 'Requirement 3.4',
    title: 'Displays and copies of the full card number are restricted',
    intent:
      'The full PAN should only be visible where there is a business need; elsewhere it is masked.',
    refVerified: true,
    scope: 'partial',
    evidence: [checks('No response value looks like a card number', 'bopla.response-allowlist')],
    limitation: 'Only the API surface is probed; screens, exports and support tooling are not.',
  },
  {
    id: 'PCI-4.2',
    framework: 'PCI_DSS_4_0_1',
    ref: 'Requirement 4.2',
    title: 'Card data is protected with strong cryptography in transit',
    intent: 'Transmissions of cardholder data over open networks use strong, current TLS.',
    refVerified: true,
    scope: 'partial',
    evidence: [
      checks(
        'TLS 1.2+ negotiated with a valid certificate on https targets',
        'misconfig.headers-tls-cors',
      ),
    ],
    limitation:
      'Probes the negotiated protocol and certificate only. Cipher-suite review needs a dedicated TLS scan.',
  },
  {
    id: 'PCI-6.2',
    framework: 'PCI_DSS_4_0_1',
    ref: 'Requirement 6.2',
    title: 'Custom software is developed to resist common attacks',
    intent: 'Inputs are validated and software prevents injection and similar common attacks.',
    refVerified: true,
    scope: 'partial',
    evidence: [
      checks('Injection-style input is inert data', 'input.hostile-strings-inert'),
      checks('Server-owned fields cannot be set by clients', 'bopla.mass-assignment-rejected'),
      checks(
        'Malformed money requests are rejected and create nothing',
        'validation.malformed-rejected',
      ),
    ],
    limitation:
      'Behavioural evidence from the outside. It is not a code review or SAST/DAST result.',
  },
  {
    id: 'PCI-6.4',
    framework: 'PCI_DSS_4_0_1',
    ref: 'Requirement 6.4',
    title: 'Public-facing web applications are protected against attacks',
    intent:
      'Internet-facing applications resist abuse; protections stay effective under hostile input.',
    refVerified: true,
    scope: 'partial',
    evidence: [
      checks(
        'Rate limiting, payload limits and page caps hold',
        'resource.rate-limit-behaviour',
        'resource.payload-limits',
        'resource.pagination-caps',
      ),
      checks(
        'Unexpected methods and debug paths are not exposed',
        'misconfig.methods-and-debug-paths',
      ),
    ],
    limitation: 'Does not show whether a WAF or automated detection (6.4.2) is deployed.',
  },
  {
    id: 'PCI-7.2',
    framework: 'PCI_DSS_4_0_1',
    ref: 'Requirement 7.2',
    title: 'Access to systems and data is appropriately defined and assigned (least privilege)',
    intent: 'Each credential can do only what it is meant to, and see only its own data.',
    refVerified: true,
    scope: 'testable',
    evidence: [
      checks('A read-only credential cannot move money', 'authz.permission-enforced'),
      checks('One account cannot read another’s payments', 'bola.cross-account-access'),
    ],
    limitation: 'Covers API credentials. Staff and console access are separate.',
  },
  {
    id: 'PCI-8.3',
    framework: 'PCI_DSS_4_0_1',
    ref: 'Requirement 8.2 / 8.3',
    title: 'Identification and strong authentication are enforced',
    intent:
      'Unknown or invalid credentials are refused, tokens expire, and failures do not help an attacker.',
    refVerified: true,
    scope: 'partial',
    evidence: [
      checks('Invalid, missing and tampered tokens are refused', 'auth.invalid-token-rejected'),
      checks(
        'Unknown clients and wrong secrets are refused and indistinguishable',
        'auth.bogus-client-rejected',
      ),
      checks('Expired tokens are refused', 'auth.token-expiry-enforced'),
    ],
    limitation: 'Does not cover multi-factor authentication for people or password policy.',
  },
  {
    id: 'PCI-10.2',
    framework: 'PCI_DSS_4_0_1',
    ref: 'Requirement 10.2',
    title: 'Audit logs capture activity so anomalies can be detected',
    intent: 'Security-relevant activity is logged and traceable.',
    refVerified: true,
    scope: 'partial',
    evidence: [
      checks(
        'Every response carries a Request-Id usable in support and audit trails',
        'misconfig.error-hygiene',
      ),
    ],
    limitation:
      'Shows traceability identifiers on responses only. The vendor’s log content, retention and review are outside this evidence. This programme’s own runs are audit-logged.',
    howToCover: 'Obtain the vendor’s audit-log and retention attestation.',
  },
  {
    id: 'PCI-2.2',
    framework: 'PCI_DSS_4_0_1',
    ref: 'Requirement 2.2',
    title: 'System components are configured securely',
    intent: 'No default or unnecessary services, banners or exposed interfaces.',
    refVerified: true,
    scope: 'partial',
    evidence: [
      checks(
        'No banners, reflected CORS or verbose errors',
        'misconfig.headers-tls-cors',
        'misconfig.error-hygiene',
      ),
      checks('Only documented API versions and paths are served', 'inventory.undocumented-paths'),
    ],
    limitation: 'Probes the external surface; host and OS hardening are not visible.',
  },
  {
    id: 'PCI-11.4',
    framework: 'PCI_DSS_4_0_1',
    ref: 'Requirement 11.3 / 11.4',
    title: 'Vulnerability scans and penetration tests are performed',
    intent: 'Regular internal/external scans and penetration tests by qualified parties.',
    refVerified: true,
    scope: 'out_of_scope',
    evidence: [],
    limitation:
      'This programme’s security suite verifies that specific defences hold. It is not an ASV scan or a penetration test and must not be presented as one.',
    howToCover:
      'Commission an ASV scan and a penetration test from a qualified provider; attach their reports.',
  },
  {
    id: 'PCI-12.10',
    framework: 'PCI_DSS_4_0_1',
    ref: 'Requirement 12.10',
    title: 'An incident-response plan exists and is exercised',
    intent: 'The organisation can detect, contain and report security incidents.',
    refVerified: true,
    scope: 'out_of_scope',
    evidence: [],
    limitation:
      'Process and people controls cannot be proven by API tests. (The safety guardrails and kill switch show tooling-side containment only.)',
    howToCover: 'Attach the incident-response plan and the latest exercise record.',
  },

  /* ── OWASP API Security Top 10 (2023) ───────────────────────────────── */
  {
    id: 'OWASP-API1',
    framework: 'OWASP_API_2023',
    ref: 'API1:2023',
    title: 'Broken Object Level Authorization',
    intent:
      'A caller can only reach objects that belong to them, and cannot tell whether others exist.',
    refVerified: true,
    scope: 'testable',
    evidence: [
      checks(
        'Cross-account reads are refused with no existence oracle',
        'bola.cross-account-access',
      ),
    ],
    limitation:
      'Probes payouts and transaction lists; every object type is not enumerated. Needs a second-account credential on a live target.',
  },
  {
    id: 'OWASP-API2',
    framework: 'OWASP_API_2023',
    ref: 'API2:2023',
    title: 'Broken Authentication',
    intent:
      'Authentication is robust: invalid credentials fail, tokens expire, errors do not enumerate accounts.',
    refVerified: true,
    scope: 'testable',
    evidence: [
      checks('Bogus clients and wrong secrets get no token', 'auth.bogus-client-rejected'),
      checks('Expired tokens are refused', 'auth.token-expiry-enforced'),
      checks('Invalid and tampered tokens are refused', 'auth.invalid-token-rejected'),
    ],
    limitation:
      'No brute-force or lockout testing is performed against live identity services (risk of locking real keys).',
  },
  {
    id: 'OWASP-API3',
    framework: 'OWASP_API_2023',
    ref: 'API3:2023',
    title: 'Broken Object Property Level Authorization',
    intent:
      'Clients cannot set server-owned properties, and responses expose only intended properties.',
    refVerified: true,
    scope: 'testable',
    evidence: [
      checks('Mass assignment is refused', 'bopla.mass-assignment-rejected'),
      checks('Responses are an explicit allow-list with no internals', 'bopla.response-allowlist'),
    ],
    limitation: 'Probes create-payout and read responses.',
  },
  {
    id: 'OWASP-API4',
    framework: 'OWASP_API_2023',
    ref: 'API4:2023',
    title: 'Unrestricted Resource Consumption',
    intent:
      'Request rates, sizes and page sizes are bounded, and the service recovers from bursts.',
    refVerified: true,
    scope: 'testable',
    evidence: [
      checks('Bursts get 429 + Retry-After and recovery', 'resource.rate-limit-behaviour'),
      checks('Oversized, nested and extreme inputs are refused', 'resource.payload-limits'),
      checks('Page size is capped', 'resource.pagination-caps'),
      load('The service holds up under sustained load', 'LOAD', 'SOAK'),
    ],
    limitation:
      'Live rate-limit thresholds are undocumented by the vendor; live runs report whether a limit engaged, not what it should be.',
  },
  {
    id: 'OWASP-API5',
    framework: 'OWASP_API_2023',
    ref: 'API5:2023',
    title: 'Broken Function Level Authorization',
    intent: 'Each credential can invoke only the functions its permissions allow.',
    refVerified: true,
    scope: 'testable',
    evidence: [
      checks('A read-only credential is refused on money functions', 'authz.permission-enforced'),
    ],
    limitation: 'Needs a read-only key on a live target; simulator-only otherwise.',
  },
  {
    id: 'OWASP-API6',
    framework: 'OWASP_API_2023',
    ref: 'API6:2023',
    title: 'Unrestricted Access to Sensitive Business Flows',
    intent: 'Automated repetition of valuable flows (payments, payouts) is bounded.',
    refVerified: true,
    scope: 'partial',
    evidence: [
      checks('Repeated payouts stop at configured limits', 'flows.limits-bound-automation'),
    ],
    limitation:
      'Velocity is exercised on the simulator; on the live sandbox only the presence of limits is read (to avoid spending allowance).',
  },
  {
    id: 'OWASP-API7',
    framework: 'OWASP_API_2023',
    ref: 'API7:2023',
    title: 'Server Side Request Forgery',
    intent: 'URL-bearing inputs cannot be used to reach internal systems.',
    refVerified: true,
    scope: 'partial',
    evidence: [checks('Internal and non-web URLs are refused', 'ssrf.url-fields')],
    limitation:
      'Only the hosted-checkout URL fields are probed, and the checkout feature may be disabled on a target.',
  },
  {
    id: 'OWASP-API8',
    framework: 'OWASP_API_2023',
    ref: 'API8:2023',
    title: 'Security Misconfiguration',
    intent: 'Hardened headers, TLS, errors, methods and no debug surface.',
    refVerified: true,
    scope: 'testable',
    evidence: [
      checks('Headers, CORS and TLS are hardened', 'misconfig.headers-tls-cors'),
      checks('Errors are generic', 'misconfig.error-hygiene'),
      checks('Methods and debug paths are not exposed', 'misconfig.methods-and-debug-paths'),
      checks('Hostile strings are inert', 'input.hostile-strings-inert'),
    ],
    limitation:
      'External view only: host, operating-system and infrastructure configuration are not visible from the API.',
  },
  {
    id: 'OWASP-API9',
    framework: 'OWASP_API_2023',
    ref: 'API9:2023',
    title: 'Improper Inventory Management',
    intent: 'Only documented, current API versions and paths are served.',
    refVerified: true,
    scope: 'partial',
    evidence: [checks('Legacy and shadow paths are not served', 'inventory.undocumented-paths')],
    limitation: 'A fixed list of probable paths — it cannot discover every undocumented endpoint.',
  },
  {
    id: 'OWASP-API10',
    framework: 'OWASP_API_2023',
    ref: 'API10:2023',
    title: 'Unsafe Consumption of APIs',
    intent:
      'Data from third-party APIs is validated, and inbound webhooks are authenticated and de-duplicated.',
    refVerified: true,
    scope: 'testable',
    evidence: [
      checks('Vendor responses match the documented contract', 'consumption.schema-conformance'),
      checks(
        'Webhooks are authenticated, de-duplicated and order-safe',
        'webhook.signature-duplicates-order',
      ),
      checks('The real sandbox delivers authentic webhooks', 'webhook.live-delivery'),
      checks('Webhook retries keep the same id', 'webhook.retry-keeps-id'),
    ],
    limitation:
      'Webhook checks need the simulator or a public receiver; contract conformance is checked on the endpoints probed.',
  },

  /* ── Bank of Ghana (themes; clauses to be supplied) ─────────────────── */
  {
    id: 'BOG-INTEGRITY',
    framework: 'BOG',
    ref: 'Funds safeguarding and transaction integrity (theme)',
    title: 'Customer funds are safeguarded and every transaction is traceable and reconcilable',
    intent:
      'No money is lost, created or double-spent; balances reconcile to the ledger; failed payments are refunded.',
    refVerified: false,
    scope: 'testable',
    evidence: [
      checks('Failed payouts are refunded in full', 'payout.failure-refunds-wallet'),
      checks(
        'Payments credit/debit the wallet exactly',
        'payout.fixture-delivered',
        'collection.fixture-outcomes',
      ),
      checks('List and detail agree', 'status.list-matches-detail'),
      checks('The ledger reconciles exactly', 'sim.ledger-reconciliation'),
      checks('Concurrent payouts cannot overspend', 'sim.concurrent-overspend'),
    ],
    limitation:
      'Ledger reconciliation and race checks run on the simulator; against the live sandbox only API-observable balances are compared.',
  },
  {
    id: 'BOG-DUPLICATE',
    framework: 'BOG',
    ref: 'Duplicate and erroneous transaction prevention (theme)',
    title: 'Duplicate and erroneous transactions are prevented',
    intent: 'A retry, a double-click or a timeout never results in a second payment.',
    refVerified: false,
    scope: 'testable',
    evidence: [
      checks('Same key + same body applies once', 'idem.sequential-replay'),
      checks('Concurrent twins apply once', 'idem.concurrent-twins'),
      checks('Key reuse with a different body is refused', 'idem.key-reuse-different-body'),
      checks('A reference is paid once', 'reference.duplicate-rules'),
      checks('Batches pay each item once', 'batch.items-and-retry'),
      checks('A timed-out request is not applied twice on retry', 'sim.ambiguous-timeout-retry'),
    ],
    limitation:
      'Idempotency retention windows are undocumented by the vendor, so long-delay replays are not tested.',
  },
  {
    id: 'BOG-RESILIENCE',
    framework: 'BOG',
    ref: 'Operational resilience and availability (theme)',
    title: 'The payment service stays available and performs at expected peak load',
    intent:
      'The service meets agreed response-time and error objectives under normal and surge load.',
    refVerified: false,
    scope: 'testable',
    evidence: [
      load('Steady-state load meets its objectives', 'LOAD', 'SOAK'),
      load('A sudden surge is survived', 'SPIKE'),
    ],
    limitation:
      'Results describe the tested environment at the tested volumes; the sandbox is not production capacity.',
  },
  {
    id: 'BOG-CAPACITY',
    framework: 'BOG',
    ref: 'Capacity planning (theme)',
    title: 'Capacity limits are known and tested',
    intent: 'The point where the service degrades is measured, not assumed.',
    refVerified: false,
    scope: 'testable',
    evidence: [load('The breaking point has been measured', 'BREAKPOINT', 'STRESS')],
    limitation: 'Meaningful only against the real service at comparable sizing.',
  },
  {
    id: 'BOG-ACCESS',
    framework: 'BOG',
    ref: 'Access control to systems and customer data (theme)',
    title: 'Access to systems and customer data is controlled',
    intent: 'Authentication, authorisation and data isolation hold.',
    refVerified: false,
    scope: 'testable',
    evidence: [
      checks('Cross-account access is refused', 'bola.cross-account-access'),
      checks(
        'Credentials are enforced',
        'auth.invalid-token-rejected',
        'auth.bogus-client-rejected',
      ),
      checks('Permissions are enforced', 'authz.permission-enforced'),
    ],
    limitation: 'API credentials only.',
  },
  {
    id: 'BOG-CYBER',
    framework: 'BOG',
    ref: 'Cyber and information-security testing (theme)',
    title: 'Cyber-security controls are tested regularly',
    intent: 'Security controls are verified on a recurring basis with retained evidence.',
    refVerified: false,
    scope: 'partial',
    evidence: [
      checks(
        'Security suite: misconfiguration, headers and errors',
        'misconfig.headers-tls-cors',
        'misconfig.error-hygiene',
        'misconfig.methods-and-debug-paths',
      ),
      checks('Injection robustness', 'input.hostile-strings-inert'),
    ],
    limitation:
      'Not a penetration test. Evidence freshness is shown so recurrence can be demonstrated.',
    howToCover: 'Also keep the independent penetration-test report (see PCI 11.4).',
  },
  {
    id: 'BOG-THIRDPARTY',
    framework: 'BOG',
    ref: 'Third-party and vendor integration risk (theme)',
    title: 'Vendor integration risk is controlled',
    intent:
      'We detect vendor contract drift, handle vendor timeouts safely and authenticate vendor callbacks.',
    refVerified: false,
    scope: 'testable',
    evidence: [
      checks('Vendor responses match the documented contract', 'consumption.schema-conformance'),
      checks('Webhook authenticity and ordering', 'webhook.signature-duplicates-order'),
      checks('The real sandbox delivers authentic webhooks', 'webhook.live-delivery'),
      checks('Vendor timeouts are retried safely', 'sim.ambiguous-timeout-retry'),
    ],
    limitation: 'Does not assess the vendor’s own controls.',
  },
  {
    id: 'BOG-VELOCITY',
    framework: 'BOG',
    ref: 'Transaction limits and velocity controls (theme)',
    title: 'Transaction limits and velocity controls work',
    intent: 'Per-transaction and daily limits cap automated or fraudulent repetition.',
    refVerified: false,
    scope: 'partial',
    evidence: [checks('Repeated payouts stop at limits', 'flows.limits-bound-automation')],
    limitation:
      'This is not an AML/fraud-monitoring assessment; it shows limits are enforced, not that suspicious patterns are detected.',
  },
  {
    id: 'BOG-INCIDENT',
    framework: 'BOG',
    ref: 'Incident management and reporting (theme)',
    title: 'Incidents are detected, managed and reported',
    intent:
      'Operational and security incidents are handled and reported to the regulator as required.',
    refVerified: false,
    scope: 'out_of_scope',
    evidence: [],
    limitation:
      'A process obligation. The monitor’s incident engine and these tests’ guardrails are supporting tooling only.',
    howToCover: 'Attach the incident-management procedure and the regulator-reporting runbook.',
  },

  /* ── Ghana Data Protection Act (themes; sections to be supplied) ────── */
  {
    id: 'DPA-SECURITY',
    framework: 'GH_DPA_843',
    ref: 'Security safeguards (theme)',
    title: 'Appropriate technical measures protect personal data',
    intent: 'Personal data is protected against unauthorised access and disclosure.',
    refVerified: false,
    scope: 'partial',
    evidence: [
      checks('Data is isolated between accounts', 'bola.cross-account-access'),
      checks('Errors do not disclose internals', 'misconfig.error-hygiene'),
      checks('Authentication is enforced', 'auth.invalid-token-rejected'),
    ],
    limitation:
      'Technical API controls only; organisational measures and breach-notification process are outside this evidence.',
  },
  {
    id: 'DPA-MINIMISATION',
    framework: 'GH_DPA_843',
    ref: 'Data minimisation (theme)',
    title: 'Only the data that is needed is collected and exposed',
    intent: 'Responses and test data contain no more personal data than necessary.',
    refVerified: false,
    scope: 'partial',
    evidence: [checks('Responses expose an allow-list of fields', 'bopla.response-allowlist')],
    limitation:
      'Test data in this programme is synthetic by rule; the vendor’s production data handling is not assessed.',
  },
];

export const CONTROL_BY_ID = new Map(CONTROLS.map((c) => [c.id, c]));

export function frameworkControls(f: Framework): Control[] {
  return CONTROLS.filter((c) => c.framework === f);
}
