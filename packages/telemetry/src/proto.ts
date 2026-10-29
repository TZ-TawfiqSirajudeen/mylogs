import protobuf from 'protobufjs';

/**
 * OTLP wire format for logs, traces and metrics (opentelemetry-proto v1). Defined here because the SDK transformer packages only ENCODE
 * (they ship no decoder), so the messages below are transcribed from the published .proto files.
 * Field numbers follow the published .proto files; compatibility is verified against the real OpenTelemetry JS
 * OTLP/proto exporter in the sample-app end-to-end test.
 */
const PROTO = `
syntax = "proto3";
package nexus.otlp;

message AnyValue {
  oneof value {
    string string_value = 1;
    bool bool_value = 2;
    int64 int_value = 3;
    double double_value = 4;
    ArrayValue array_value = 5;
    KeyValueList kvlist_value = 6;
    bytes bytes_value = 7;
  }
}
message ArrayValue { repeated AnyValue values = 1; }
message KeyValueList { repeated KeyValue values = 1; }
message KeyValue { string key = 1; AnyValue value = 2; }
message InstrumentationScope { string name = 1; string version = 2; repeated KeyValue attributes = 3; uint32 dropped_attributes_count = 4; }
message Resource { repeated KeyValue attributes = 1; uint32 dropped_attributes_count = 2; }

message LogRecord {
  fixed64 time_unix_nano = 1;
  fixed64 observed_time_unix_nano = 11;
  int32 severity_number = 2;
  string severity_text = 3;
  AnyValue body = 5;
  repeated KeyValue attributes = 6;
  uint32 dropped_attributes_count = 7;
  fixed32 flags = 8;
  bytes trace_id = 9;
  bytes span_id = 10;
  string event_name = 12;
}
message ScopeLogs { InstrumentationScope scope = 1; repeated LogRecord log_records = 2; string schema_url = 3; }
message ResourceLogs { Resource resource = 1; repeated ScopeLogs scope_logs = 2; string schema_url = 3; }
message ExportLogsServiceRequest { repeated ResourceLogs resource_logs = 1; }
message ExportLogsPartialSuccess { int64 rejected_log_records = 1; string error_message = 2; }
message ExportLogsServiceResponse { ExportLogsPartialSuccess partial_success = 1; }

// ---------------------------------------------------------------- traces (opentelemetry/proto/trace/v1)
enum SpanKind { SPAN_KIND_UNSPECIFIED = 0; SPAN_KIND_INTERNAL = 1; SPAN_KIND_SERVER = 2; SPAN_KIND_CLIENT = 3; SPAN_KIND_PRODUCER = 4; SPAN_KIND_CONSUMER = 5; }
enum StatusCode { STATUS_CODE_UNSET = 0; STATUS_CODE_OK = 1; STATUS_CODE_ERROR = 2; }
message SpanStatus { string message = 2; StatusCode code = 3; }
message SpanEvent { fixed64 time_unix_nano = 1; string name = 2; repeated KeyValue attributes = 3; uint32 dropped_attributes_count = 4; }
message SpanLink { bytes trace_id = 1; bytes span_id = 2; string trace_state = 3; repeated KeyValue attributes = 4; uint32 dropped_attributes_count = 5; fixed32 flags = 6; }
message Span {
  bytes trace_id = 1;
  bytes span_id = 2;
  string trace_state = 3;
  bytes parent_span_id = 4;
  string name = 5;
  SpanKind kind = 6;
  fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9;
  uint32 dropped_attributes_count = 10;
  repeated SpanEvent events = 11;
  uint32 dropped_events_count = 12;
  repeated SpanLink links = 13;
  uint32 dropped_links_count = 14;
  SpanStatus status = 15;
  fixed32 flags = 16;
}
message ScopeSpans { InstrumentationScope scope = 1; repeated Span spans = 2; string schema_url = 3; }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; string schema_url = 3; }
message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
message ExportTracePartialSuccess { int64 rejected_spans = 1; string error_message = 2; }
message ExportTraceServiceResponse { ExportTracePartialSuccess partial_success = 1; }

// ---------------------------------------------------------------- metrics (opentelemetry/proto/metrics/v1)
enum AggregationTemporality { AGGREGATION_TEMPORALITY_UNSPECIFIED = 0; AGGREGATION_TEMPORALITY_DELTA = 1; AGGREGATION_TEMPORALITY_CUMULATIVE = 2; }
message Exemplar {
  repeated KeyValue filtered_attributes = 7;
  fixed64 time_unix_nano = 2;
  oneof value { double as_double = 3; sfixed64 as_int = 6; }
  bytes span_id = 4;
  bytes trace_id = 5;
}
message NumberDataPoint {
  repeated KeyValue attributes = 7;
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  oneof value { double as_double = 4; sfixed64 as_int = 6; }
  repeated Exemplar exemplars = 5;
  uint32 flags = 8;
}
message HistogramDataPoint {
  repeated KeyValue attributes = 9;
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  fixed64 count = 4;
  optional double sum = 5;
  repeated fixed64 bucket_counts = 6;
  repeated double explicit_bounds = 7;
  repeated Exemplar exemplars = 8;
  uint32 flags = 10;
  optional double min = 11;
  optional double max = 12;
}
message Gauge { repeated NumberDataPoint data_points = 1; }
message Sum { repeated NumberDataPoint data_points = 1; AggregationTemporality aggregation_temporality = 2; bool is_monotonic = 3; }
message Histogram { repeated HistogramDataPoint data_points = 1; AggregationTemporality aggregation_temporality = 2; }
// Recognised but not interpreted: data points are kept as opaque bytes so they can be COUNTED and reported as unsupported.
message ExponentialHistogram { repeated bytes data_points = 1; AggregationTemporality aggregation_temporality = 2; }
message Summary { repeated bytes data_points = 1; }
message Metric {
  string name = 1;
  string description = 2;
  string unit = 3;
  oneof data { Gauge gauge = 5; Sum sum = 7; Histogram histogram = 9; ExponentialHistogram exponential_histogram = 10; Summary summary = 11; }
}
message ScopeMetrics { InstrumentationScope scope = 1; repeated Metric metrics = 2; string schema_url = 3; }
message ResourceMetrics { Resource resource = 1; repeated ScopeMetrics scope_metrics = 2; string schema_url = 3; }
message ExportMetricsServiceRequest { repeated ResourceMetrics resource_metrics = 1; }
message ExportMetricsPartialSuccess { int64 rejected_data_points = 1; string error_message = 2; }
message ExportMetricsServiceResponse { ExportMetricsPartialSuccess partial_success = 1; }
`;

const root = protobuf.parse(PROTO, { keepCase: true }).root;
const Request = root.lookupType('nexus.otlp.ExportLogsServiceRequest');
const Response = root.lookupType('nexus.otlp.ExportLogsServiceResponse');

export class ProtobufDecodeError extends Error {}

/** Decodes an OTLP ExportLogsServiceRequest into the same object shape the JSON mapper consumes. */
export function decodeLogsRequest(buf: Uint8Array): unknown {
  try {
    const msg = Request.decode(buf);
    return Request.toObject(msg, { longs: String, enums: Number, bytes: String, defaults: false, arrays: true, objects: true });
  } catch (e) {
    throw new ProtobufDecodeError(e instanceof Error ? e.message : 'invalid protobuf');
  }
}

/** Test/sample helper: encodes a request object (snake_case fields, bytes as base64 strings or Buffers). */
export function encodeLogsRequest(obj: object): Uint8Array {
  return Request.encode(Request.fromObject(obj)).finish();
}

export function encodeLogsResponse(rejected: number, message: string): Uint8Array {
  if (!rejected) return Response.encode(Response.create({})).finish();
  return Response.encode(Response.fromObject({ partial_success: { rejected_log_records: rejected, error_message: message } })).finish();
}

const TracesRequest = root.lookupType('nexus.otlp.ExportTraceServiceRequest');
const TracesResponse = root.lookupType('nexus.otlp.ExportTraceServiceResponse');
const MetricsRequest = root.lookupType('nexus.otlp.ExportMetricsServiceRequest');
const MetricsResponse = root.lookupType('nexus.otlp.ExportMetricsServiceResponse');
const TO_OBJECT = { longs: String, enums: Number, bytes: String, defaults: false, arrays: true, objects: true } as const;

function decodeWith(type: protobuf.Type, buf: Uint8Array): unknown {
  try { return type.toObject(type.decode(buf), TO_OBJECT); } catch (e) { throw new ProtobufDecodeError(e instanceof Error ? e.message : 'invalid protobuf'); }
}
/** OTLP ExportTraceServiceRequest (protobuf) -> the object shape the JSON mapper consumes. */
export const decodeTracesRequest = (buf: Uint8Array): unknown => decodeWith(TracesRequest, buf);
/** OTLP ExportMetricsServiceRequest (protobuf) -> the object shape the JSON mapper consumes. */
export const decodeMetricsRequest = (buf: Uint8Array): unknown => decodeWith(MetricsRequest, buf);
export const encodeTracesRequest = (obj: object): Uint8Array => TracesRequest.encode(TracesRequest.fromObject(obj)).finish();
export const encodeMetricsRequest = (obj: object): Uint8Array => MetricsRequest.encode(MetricsRequest.fromObject(obj)).finish();

export function encodeTracesResponse(rejected: number, message: string): Uint8Array {
  if (!rejected) return TracesResponse.encode(TracesResponse.create({})).finish();
  return TracesResponse.encode(TracesResponse.fromObject({ partial_success: { rejected_spans: rejected, error_message: message } })).finish();
}
export function encodeMetricsResponse(rejected: number, message: string): Uint8Array {
  if (!rejected) return MetricsResponse.encode(MetricsResponse.create({})).finish();
  return MetricsResponse.encode(MetricsResponse.fromObject({ partial_success: { rejected_data_points: rejected, error_message: message } })).finish();
}
