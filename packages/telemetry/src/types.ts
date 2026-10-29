export const SEVERITIES = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type Severity = (typeof SEVERITIES)[number];
/** 0 (trace) … 5 (fatal): numeric so "error and above" is a simple range filter. */
export const levelOf = (s: Severity): number => SEVERITIES.indexOf(s);

export interface KV { k: string; v: string }

/** One log record after normalization and redaction, before tenant fields are attached. Absent facts are null, never invented. */
export interface LogDraft {
  ts: Date;
  /** Where the timestamp came from: the event itself, the observer, or (when neither existed) our receive time. */
  tsSource: 'event' | 'observed' | 'received';
  /** Set when the client clock was clearly wrong and we replaced it. */
  tsAdjusted: 'future' | null;
  severity: Severity;
  level: number;
  severityText: string | null;
  message: string;
  messageTruncated: boolean;
  service: string | null;
  serviceVersion: string | null;
  deployment: string | null;
  host: string | null;
  container: string | null;
  traceId: string | null;
  spanId: string | null;
  requestId: string | null;
  httpMethod: string | null;
  httpRoute: string | null;
  httpStatus: number | null;
  durationMs: number | null;
  errorType: string | null;
  exceptionMessage: string | null;
  stack: string | null;
  scope: string | null;
  source: 'otlp' | 'json';
  attrs: KV[];
  resource: KV[];
  attrsTruncated: boolean;
  /** How many values were masked by redaction in this record. */
  redactions: number;
}

export interface MapResult {
  records: LogDraft[];
  /** Records that could not be accepted (malformed, too old, over limits) — reported to the client, never silently dropped. */
  rejected: number;
  errors: string[];
}

export interface Limits {
  maxRecordsPerRequest: number;
  maxMessageBytes: number;
  maxAttrs: number;
  maxAttrKey: number;
  maxAttrValue: number;
  /** Records older than this are rejected (they would be expired immediately). */
  maxAgeMs: number;
  /** Timestamps further in the future than this are replaced by the receive time. */
  maxFutureMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxRecordsPerRequest: 5_000,
  maxMessageBytes: 32 * 1024,
  maxAttrs: 100,
  maxAttrKey: 128,
  maxAttrValue: 4 * 1024,
  maxAgeMs: 30 * 24 * 3600_000,
  maxFutureMs: 5 * 60_000,
};

export interface RedactionPolicy {
  enabled: boolean;
  /** Extra attribute names (case-insensitive) whose values are always masked. */
  extraKeys: string[];
}
