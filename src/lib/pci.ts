/**
 * Removes anything that looks like PCI-scoped data (primary account numbers,
 * long digit runs) before a response body is stored or logged (spec Rule 20).
 * This is a blunt instrument on purpose: the platform never needs the digits,
 * so over-redaction is the safe failure mode.
 */
export function scrubPci(text: string): string {
  return (
    text
      // 13–19 digit runs, optionally separated by spaces or dashes (card numbers)
      .replace(/\b(?:\d[ -]?){13,19}\b/g, '[REDACTED_PAN]')
      // any remaining run of 10+ digits (account numbers, etc.)
      .replace(/\b\d{10,}\b/g, '[REDACTED_NUMBER]')
  );
}

const MAX_SAMPLE_BYTES = 4096;

export function responseSample(text: string): string {
  const scrubbed = scrubPci(text);
  return scrubbed.length > MAX_SAMPLE_BYTES
    ? `${scrubbed.slice(0, MAX_SAMPLE_BYTES)}…[truncated]`
    : scrubbed;
}
