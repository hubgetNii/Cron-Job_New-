-- Up Migration
-- Phase 12 (Observability): full request/response trace for every health check
-- (spec §3–5). One row per health_check_results row.
--
-- Everything in the *_masked columns is safe to show any authorised operator:
-- Authorization, API keys, tokens, PINs, CVV, card numbers and other sensitive
-- fields are replaced with ***MASKED*** before insert (src/lib/masking.ts).
--
-- raw_encrypted holds the true (unmasked) request+response, sealed with the
-- credential cipher. It is decrypted only on an explicit ADMIN "reveal", and
-- every reveal writes an audit_logs row (action = observability.trace.reveal).

CREATE TABLE health_check_traces (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  check_id                 uuid NOT NULL REFERENCES health_check_results (id) ON DELETE CASCADE,
  api_id                   uuid NOT NULL REFERENCES monitored_apis (id) ON DELETE CASCADE,
  job_run_id               text,
  request_id               text NOT NULL,
  correlation_id           text NOT NULL,
  checked_at               timestamptz NOT NULL DEFAULT now(),

  request_method           http_method NOT NULL,
  request_url_masked       text NOT NULL,
  request_headers_masked   jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_body_masked      text,

  response_status          integer,
  response_headers_masked  jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_body_masked     text,
  response_bytes           integer,
  response_content_type    text,
  response_time_ms         integer,

  attempts                 integer NOT NULL DEFAULT 1,
  health_status            health_status NOT NULL,
  failure_type             check_failure_type,

  -- { v, alg, keyId, iv, ciphertext, tag } — see src/lib/crypto/credential-cipher.ts
  raw_encrypted            jsonb,

  created_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT health_check_traces_check_unique UNIQUE (check_id),
  CONSTRAINT health_check_traces_status_range
    CHECK (response_status IS NULL OR (response_status BETWEEN 100 AND 599))
);

CREATE INDEX health_check_traces_api_checked_idx
  ON health_check_traces (api_id, checked_at DESC);
CREATE INDEX health_check_traces_checked_at_idx
  ON health_check_traces (checked_at DESC);
CREATE INDEX health_check_traces_request_id_idx
  ON health_check_traces (request_id);
CREATE INDEX health_check_traces_correlation_id_idx
  ON health_check_traces (correlation_id);
CREATE INDEX health_check_traces_status_idx
  ON health_check_traces (response_status);
CREATE INDEX health_check_traces_failure_type_idx
  ON health_check_traces (failure_type) WHERE failure_type IS NOT NULL;

-- Down Migration
DROP TABLE IF EXISTS health_check_traces;
