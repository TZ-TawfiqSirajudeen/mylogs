import { MaintenanceCreate, WEEKDAYS, type MaintenanceDto, type MaintenanceSchedule, type Weekday } from '@nexus/contracts';

/** Pure helpers of the maintenance-window form (ADR-0010): what the form holds, what it sends, how a schedule reads in plain language. */
export interface WindowForm {
  name: string; comment: string; enabled: boolean;
  type: 'weekly' | 'once';
  weekdays: Weekday[]; startTime: string; durationMinutes: string; timezone: string;
  /** `datetime-local` values: the browser's local time. */
  onceStart: string; onceEnd: string;
  ruleId: string; severity: string; environmentId: string;
}

export const DAY_LABEL: Record<Weekday, string> = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

export function browserZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
export function knownZones(): string[] {
  try {
    const v = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone');
    if (v?.length) return v.includes('UTC') ? v : ['UTC', ...v];
  } catch { /* fall through */ }
  return ['UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney'];
}

export const emptyForm = (zone = browserZone()): WindowForm => ({
  name: '', comment: '', enabled: true, type: 'weekly', weekdays: ['sun'], startTime: '02:00', durationMinutes: '120', timezone: zone,
  onceStart: '', onceEnd: '', ruleId: '', severity: '', environmentId: '',
});

const pad = (n: number) => String(n).padStart(2, '0');
/** ISO instant -> the value of a `datetime-local` input in the browser's zone. */
export const isoToLocalInput = (iso: string): string => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
/** `datetime-local` value (browser zone) -> ISO instant; '' when it is not a date. */
export const localInputToIso = (v: string): string => { const d = new Date(v); return v && !Number.isNaN(d.getTime()) ? d.toISOString() : ''; };

export function formFromWindow(w: MaintenanceDto): WindowForm {
  const s = w.schedule;
  return {
    ...emptyForm(), name: w.name, comment: w.comment, enabled: w.enabled,
    ...(s.type === 'weekly' ? { type: 'weekly' as const, weekdays: [...s.weekdays], startTime: s.startTime, durationMinutes: String(s.durationMinutes), timezone: s.timezone }
      : { type: 'once' as const, onceStart: isoToLocalInput(s.startsAt), onceEnd: isoToLocalInput(s.endsAt) }),
    ruleId: w.matchers.ruleIds?.[0] ?? '', severity: w.matchers.severities?.[0] ?? '', environmentId: w.matchers.environmentIds?.[0] ?? '',
  };
}

/** The request body exactly as the form would send it (the server re-validates everything). */
export function bodyFromForm(f: WindowForm) {
  const schedule: MaintenanceSchedule = f.type === 'weekly'
    ? { type: 'weekly', timezone: f.timezone.trim(), weekdays: WEEKDAYS.filter((d) => f.weekdays.includes(d)), startTime: f.startTime, durationMinutes: Number(f.durationMinutes) }
    : { type: 'once', startsAt: localInputToIso(f.onceStart), endsAt: localInputToIso(f.onceEnd) };
  return {
    name: f.name.trim(), comment: f.comment.trim(), enabled: f.enabled, schedule,
    matchers: { ...(f.ruleId ? { ruleIds: [f.ruleId] } : {}), ...(f.severity ? { severities: [f.severity as 'info' | 'warning' | 'critical'] } : {}), ...(f.environmentId ? { environmentIds: [f.environmentId] } : {}) },
  };
}

/** Field-level problems the browser can see before sending (same schema as the server). */
export function formIssues(f: WindowForm): string[] {
  if (f.type === 'once' && (!f.onceStart || !f.onceEnd)) return ['Choose when the window starts and ends'];
  const r = MaintenanceCreate.safeParse(bodyFromForm(f));
  return r.success ? [] : [...new Set(r.error.issues.map((i) => i.message))].slice(0, 3);
}

const dur = (min: number) => (min % 60 === 0 ? `${min / 60} h` : min > 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`);
export function describeSchedule(s: MaintenanceSchedule): string {
  if (s.type === 'once') return `once: ${s.startsAt.replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, '')} to ${s.endsAt.replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, '')} UTC`;
  const days = s.weekdays.length === 7 ? 'every day' : WEEKDAYS.filter((d) => s.weekdays.includes(d)).map((d) => DAY_LABEL[d]).join(', ');
  return `${days} at ${s.startTime} (${s.timezone}) for ${dur(s.durationMinutes)}`;
}

/** An instant shown in a named zone, e.g. "Sun 29 Mar 2026, 03:00". Falls back to UTC when the zone is unknown. */
export function formatInZone(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  try { return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone }).format(d); } catch { return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' }).format(d); }
}
export const utcShort = (iso: string) => iso.replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, ' UTC');
