import type { LogSummary, SpanDto } from '@nexus/contracts';
import { Link } from 'react-router-dom';
import { Badge, Card } from '../../ui';
import { SEVERITY_TONE, utc } from '../logs/model';
import { logsLink, tracesLink, utcNs } from './model';
import { CopyButton } from './shared';
import { formatNs, type WaterfallRow } from './waterfall-model';

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="grid grid-cols-[9rem_1fr] gap-2 border-b border-slate-100 py-1 text-sm last:border-0 dark:border-slate-800"><dt className="text-slate-600 dark:text-slate-400">{label}</dt><dd className="min-w-0 break-words">{children}</dd></div>
);

/**
 * Everything known about the selected span. Attribute values were sanitized at ingestion (credentials, URL query secrets and
 * exception text are masked before storage); this panel shows exactly what is stored and invents nothing.
 */
export function SpanDetails({ row, spans, projectId, traceStart, traceEnd, logs, onSelect, windowMinutes = 60 }: {
  row: WaterfallRow; spans: SpanDto[]; projectId: string; traceStart: string; traceEnd: string; logs: LogSummary[]; onSelect: (id: string) => void; windowMinutes?: number;
}) {
  const s = row.span;
  const parent = s.parentSpanId ? spans.find((x) => x.spanId === s.parentSpanId) : undefined;
  const children = spans.filter((x) => x.parentSpanId === s.spanId);
  const exceptions = s.events.filter((e) => e.name === 'exception');
  const around = { from: new Date(Date.parse(traceStart) - 5 * 60_000).toISOString(), to: new Date(Date.parse(traceEnd) + 5 * 60_000).toISOString() };
  const metricWindow = { from: new Date(Date.parse(traceStart) - windowMinutes * 30_000).toISOString(), to: new Date(Date.parse(traceEnd) + windowMinutes * 30_000).toISOString() };
  const mine = logs.filter((l) => l.spanId === s.spanId);

  return (
    <Card title={`Span: ${s.name}`} actions={<span className="flex items-center gap-1">{s.statusCode === 'error' ? <Badge tone="danger">✕ error</Badge> : s.statusCode === 'ok' ? <Badge tone="info">ok</Badge> : <Badge>status unset</Badge>}{row.slow && <Badge tone="warn">slow</Badge>}</span>}>
      <div className="space-y-4" data-testid="span-details">
        <dl>
          <Row label="Name"><span className="font-medium">{s.name}</span></Row>
          <Row label="Span ID"><span className="font-mono text-xs">{s.spanId}</span><CopyButton value={s.spanId} label="span ID" /></Row>
          <Row label="Trace ID"><span className="font-mono text-xs">{s.traceId}</span><CopyButton value={s.traceId} label="trace ID" /></Row>
          <Row label="Service">{s.service ?? <span className="text-slate-600 dark:text-slate-400">unavailable</span>}{s.serviceVersion ? ` · v${s.serviceVersion}` : ''}{s.host ? ` · ${s.host}` : ''}</Row>
          <Row label="Kind">{s.kind}{s.scopeName ? ` · instrumentation: ${s.scopeName}${s.scopeVersion ? ` ${s.scopeVersion}` : ''}` : ''}</Row>
          <Row label="Duration">{formatNs(row.durationNs)}{row.durationNs === null && <span className="text-slate-600 dark:text-slate-400"> — no valid end time was reported</span>}</Row>
          <Row label="Start offset">+{formatNs(row.offsetNs)} from the trace start</Row>
          <Row label="Started (UTC)"><span className="font-mono text-xs">{utcNs(s.startUnixNano)}</span></Row>
          <Row label="Ended (UTC)">{s.timingValid ? <span className="font-mono text-xs">{utcNs(s.endUnixNano)}</span> : <span className="text-slate-600 dark:text-slate-400">unknown</span>}</Row>
          {s.statusMessage && <Row label="Status message">{s.statusMessage}</Row>}
          <Row label="Parent">{s.parentSpanId === null ? 'none (root span)' : parent ? <button type="button" className="text-indigo-700 underline dark:text-indigo-300" onClick={() => onSelect(parent.spanId)}>{parent.name}</button> : <span className="text-amber-800 dark:text-amber-300">span {s.parentSpanId} was not received</span>}</Row>
          <Row label="Children">{children.length === 0 ? 'none' : <ul className="flex flex-wrap gap-x-3 gap-y-1">{children.slice(0, 30).map((c) => <li key={c.spanId}><button type="button" className="text-indigo-700 underline dark:text-indigo-300" onClick={() => onSelect(c.spanId)}>{c.name}</button></li>)}{children.length > 30 && <li>+{children.length - 30} more</li>}</ul>}</Row>
          {(s.httpMethod || s.httpRoute || s.httpStatus !== null) && <Row label="HTTP">{s.httpMethod ?? ''} {s.httpRoute ?? ''} {s.httpStatus ?? ''}</Row>}
          {s.dbSystem && <Row label="Database">{s.dbSystem}{s.attrs.find((a) => a.k === 'db.operation.name' || a.k === 'db.operation')?.v ? ` · ${s.attrs.find((a) => a.k === 'db.operation.name' || a.k === 'db.operation')!.v}` : ''}{s.attrs.find((a) => a.k === 'db.collection.name' || a.k === 'db.mongodb.collection')?.v ? ` · ${s.attrs.find((a) => a.k === 'db.collection.name' || a.k === 'db.mongodb.collection')!.v}` : ''}</Row>}
          {s.peerService && <Row label="Peer">{s.peerService}</Row>}
          {(s.droppedAttrs > 0 || s.droppedEvents > 0 || s.droppedLinks > 0 || s.attrsTruncated) && (
            <Row label="Dropped data"><span className="text-amber-800 dark:text-amber-300">{s.droppedAttrs} attribute(s), {s.droppedEvents} event(s), {s.droppedLinks} link(s) were dropped by the SDK or at ingestion{s.attrsTruncated ? '; some values were truncated' : ''}.</span></Row>
          )}
          {s.redactions > 0 && <Row label="Redactions">{s.redactions} value(s) were masked at ingestion.</Row>}
        </dl>

        {exceptions.length > 0 && (
          <section aria-label="Recorded exceptions" className="space-y-2">
            <h3 className="text-sm font-semibold">Exceptions ({exceptions.length})</h3>
            {exceptions.map((e, i) => {
              const get = (k: string) => e.attrs.find((a) => a.k === k)?.v;
              return (
                <div key={i} className="rounded border border-red-300 bg-red-50 p-2 text-sm dark:border-red-900 dark:bg-red-950/40" data-testid="exception">
                  <p className="font-medium text-red-900 dark:text-red-200">✕ {get('exception.type') ?? 'Exception'}{get('exception.message') ? `: ${get('exception.message')}` : ''}</p>
                  <p className="text-xs text-slate-700 dark:text-slate-300">at +{formatNs(Number(BigInt(e.tsUnixNano) - BigInt(s.startUnixNano)) + row.offsetNs)} · {utcNs(e.tsUnixNano)} UTC</p>
                  {get('exception.stacktrace') && <details className="mt-1"><summary className="cursor-pointer text-xs">Stack trace</summary><pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-white p-2 font-mono text-xs dark:bg-slate-900">{get('exception.stacktrace')}</pre></details>}
                </div>
              );
            })}
          </section>
        )}

        {s.events.filter((e) => e.name !== 'exception').length > 0 && (
          <section aria-label="Span events" className="space-y-1">
            <h3 className="text-sm font-semibold">Events ({s.events.filter((e) => e.name !== 'exception').length})</h3>
            <ul className="space-y-1 text-xs">{s.events.filter((e) => e.name !== 'exception').slice(0, 50).map((e, i) => (
              <li key={i}><span className="font-mono">{utcNs(e.tsUnixNano).slice(11)}</span> <strong>{e.name}</strong>{e.attrs.length > 0 && <span className="text-slate-600 dark:text-slate-400"> — {e.attrs.map((a) => `${a.k}=${a.v}`).join(', ')}</span>}</li>))}</ul>
          </section>
        )}

        {s.links.length > 0 && (
          <section aria-label="Span links" className="space-y-1">
            <h3 className="text-sm font-semibold">Links ({s.links.length})</h3>
            <ul className="space-y-1 text-xs">{s.links.map((l, i) => <li key={i}>linked span <span className="font-mono">{l.spanId}</span> in trace <Link className="font-mono text-indigo-700 underline dark:text-indigo-300" to={`/traces/${l.traceId}?p=${projectId}`}>{l.traceId.slice(0, 8)}…</Link></li>)}</ul>
          </section>
        )}

        <section aria-label="Attributes">
          <details open={s.attrs.length > 0 && s.attrs.length <= 12}><summary className="cursor-pointer text-sm font-semibold">Attributes ({s.attrs.length})</summary>
            <div className="mt-1 max-h-64 overflow-auto"><table className="w-full text-left text-xs"><caption className="sr-only">Span attributes</caption><thead className="sr-only"><tr><th scope="col">Key</th><th scope="col">Value</th></tr></thead>
              <tbody>{s.attrs.map((a) => <tr key={a.k} className="border-b border-slate-100 dark:border-slate-800"><th scope="row" className="w-1/3 py-1 pr-2 align-top font-mono font-normal text-slate-700 dark:text-slate-300">{a.k}</th><td className="break-all py-1 font-mono">{a.v}</td></tr>)}</tbody></table>
              {s.attrs.length === 0 && <p className="text-xs text-slate-600 dark:text-slate-400">No attributes were recorded on this span.</p>}</div></details>
          <details className="mt-1"><summary className="cursor-pointer text-sm font-semibold">Resource attributes ({s.resource.length})</summary>
            <div className="mt-1 max-h-48 overflow-auto"><table className="w-full text-left text-xs"><caption className="sr-only">Resource attributes</caption><thead className="sr-only"><tr><th scope="col">Key</th><th scope="col">Value</th></tr></thead>
              <tbody>{s.resource.map((a) => <tr key={a.k} className="border-b border-slate-100 dark:border-slate-800"><th scope="row" className="w-1/3 py-1 pr-2 align-top font-mono font-normal text-slate-700 dark:text-slate-300">{a.k}</th><td className="break-all py-1 font-mono">{a.v}</td></tr>)}</tbody></table></div></details>
        </section>

        <section aria-label="Logs of this span" className="space-y-1">
          <h3 className="text-sm font-semibold">Logs from this span ({mine.length})</h3>
          {mine.length === 0 ? <p className="text-xs text-slate-600 dark:text-slate-400">No log record carries this span id.</p> : (
            <ul className="space-y-1 text-xs">{mine.slice(0, 20).map((l) => <li key={l.id} className="flex gap-2"><span className="font-mono">{utc(l.ts).slice(11, 23)}</span><Badge tone={SEVERITY_TONE[l.severity]}>{l.severity}</Badge><span className="min-w-0 truncate" title={l.message}>{l.message}</span></li>)}</ul>
          )}
        </section>

        <nav aria-label="Related views" className="flex flex-wrap gap-3 text-sm">
          <Link className="text-indigo-700 underline dark:text-indigo-300" to={logsLink(projectId, s.traceId, around, s.spanId)}>Open this span’s logs in the Logs explorer</Link>
          {s.service && <Link className="text-indigo-700 underline dark:text-indigo-300" to={`/services/${encodeURIComponent(s.service)}?p=${projectId}&env=${s.environmentId}`}>Service dashboard for {s.service}</Link>}
          {s.service && <Link className="text-indigo-700 underline dark:text-indigo-300" to={tracesLink(projectId, { service: s.service, ...metricWindow, errorsOnly: s.statusCode === 'error', envId: s.environmentId })}>{s.statusCode === 'error' ? 'Other failing traces of this service' : 'Other traces of this service'} around this time</Link>}
        </nav>
      </div>
    </Card>
  );
}
