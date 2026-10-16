import { describe, expect, it } from 'vitest';
import { CHECK_IDS } from '../correctness/checks.js';
import { SECURITY_CHECK_IDS } from '../correctness/security.js';
import {
  CONTROLS,
  CONTROL_BY_ID,
  FRAMEWORKS,
  LIBRARY_VERSION,
  frameworkControls,
  type Framework,
} from './controls.js';

const ALL_CHECKS = new Set([...CHECK_IDS, ...SECURITY_CHECK_IDS]);

describe('control library integrity', () => {
  it('has unique ids and a versioned, draft label', () => {
    expect(new Set(CONTROLS.map((c) => c.id)).size).toBe(CONTROLS.length);
    expect(CONTROL_BY_ID.size).toBe(CONTROLS.length);
    expect(LIBRARY_VERSION).toMatch(/draft/);
  });

  it('only references checks that exist (a typo would silently show "not tested")', () => {
    for (const c of CONTROLS) {
      for (const rule of c.evidence) {
        if (rule.kind === 'checks')
          for (const id of rule.checkIds) expect(ALL_CHECKS.has(id), `${c.id} → ${id}`).toBe(true);
      }
    }
  });

  it('every check is used by at least one control, so no test evidence is orphaned', () => {
    const used = new Set(
      CONTROLS.flatMap((c) => c.evidence.flatMap((r) => (r.kind === 'checks' ? r.checkIds : []))),
    );
    const orphans = [...ALL_CHECKS].filter((id) => !used.has(id));
    expect(orphans).toEqual([]);
  });

  it('covers all ten OWASP API categories, each with direct evidence', () => {
    const owasp = frameworkControls('OWASP_API_2023');
    expect(owasp.map((c) => c.ref).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `API${i + 1}:2023`).sort(),
    );
    for (const c of owasp) expect(c.evidence.length, c.id).toBeGreaterThan(0);
  });

  it('out-of-scope controls carry no evidence rules but say how to cover them', () => {
    for (const c of CONTROLS.filter((x) => x.scope === 'out_of_scope')) {
      expect(c.evidence, c.id).toEqual([]);
      expect(c.howToCover, c.id).toBeTruthy();
    }
    for (const c of CONTROLS.filter((x) => x.scope !== 'out_of_scope'))
      expect(c.evidence.length, c.id).toBeGreaterThan(0);
  });

  it('never presents unverified regulator references as verified', () => {
    for (const c of CONTROLS) {
      if (c.framework === 'BOG' || c.framework === 'GH_DPA_843')
        expect(c.refVerified, c.id).toBe(false);
      else expect(c.refVerified, c.id).toBe(true);
    }
    for (const f of ['BOG', 'GH_DPA_843'] as Framework[])
      expect(FRAMEWORKS[f].note).toMatch(/NOT yet verified|NOT verified|supply/i);
  });

  it('states a limitation for every control and never claims certification', () => {
    for (const c of CONTROLS) {
      expect(c.limitation.length, c.id).toBeGreaterThan(20);
      expect(`${c.title} ${c.intent}`.toLowerCase()).not.toMatch(/\bcertif(y|ied|ication)\b/);
    }
    expect(CONTROL_BY_ID.get('PCI-11.4')!.limitation).toMatch(
      /not an ASV scan or a penetration test/,
    );
  });

  it('PCI penetration testing and incident response are out of scope, not claimed', () => {
    expect(CONTROL_BY_ID.get('PCI-11.4')!.scope).toBe('out_of_scope');
    expect(CONTROL_BY_ID.get('PCI-12.10')!.scope).toBe('out_of_scope');
    expect(CONTROL_BY_ID.get('BOG-INCIDENT')!.scope).toBe('out_of_scope');
  });
});
