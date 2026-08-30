import { z } from 'zod';
import {
  AUTH_TYPES,
  ENDPOINT_CLASSES,
  ENVIRONMENTS,
  HTTP_METHODS,
  SEVERITIES,
} from '../../domain/enums.js';

const headerRecord = z.record(z.string(), z.string());

const validationRule: z.ZodType = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('status'), equals: z.number().int() }),
    z.object({ type: z.literal('json_equals'), path: z.string().min(1), equals: z.unknown() }),
    z.object({ type: z.literal('json_path_equals'), path: z.string().min(1), equals: z.unknown() }),
    z.object({
      type: z.literal('contains'),
      value: z.string().min(1),
      negate: z.boolean().optional(),
    }),
    z.object({
      type: z.literal('numeric'),
      path: z.string().min(1),
      op: z.enum(['<', '<=', '>', '>=', '==']),
      value: z.number(),
    }),
    z.object({ type: z.literal('json_schema'), schema: z.record(z.string(), z.unknown()) }),
    z.object({
      type: z.literal('composite'),
      mode: z.enum(['all', 'any']),
      rules: z.array(validationRule).min(1),
    }),
  ]),
);

const retryConfig = z
  .object({
    count: z.number().int().min(0).max(10),
    baseDelayMs: z.number().int().min(0).max(60_000),
    backoffMultiplier: z.number().min(1).max(10),
    maxDelayMs: z.number().int().min(0).max(120_000),
  })
  .partial();

export const createTargetSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  environment: z.enum(ENVIRONMENTS).optional(),
  endpointClass: z.enum(ENDPOINT_CLASSES),
  severityDefault: z.enum(SEVERITIES).optional(),
  isMoneyMoving: z.boolean().optional(),
  url: z.string().url().max(2048),
  method: z.enum(HTTP_METHODS).optional(),
  authenticationType: z.enum(AUTH_TYPES).optional(),
  credentials: z.record(z.string(), z.string()).nullish(),
  headers: headerRecord.optional(),
  requestBody: z.unknown().optional(),
  expectedStatus: z.number().int().min(100).max(599).nullish(),
  expectedResponse: validationRule.nullish(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  frequencyCron: z.string().min(1).max(120),
  retry: retryConfig.optional(),
  slaTargetPercent: z.number().gt(0).max(100).optional(),
  ownerId: z.string().uuid().nullish(),
  teamId: z.string().uuid().nullish(),
  escalationPolicyId: z.string().uuid().nullish(),
  tags: z.array(z.string().min(1).max(64)).max(50).optional(),
  isActive: z.boolean().optional(),
  allowPrivateNetwork: z.boolean().optional(),
});

export const updateTargetSchema = createTargetSchema.partial();

export type CreateTargetPayload = z.infer<typeof createTargetSchema>;
export type UpdateTargetPayload = z.infer<typeof updateTargetSchema>;
