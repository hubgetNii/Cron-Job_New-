import { describe, expect, it } from 'vitest';
import { referencesFor } from './harvest.service.js';
import { runSalt } from './run.service.js';

const RUN = '1234abcd-0000-4000-8000-000000000000';

describe('referencesFor', () => {
  it('rebuilds exactly the references the k6 script generates', () => {
    const { references, caveat } = referencesFor(RUN, 3, 100, 0);
    expect(references).toEqual([0, 1, 2].map((n) => `LT-${runSalt(RUN)}-${n}`));
    expect(caveat).toBeNull();
  });

  it('is capped by the limit and the hard maximum', () => {
    expect(referencesFor(RUN, 10, 4, 0).references).toHaveLength(4);
    expect(referencesFor(RUN, 1_000_000, 1_000_000, 0).references).toHaveLength(2000);
    expect(referencesFor(RUN, 0, 10, 0).references).toHaveLength(0);
  });

  it('warns when the run had failures, because those references may not exist', () => {
    expect(referencesFor(RUN, 10, 10, 0.25).caveat).toContain('25.0%');
  });
});
