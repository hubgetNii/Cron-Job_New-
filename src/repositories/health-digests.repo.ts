import { query } from '../lib/db.js';

export type SystemHealthLevel = 'HEALTHY' | 'DEGRADED' | 'CRITICAL';

export interface AffectedService {
  name: string;
  status: string;
  endpointClass: string;
  isMoneyMoving: boolean;
}

export interface HealthDigest {
  id: string;
  generatedAt: Date;
  overallLevel: SystemHealthLevel;
  previousLevel: SystemHealthLevel | null;
  totalServices: number;
  healthyServices: number;
  degradedServices: number;
  downServices: number;
  affected: AffectedService[];
  smsSent: boolean;
  smsRecipients: number;
  reason: string;
  nextCheckAt: Date | null;
}

const COLUMNS = `
  id, generated_at, overall_level, previous_level, total_services, healthy_services,
  degraded_services, down_services, affected, sms_sent, sms_recipients, reason, next_check_at`;

function toDomain(r: Record<string, unknown>): HealthDigest {
  return {
    id: r['id'] as string,
    generatedAt: r['generated_at'] as Date,
    overallLevel: r['overall_level'] as SystemHealthLevel,
    previousLevel: (r['previous_level'] as SystemHealthLevel | null) ?? null,
    totalServices: Number(r['total_services']),
    healthyServices: Number(r['healthy_services']),
    degradedServices: Number(r['degraded_services']),
    downServices: Number(r['down_services']),
    affected: (r['affected'] as AffectedService[] | null) ?? [],
    smsSent: r['sms_sent'] as boolean,
    smsRecipients: Number(r['sms_recipients']),
    reason: r['reason'] as string,
    nextCheckAt: (r['next_check_at'] as Date | null) ?? null,
  };
}

export async function latestDigest(): Promise<HealthDigest | null> {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM health_digests ORDER BY generated_at DESC LIMIT 1`,
  );
  return rows[0] ? toDomain(rows[0]) : null;
}

export async function listDigests(limit = 50): Promise<HealthDigest[]> {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM health_digests ORDER BY generated_at DESC LIMIT $1`,
    [Math.min(limit, 200)],
  );
  return (rows as Array<Record<string, unknown>>).map(toDomain);
}

export async function saveDigest(input: {
  overallLevel: SystemHealthLevel;
  previousLevel: SystemHealthLevel | null;
  totalServices: number;
  healthyServices: number;
  degradedServices: number;
  downServices: number;
  affected: AffectedService[];
  smsSent: boolean;
  smsRecipients: number;
  reason: string;
  nextCheckAt: Date | null;
}): Promise<HealthDigest> {
  const { rows } = await query(
    `INSERT INTO health_digests
       (overall_level, previous_level, total_services, healthy_services, degraded_services,
        down_services, affected, sms_sent, sms_recipients, reason, next_check_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${COLUMNS}`,
    [
      input.overallLevel,
      input.previousLevel,
      input.totalServices,
      input.healthyServices,
      input.degradedServices,
      input.downServices,
      JSON.stringify(input.affected),
      input.smsSent,
      input.smsRecipients,
      input.reason,
      input.nextCheckAt,
    ],
  );
  return toDomain(rows[0]!);
}
