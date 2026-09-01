import { describe, expect, it } from 'vitest';
import {
  availabilitySubScore,
  computeHealthScore,
  dependencySubScore,
  errorRateSubScore,
  latencySubScore,
  parseWeights,
  DEFAULT_SCORE_WEIGHTS,
} from './health-score.js';

describe('parseWeights', () => {
  it('parses a valid list', () => {
    expect(parseWeights('40,25,20,15')).toEqual(DEFAULT_SCORE_WEIGHTS);
    expect(parseWeights('50,20,20,10').availability).toBe(50);
  });
  it('falls back on garbage', () => {
    expect(parseWeights('nope')).toEqual(DEFAULT_SCORE_WEIGHTS);
    expect(parseWeights('1,2,3')).toEqual(DEFAULT_SCORE_WEIGHTS);
  });
});

describe('sub-score curves', () => {
  it('availability passes uptime through', () => {
    expect(availabilitySubScore(98.5)).toBe(98.5);
    expect(availabilitySubScore(null)).toBeNull();
  });
  it('latency is 100 below normal, 0 above critical, linear between', () => {
    expect(latencySubScore(300, 500, 2000)).toBe(100);
    expect(latencySubScore(2500, 500, 2000)).toBe(0);
    expect(latencySubScore(1250, 500, 2000)).toBeCloseTo(50, 0);
  });
  it('error rate is quadratic', () => {
    expect(errorRateSubScore(0)).toBe(100);
    expect(errorRateSubScore(12)).toBe(0);
    expect(errorRateSubScore(2)).toBeGreaterThan(60);
  });
  it('dependency penalises dependency-category open incidents hardest', () => {
    expect(
      dependencySubScore({
        openIncident: true,
        openIncidentCategory: 'DATABASE',
        dependencyIncidents24h: 0,
        flapping24h: 0,
      }),
    ).toBe(45);
    expect(
      dependencySubScore({
        openIncident: false,
        openIncidentCategory: null,
        dependencyIncidents24h: 0,
        flapping24h: 0,
      }),
    ).toBe(100);
  });
});

describe('computeHealthScore', () => {
  it('weighted mean over present sub-scores', () => {
    const r = computeHealthScore(
      { availability: 98, latency: 76, errorRate: 94, dependencyHealth: 71 },
      DEFAULT_SCORE_WEIGHTS,
    );
    // 98*.4 + 76*.25 + 94*.2 + 71*.15 = 39.2 + 19 + 18.8 + 10.65 = 87.65
    expect(r.score).toBeCloseTo(87.7, 0);
    expect(r.band).toBe('HEALTHY');
  });
  it('renormalises weights when a sub-score is missing', () => {
    const r = computeHealthScore(
      { availability: 100, latency: null, errorRate: 100, dependencyHealth: 100 },
      DEFAULT_SCORE_WEIGHTS,
    );
    expect(r.score).toBe(100);
  });
  it('NO_DATA when nothing is present', () => {
    const r = computeHealthScore(
      { availability: null, latency: null, errorRate: null, dependencyHealth: null },
      DEFAULT_SCORE_WEIGHTS,
    );
    expect(r.score).toBeNull();
    expect(r.band).toBe('NO_DATA');
  });
});
