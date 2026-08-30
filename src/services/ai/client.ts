import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type * as z from 'zod/v4';
import { env } from '../../config/index.js';
import { componentLogger } from '../../lib/logger.js';
import { ServiceUnavailableError } from '../../lib/errors.js';

const log = componentLogger('ai');

/**
 * The seam the AI services call through. The real implementation uses the
 * Anthropic SDK's structured-output helper; tests inject a fake so no key and
 * no network are needed. AI is ADVISORY only — this client has no write path
 * to targets, incidents or alerts (see vault: "AI Allowed Uses and Guardrails").
 */
export interface AiClient {
  readonly model: string;
  /** Returns a value validated against `schema` (the model reports its own confidence in-band). */
  analyze<S extends z.ZodType>(schema: S, system: string, user: string): Promise<z.output<S>>;
}

export function aiConfigured(): boolean {
  return env().AI_ENABLED && Boolean(env().ANTHROPIC_API_KEY);
}

export function requireAi(): void {
  if (!aiConfigured()) {
    throw new ServiceUnavailableError(
      'AI features are not configured (set ANTHROPIC_API_KEY, AI_ENABLED=true)',
    );
  }
}

class AnthropicAiClient implements AiClient {
  private readonly anthropic: Anthropic;
  readonly model: string;

  constructor() {
    this.anthropic = new Anthropic({ apiKey: env().ANTHROPIC_API_KEY, maxRetries: 2 });
    this.model = env().AI_MODEL;
  }

  async analyze<S extends z.ZodType>(
    schema: S,
    system: string,
    user: string,
  ): Promise<z.output<S>> {
    try {
      const response = await this.anthropic.messages.parse({
        model: this.model,
        max_tokens: 4096,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: { format: zodOutputFormat(schema) },
      });
      if (response.parsed_output == null) {
        throw new Error(`AI returned no parseable output (stop_reason: ${response.stop_reason})`);
      }
      return response.parsed_output;
    } catch (err) {
      log.error({ err, model: this.model }, 'AI analyze call failed');
      throw new ServiceUnavailableError('AI analysis failed — see logs');
    }
  }
}

let client: AiClient | undefined;

export function getAiClient(): AiClient {
  // An injected client (tests) bypasses the key/enabled check by design.
  if (client) return client;
  requireAi();
  client = new AnthropicAiClient();
  return client;
}

/** Test seam. */
export function setAiClient(fake: AiClient | undefined): void {
  client = fake;
}
