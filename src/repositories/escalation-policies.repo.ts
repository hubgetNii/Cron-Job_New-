import { z } from 'zod';
import { query } from '../lib/db.js';
import { ALERT_CHANNELS } from '../domain/enums.js';
import type { AlertChannel } from '../domain/enums.js';

export const escalationTierSchema = z.object({
  delayMinutes: z.number().int().min(0),
  channel: z.enum(ALERT_CHANNELS),
  recipients: z.array(z.string().min(1)).min(1),
  /** e.g. "is_money_moving == true" — only tier 4 uses this today. */
  condition: z.enum(['always', 'is_money_moving']).default('always'),
});
export type EscalationTier = z.infer<typeof escalationTierSchema>;

export const escalationTiersSchema = z.array(escalationTierSchema);

export interface EscalationPolicy {
  id: string;
  name: string;
  description: string | null;
  tiers: EscalationTier[];
  createdAt: Date;
  updatedAt: Date;
}

interface Row {
  id: string;
  name: string;
  description: string | null;
  tiers: unknown;
  created_at: Date;
  updated_at: Date;
}

function toDomain(r: Row): EscalationPolicy {
  const parsed = escalationTiersSchema.safeParse(r.tiers);
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    tiers: parsed.success ? parsed.data : [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function createEscalationPolicy(input: {
  name: string;
  description?: string | null;
  tiers: EscalationTier[];
}): Promise<EscalationPolicy> {
  const { rows } = await query<Row>(
    `INSERT INTO escalation_policies (name, description, tiers)
     VALUES ($1, $2, $3)
     RETURNING id, name, description, tiers, created_at, updated_at`,
    [input.name, input.description ?? null, JSON.stringify(input.tiers)],
  );
  return toDomain(rows[0]!);
}

export async function updateEscalationPolicy(
  id: string,
  input: { name?: string; description?: string | null; tiers?: EscalationTier[] },
): Promise<EscalationPolicy | null> {
  const { rows } = await query<Row>(
    `UPDATE escalation_policies
     SET name = COALESCE($2, name),
         description = COALESCE($3, description),
         tiers = COALESCE($4, tiers)
     WHERE id = $1
     RETURNING id, name, description, tiers, created_at, updated_at`,
    [
      id,
      input.name ?? null,
      input.description ?? null,
      input.tiers ? JSON.stringify(input.tiers) : null,
    ],
  );
  return rows[0] ? toDomain(rows[0]) : null;
}

export async function getEscalationPolicy(id: string): Promise<EscalationPolicy | null> {
  const { rows } = await query<Row>(
    `SELECT id, name, description, tiers, created_at, updated_at FROM escalation_policies WHERE id = $1`,
    [id],
  );
  return rows[0] ? toDomain(rows[0]) : null;
}

export async function listEscalationPolicies(): Promise<EscalationPolicy[]> {
  const { rows } = await query<Row>(
    `SELECT id, name, description, tiers, created_at, updated_at FROM escalation_policies ORDER BY name`,
  );
  return rows.map(toDomain);
}

export interface OnCallEntry {
  id: string;
  teamId: string;
  userId: string;
  startsAt: Date;
  endsAt: Date;
}

export async function listOnCallSchedules(teamId?: string): Promise<OnCallEntry[]> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id, team_id, user_id, starts_at, ends_at FROM on_call_schedules
     ${teamId ? 'WHERE team_id = $1' : ''}
     ORDER BY starts_at DESC LIMIT 200`,
    teamId ? [teamId] : [],
  );
  return rows.map((r) => ({
    id: r['id'] as string,
    teamId: r['team_id'] as string,
    userId: r['user_id'] as string,
    startsAt: r['starts_at'] as Date,
    endsAt: r['ends_at'] as Date,
  }));
}

export type { AlertChannel };
