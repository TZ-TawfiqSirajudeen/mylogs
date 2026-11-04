import { MaintenanceCreate, MaintenanceUpdate, WEEKDAYS } from '@nexus/contracts';
import { describe, expect, test } from 'vitest';
import {
  activeOccurrenceAt, isActiveAt, localToUtc, maintenanceMatches, maintenanceState, nextOccurrenceAfter, parseStartTime, toMaintenanceDto, validateSchedule, zoneOffsetMs, type Schedule,
} from './maintenance.js';

const t = (iso: string) => new Date(iso);
const weekly = (over: Partial<Extract<Schedule, { type: 'weekly' }>> = {}): Extract<Schedule, { type: 'weekly' }> =>
  ({ type: 'weekly', timezone: 'UTC', weekdays: ['sun'], startTime: '02:00', durationMinutes: 60, ...over });
const span = (o: { startsAt: Date; endsAt: Date } | null) => (o ? [o.startsAt.toISOString(), o.endsAt.toISOString()] : null);

// Calendar facts used below (2026): US clocks go forward Sun 8 Mar 02:00 -> 03:00 (07:00Z) and back Sun 1 Nov 02:00 -> 01:00 (06:00Z);
// the EU forward Sun 29 Mar 01:00Z and back Sun 25 Oct 01:00Z; Lord Howe (+10:30/+11) forward Sun 4 Oct 02:00 -> 02:30.

describe('zone arithmetic', () => {
  test('offsets follow the IANA rules, including half-hour zones', () => {
    expect(zoneOffsetMs('UTC', t('2026-06-01T00:00:00Z').getTime())).toBe(0);
    expect(zoneOffsetMs('America/New_York', t('2026-01-15T12:00:00Z').getTime())).toBe(-5 * 3_600_000);
    expect(zoneOffsetMs('America/New_York', t('2026-07-15T12:00:00Z').getTime())).toBe(-4 * 3_600_000);
    expect(zoneOffsetMs('Asia/Kolkata', t('2026-07-15T12:00:00Z').getTime())).toBe(5.5 * 3_600_000);
    expect(zoneOffsetMs('Australia/Lord_Howe', t('2026-01-15T12:00:00Z').getTime())).toBe(11 * 3_600_000);
    expect(zoneOffsetMs('Australia/Lord_Howe', t('2026-07-15T12:00:00Z').getTime())).toBe(10.5 * 3_600_000);
  });
  test('an unknown zone is a RangeError (never a silent UTC fallback)', () => {
    expect(() => zoneOffsetMs('Mars/Olympus_Mons', 0)).toThrow(RangeError);
  });
  test('wall-clock to instant: normal, gap (shifted forward by the gap) and overlap (first occurrence)', () => {
    const ny = 'America/New_York';
    expect(new Date(localToUtc(ny, { y: 2026, m: 3, d: 7 }, 2, 30)).toISOString()).toBe('2026-03-07T07:30:00.000Z'); // plain EST
    expect(new Date(localToUtc(ny, { y: 2026, m: 3, d: 8 }, 2, 30)).toISOString()).toBe('2026-03-08T07:30:00.000Z');   // 02:30 does not exist: 03:30 EDT
    expect(new Date(localToUtc(ny, { y: 2026, m: 3, d: 8 }, 3, 0)).toISOString()).toBe('2026-03-08T07:00:00.000Z');    // the first real instant after the jump
    expect(new Date(localToUtc(ny, { y: 2026, m: 11, d: 1 }, 1, 30)).toISOString()).toBe('2026-11-01T05:30:00.000Z');  // 01:30 exists twice: the EDT one
    expect(new Date(localToUtc(ny, { y: 2026, m: 11, d: 1 }, 2, 30)).toISOString()).toBe('2026-11-01T07:30:00.000Z');  // after the second pass: EST
    expect(new Date(localToUtc('Australia/Lord_Howe', { y: 2026, m: 10, d: 4 }, 2, 15)).toISOString()).toBe('2026-10-03T15:45:00.000Z'); // 30-minute gap
  });
  test('start-time parsing is strict', () => {
    expect(parseStartTime('00:00')).toEqual({ hour: 0, minute: 0 });
    expect(parseStartTime('23:59')).toEqual({ hour: 23, minute: 59 });
    for (const bad of ['24:00', '9:00', '12:60', '', '12:3', '1200', ' 12:00', '12:00:00']) expect(() => parseStartTime(bad), bad).toThrow(RangeError);
  });
});

describe('weekly windows: basics', () => {
  const s = weekly({ weekdays: ['mon', 'wed'], startTime: '09:30', durationMinutes: 90 });
  test('active from the start (inclusive) to the end (exclusive) on the listed weekdays only', () => {
    // 2026-06-01 is a Monday
    expect(isActiveAt(s, t('2026-06-01T09:29:59.999Z'))).toBe(false);
    expect(isActiveAt(s, t('2026-06-01T09:30:00.000Z'))).toBe(true);
    expect(isActiveAt(s, t('2026-06-01T10:59:59.999Z'))).toBe(true);
    expect(isActiveAt(s, t('2026-06-01T11:00:00.000Z'))).toBe(false);
    expect(isActiveAt(s, t('2026-06-02T10:00:00Z'))).toBe(false); // Tuesday
    expect(isActiveAt(s, t('2026-06-03T10:00:00Z'))).toBe(true);  // Wednesday
  });
  test('the current occurrence and the next one', () => {
    expect(span(activeOccurrenceAt(s, t('2026-06-01T10:00:00Z')))).toEqual(['2026-06-01T09:30:00.000Z', '2026-06-01T11:00:00.000Z']);
    expect(activeOccurrenceAt(s, t('2026-06-01T12:00:00Z'))).toBeNull();
    expect(span(nextOccurrenceAfter(s, t('2026-06-01T12:00:00Z')))).toEqual(['2026-06-03T09:30:00.000Z', '2026-06-03T11:00:00.000Z']);
    // strictly after: exactly at the start the NEXT one is returned, inside a window too
    expect(span(nextOccurrenceAfter(s, t('2026-06-01T09:30:00Z')))?.[0]).toBe('2026-06-03T09:30:00.000Z');
    expect(span(nextOccurrenceAfter(s, t('2026-06-01T10:00:00Z')))?.[0]).toBe('2026-06-03T09:30:00.000Z');
    // the week wraps: after Wednesday comes next Monday
    expect(span(nextOccurrenceAfter(s, t('2026-06-03T12:00:00Z')))?.[0]).toBe('2026-06-08T09:30:00.000Z');
  });
  test('a single weekday recurs every 7 days, from any instant', () => {
    const one = weekly({ weekdays: ['thu'], startTime: '00:00', durationMinutes: 1 });
    for (let h = 0; h < 24 * 8; h += 5) {
      const from = new Date(t('2026-06-01T00:00:00Z').getTime() + h * 3_600_000);
      const n = nextOccurrenceAfter(one, from)!;
      expect(n.startsAt > from).toBe(true);
      expect(n.startsAt.getTime() - from.getTime()).toBeLessThanOrEqual(7 * 86_400_000);
      expect(n.startsAt.getUTCDay()).toBe(4);
    }
  });
  test('every weekday, 24 h: always active', () => {
    const all = weekly({ weekdays: [...WEEKDAYS], startTime: '00:00', durationMinutes: 1440 });
    for (const iso of ['2026-06-01T00:00:00Z', '2026-06-04T13:37:00Z', '2026-12-31T23:59:59Z']) expect(isActiveAt(all, t(iso))).toBe(true);
  });
});

describe('windows that cross midnight', () => {
  const s = weekly({ weekdays: ['fri'], startTime: '23:00', durationMinutes: 120 });
  test('the occurrence belongs to the weekday it STARTS on', () => {
    expect(isActiveAt(s, t('2026-06-05T22:59:00Z'))).toBe(false); // Fri 22:59
    expect(isActiveAt(s, t('2026-06-05T23:00:00Z'))).toBe(true);  // Fri 23:00
    expect(isActiveAt(s, t('2026-06-06T00:30:00Z'))).toBe(true);  // Sat 00:30 (still Friday's window)
    expect(isActiveAt(s, t('2026-06-06T00:59:59Z'))).toBe(true);
    expect(isActiveAt(s, t('2026-06-06T01:00:00Z'))).toBe(false);
    expect(isActiveAt(s, t('2026-06-06T23:30:00Z'))).toBe(false); // Saturday is not listed
    expect(span(activeOccurrenceAt(s, t('2026-06-06T00:30:00Z')))).toEqual(['2026-06-05T23:00:00.000Z', '2026-06-06T01:00:00.000Z']);
  });
  test('a window that spans a month and a year boundary', () => {
    const nye = weekly({ weekdays: ['thu'], startTime: '23:30', durationMinutes: 90 }); // Thu 31 Dec 2026
    expect(isActiveAt(nye, t('2027-01-01T00:45:00Z'))).toBe(true);
    expect(isActiveAt(nye, t('2027-01-01T01:00:00Z'))).toBe(false);
    expect(span(nextOccurrenceAfter(nye, t('2026-12-31T12:00:00Z')))).toEqual(['2026-12-31T23:30:00.000Z', '2027-01-01T01:00:00.000Z']);
  });
  test('a 24 h window starting late is still found the next day (two-day look-back)', () => {
    const long = weekly({ weekdays: ['mon'], startTime: '23:59', durationMinutes: 1440 });
    expect(isActiveAt(long, t('2026-06-02T23:58:00Z'))).toBe(true);
    expect(isActiveAt(long, t('2026-06-02T23:59:00Z'))).toBe(false);
  });
  test('across the night the clocks go back the 4 h window really lasts 4 elapsed hours', () => {
    // Sat 31 Oct 23:00 EDT = 03:00Z; 240 elapsed minutes end at 07:00Z (02:00 EST, one wall-clock hour later than "03:00")
    const ny = weekly({ timezone: 'America/New_York', weekdays: ['sat'], startTime: '23:00', durationMinutes: 240 });
    expect(span(activeOccurrenceAt(ny, t('2026-11-01T04:00:00Z')))).toEqual(['2026-11-01T03:00:00.000Z', '2026-11-01T07:00:00.000Z']);
    expect(isActiveAt(ny, t('2026-11-01T06:59:59Z'))).toBe(true);
    expect(isActiveAt(ny, t('2026-11-01T07:00:00Z'))).toBe(false);
  });
});

describe('daylight saving', () => {
  test('spring forward: a start inside the skipped hour is shifted by the gap; the window keeps its elapsed duration', () => {
    const ny = weekly({ timezone: 'America/New_York', weekdays: ['sun'], startTime: '02:30', durationMinutes: 60 });
    expect(span(nextOccurrenceAfter(ny, t('2026-03-07T12:00:00Z')))).toEqual(['2026-03-08T07:30:00.000Z', '2026-03-08T08:30:00.000Z']);
    expect(isActiveAt(ny, t('2026-03-08T07:29:59Z'))).toBe(false);
    expect(isActiveAt(ny, t('2026-03-08T07:30:00Z'))).toBe(true);
    // the week before and after are ordinary: 02:30 EST = 07:30Z, and 02:30 EDT = 06:30Z
    expect(span(nextOccurrenceAfter(ny, t('2026-03-01T00:00:00Z')))?.[0]).toBe('2026-03-01T07:30:00.000Z');
    expect(span(nextOccurrenceAfter(ny, t('2026-03-08T12:00:00Z')))?.[0]).toBe('2026-03-15T06:30:00.000Z');
  });
  test('spring forward in Europe/Berlin: 02:00 does not exist on 29 March, the window starts at 03:00 CEST', () => {
    const de = weekly({ timezone: 'Europe/Berlin', weekdays: ['sun'], startTime: '02:00', durationMinutes: 180 });
    expect(span(nextOccurrenceAfter(de, t('2026-03-28T12:00:00Z')))).toEqual(['2026-03-29T01:00:00.000Z', '2026-03-29T04:00:00.000Z']);
  });
  test('a window that starts before the jump and ends after it', () => {
    const ny = weekly({ timezone: 'America/New_York', weekdays: ['sun'], startTime: '01:00', durationMinutes: 120 });
    // 01:00 EST = 06:00Z, 120 elapsed minutes -> 08:00Z = 04:00 EDT
    expect(span(activeOccurrenceAt(ny, t('2026-03-08T07:30:00Z')))).toEqual(['2026-03-08T06:00:00.000Z', '2026-03-08T08:00:00.000Z']);
    expect(isActiveAt(ny, t('2026-03-08T08:00:00Z'))).toBe(false);
  });
  test('fall back: a start in the repeated hour uses the FIRST pass; the window is active through the second pass', () => {
    const ny = weekly({ timezone: 'America/New_York', weekdays: ['sun'], startTime: '01:30', durationMinutes: 120 });
    expect(span(nextOccurrenceAfter(ny, t('2026-10-31T12:00:00Z')))).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-01T07:30:00.000Z']);
    expect(isActiveAt(ny, t('2026-11-01T05:29:59Z'))).toBe(false);
    expect(isActiveAt(ny, t('2026-11-01T06:15:00Z'))).toBe(true); // 01:15 EST, the second pass of the hour
    expect(isActiveAt(ny, t('2026-11-01T07:29:59Z'))).toBe(true);
    expect(isActiveAt(ny, t('2026-11-01T07:30:00Z'))).toBe(false);
    // the following Sunday starts at 01:30 EST = 06:30Z
    expect(span(nextOccurrenceAfter(ny, t('2026-11-02T00:00:00Z')))?.[0]).toBe('2026-11-08T06:30:00.000Z');
  });
  test('fall back in Europe/Berlin (25 October): 02:30 exists twice, the first (CEST) is used', () => {
    const de = weekly({ timezone: 'Europe/Berlin', weekdays: ['sun'], startTime: '02:30', durationMinutes: 30 });
    expect(span(nextOccurrenceAfter(de, t('2026-10-24T12:00:00Z')))).toEqual(['2026-10-25T00:30:00.000Z', '2026-10-25T01:00:00.000Z']);
  });
  test('a half-hour DST zone (Lord Howe)', () => {
    const lh = weekly({ timezone: 'Australia/Lord_Howe', weekdays: ['sun'], startTime: '02:15', durationMinutes: 60 });
    expect(span(nextOccurrenceAfter(lh, t('2026-10-03T00:00:00Z')))).toEqual(['2026-10-03T15:45:00.000Z', '2026-10-03T16:45:00.000Z']);
  });
  test('a zone without DST never moves, and the offset can be large or fractional', () => {
    const ist = weekly({ timezone: 'Asia/Kolkata', weekdays: ['mon'], startTime: '00:15', durationMinutes: 30 }); // Mon 00:15 IST = Sun 18:45Z
    expect(span(nextOccurrenceAfter(ist, t('2026-06-01T00:00:00Z')))).toEqual(['2026-06-07T18:45:00.000Z', '2026-06-07T19:15:00.000Z']);
    expect(isActiveAt(ist, t('2026-06-07T19:00:00Z'))).toBe(true);
    // UTC+14: local Monday 00:30 is Sunday 10:30Z; a UTC-based check on "Monday" would be 13.5 hours off
    const kiri = weekly({ timezone: 'Pacific/Kiritimati', weekdays: ['mon'], startTime: '00:30', durationMinutes: 60 });
    expect(isActiveAt(kiri, t('2026-06-07T11:00:00Z'))).toBe(true);
    expect(isActiveAt(kiri, t('2026-06-08T11:00:00Z'))).toBe(false); // that is Tuesday 01:00 there
    // UTC-11: local Sunday 23:30 is Monday 10:30Z
    const pago = weekly({ timezone: 'Pacific/Pago_Pago', weekdays: ['sun'], startTime: '23:30', durationMinutes: 60 });
    expect(isActiveAt(pago, t('2026-06-08T11:00:00Z'))).toBe(true);
  });
  test('a day that does not exist at all (Samoa skipped 30 Dec 2011) does not break the lookup', () => {
    const sm = weekly({ timezone: 'Pacific/Apia', weekdays: ['fri'], startTime: '10:00', durationMinutes: 60 });
    expect(nextOccurrenceAfter(sm, t('2011-12-28T00:00:00Z'))).not.toBeNull();
    expect(() => isActiveAt(sm, t('2011-12-30T12:00:00Z'))).not.toThrow();
  });
});

describe('agreement with a brute-force local-time check (summer, no transitions nearby)', () => {
  // Outside the days around a transition, "active" means: local weekday/time-of-day lies in [start, start + duration) measured in local minutes.
  const zones = ['America/New_York', 'Europe/Berlin', 'Asia/Kolkata', 'Australia/Sydney'];
  const fmt = (z: string) => new Intl.DateTimeFormat('en-US', { timeZone: z, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  test('2,000 random schedules and instants', () => {
    let activeSeen = 0;
    for (let i = 0; i < 2000; i++) {
      const z = zones[Math.floor(rnd() * zones.length)]!;
      const startMin = Math.floor(rnd() * 1440), dur = 1 + Math.floor(rnd() * 1440);
      const days = WEEKDAYS.filter(() => rnd() < 0.4);
      if (!days.length) days.push('wed');
      const s = weekly({ timezone: z, weekdays: days, startTime: `${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}`, durationMinutes: dur });
      // June to August: no transition in these zones except Sydney's none either (its DST changes in April and October)
      const at = new Date(Date.UTC(2026, 5, 1) + Math.floor(rnd() * 90 * 1440) * 60_000);
      const parts = fmt(z).formatToParts(at);
      const wd = DOW.indexOf(parts.find((p) => p.type === 'weekday')!.value.toLowerCase().slice(0, 3));
      const mins = Number(parts.find((p) => p.type === 'hour')!.value) * 60 + Number(parts.find((p) => p.type === 'minute')!.value);
      const weekMin = ((wd + 6) % 7) * 1440 + mins; // minutes since local Monday 00:00
      let expected = false;
      for (const d of days) {
        const start = WEEKDAYS.indexOf(d) * 1440 + startMin;
        for (const shift of [0, 7 * 1440]) { const rel = weekMin + shift - start; if (rel >= 0 && rel < dur) expected = true; }
      }
      if (expected) activeSeen++;
      expect(isActiveAt(s, at), `${z} ${JSON.stringify(s)} @ ${at.toISOString()}`).toBe(expected);
    }
    expect(activeSeen).toBeGreaterThan(200); // the property is not vacuous
  });
});

describe('one-off windows', () => {
  const s: Schedule = { type: 'once', startsAt: t('2026-06-01T10:00:00Z'), endsAt: t('2026-06-01T12:00:00Z') };
  test('start inclusive, end exclusive; the next occurrence is the window itself until it has started, then none', () => {
    expect(isActiveAt(s, t('2026-06-01T09:59:59Z'))).toBe(false);
    expect(isActiveAt(s, t('2026-06-01T10:00:00Z'))).toBe(true);
    expect(isActiveAt(s, t('2026-06-01T11:59:59Z'))).toBe(true);
    expect(isActiveAt(s, t('2026-06-01T12:00:00Z'))).toBe(false);
    expect(span(nextOccurrenceAfter(s, t('2026-05-01T00:00:00Z')))).toEqual(['2026-06-01T10:00:00.000Z', '2026-06-01T12:00:00.000Z']);
    expect(nextOccurrenceAfter(s, t('2026-06-01T10:00:00Z'))).toBeNull();
    expect(nextOccurrenceAfter(s, t('2026-06-01T11:00:00Z'))).toBeNull();
  });
});

describe('invalid input', () => {
  test('an invalid instant is never active and has no next occurrence', () => {
    expect(isActiveAt(weekly(), new Date('nope'))).toBe(false);
    expect(nextOccurrenceAfter(weekly(), new Date('nope'))).toBeNull();
    expect(activeOccurrenceAt({ type: 'once', startsAt: t('2026-06-01T10:00:00Z'), endsAt: t('2026-06-01T12:00:00Z') }, new Date('nope'))).toBeNull();
  });
  test('corrupt stored schedules throw RangeError from the pure functions and are treated as "not active" by the matcher', () => {
    const base = { enabled: true, matchers: {} };
    for (const bad of [weekly({ timezone: 'Not/AZone' }), weekly({ startTime: '25:00' }), weekly({ durationMinutes: 0 }), weekly({ durationMinutes: Number.NaN })]) {
      expect(() => isActiveAt(bad, t('2026-06-07T02:30:00Z'))).toThrow(RangeError);
      expect(maintenanceMatches({ ...base, schedule: bad }, { _id: 'r', severity: 'info', environmentId: 'e' }, t('2026-06-07T02:30:00Z'))).toBe(false);
    }
  });
  test('validateSchedule reports each problem', () => {
    expect(validateSchedule(weekly())).toEqual([]);
    expect(validateSchedule(weekly({ timezone: 'Mars/Olympus' })).join()).toMatch(/Unknown time zone/);
    expect(validateSchedule(weekly({ startTime: '7:00' })).join()).toMatch(/HH:MM/);
    expect(validateSchedule(weekly({ durationMinutes: 1441 })).join()).toMatch(/1 to 1440/);
    expect(validateSchedule(weekly({ durationMinutes: 1.5 })).join()).toMatch(/1 to 1440/);
    expect(validateSchedule(weekly({ weekdays: ['mon', 'mon'] })).join()).toMatch(/unique/);
    expect(validateSchedule({ type: 'once', startsAt: t('2026-06-02T00:00:00Z'), endsAt: t('2026-06-01T00:00:00Z') }).join()).toMatch(/after/);
    expect(validateSchedule({ type: 'once', startsAt: t('2026-06-01T00:00:00Z'), endsAt: t('2026-07-02T00:00:00Z') }).join()).toMatch(/30 days/);
  });
  test('the contract rejects numeric offsets, path-like or empty zones, odd weekdays and times, and empty updates', () => {
    const ok = { name: 'Weekly deploy', schedule: { type: 'weekly', timezone: 'Europe/Berlin', weekdays: ['sun'], startTime: '02:00', durationMinutes: 120 } };
    expect(MaintenanceCreate.safeParse(ok).success).toBe(true);
    const bad = (schedule: object) => MaintenanceCreate.safeParse({ name: 'x', schedule }).success;
    const w = ok.schedule;
    expect(bad({ ...w, timezone: '+05:00' })).toBe(false);
    expect(bad({ ...w, timezone: 'UTC+2' })).toBe(false);
    expect(bad({ ...w, timezone: '../etc/passwd' })).toBe(false);
    expect(bad({ ...w, timezone: '' })).toBe(false);
    expect(bad({ ...w, timezone: 'Europe' })).toBe(false);
    expect(bad({ ...w, timezone: 'Mars/Olympus' })).toBe(false); // right shape, unknown zone
    expect(bad({ ...w, weekdays: [] })).toBe(false);
    expect(bad({ ...w, weekdays: ['monday'] })).toBe(false);
    expect(bad({ ...w, weekdays: ['mon', 'mon'] })).toBe(false);
    expect(bad({ ...w, startTime: '24:00' })).toBe(false);
    expect(bad({ ...w, durationMinutes: 0 })).toBe(false);
    expect(bad({ ...w, durationMinutes: 1441 })).toBe(false);
    expect(bad({ ...w, durationMinutes: 59.5 })).toBe(false);
    expect(bad({ ...w, extra: 1 })).toBe(false);
    expect(bad({ type: 'once', startsAt: '2026-06-02T00:00:00Z', endsAt: '2026-06-01T00:00:00Z' })).toBe(false);
    expect(bad({ type: 'cron', expr: '* * * * *' })).toBe(false);
    expect(MaintenanceUpdate.safeParse({}).success).toBe(false);
    expect(MaintenanceUpdate.safeParse({ comment: 'only the reason' }).success).toBe(true);
    expect(MaintenanceUpdate.safeParse({ schedule: { ...w, timezone: 'Nope/Zone' } }).success).toBe(false);
  });
});

describe('matching, state and the DTO', () => {
  const rule = { _id: 'r1', severity: 'critical' as const, environmentId: 'e1' };
  const doc = (over: Partial<Parameters<typeof maintenanceMatches>[0]> = {}) => ({ enabled: true, schedule: weekly({ weekdays: [...WEEKDAYS], startTime: '00:00', durationMinutes: 1440 }), matchers: {}, ...over });
  const now = t('2026-06-03T10:00:00Z');
  test('matchers behave like a silence: AND across kinds, OR within one, empty = everything', () => {
    expect(maintenanceMatches(doc(), rule, now)).toBe(true);
    expect(maintenanceMatches(doc({ matchers: { ruleIds: ['r1', 'r2'] } }), rule, now)).toBe(true);
    expect(maintenanceMatches(doc({ matchers: { ruleIds: ['r2'] } }), rule, now)).toBe(false);
    expect(maintenanceMatches(doc({ matchers: { severities: ['warning'] } }), rule, now)).toBe(false);
    expect(maintenanceMatches(doc({ matchers: { severities: ['critical'], environmentIds: ['e1'] } }), rule, now)).toBe(true);
    expect(maintenanceMatches(doc({ matchers: { severities: ['critical'], environmentIds: ['e2'] } }), rule, now)).toBe(false);
  });
  test('a disabled window never matches', () => { expect(maintenanceMatches(doc({ enabled: false }), rule, now)).toBe(false); });
  test('state: disabled, scheduled, active, expired', () => {
    const w = { enabled: true, schedule: weekly({ weekdays: ['wed'], startTime: '09:00', durationMinutes: 60 }) };
    expect(maintenanceState(w, t('2026-06-03T09:30:00Z'))).toBe('active');
    expect(maintenanceState(w, t('2026-06-03T11:00:00Z'))).toBe('scheduled');
    expect(maintenanceState({ ...w, enabled: false }, t('2026-06-03T09:30:00Z'))).toBe('disabled');
    const once: Schedule = { type: 'once', startsAt: t('2026-06-03T09:00:00Z'), endsAt: t('2026-06-03T10:00:00Z') };
    expect(maintenanceState({ enabled: true, schedule: once }, t('2026-06-03T08:00:00Z'))).toBe('scheduled');
    expect(maintenanceState({ enabled: true, schedule: once }, t('2026-06-03T10:00:00Z'))).toBe('expired');
  });
  test('the DTO carries the computed state, the current and the next occurrence', () => {
    const w = { _id: 'w1', kind: 'maintenance' as const, orgId: 'o', projectId: 'p', name: 'Weekly', nameLower: 'weekly', comment: '', enabled: true, schedule: weekly({ weekdays: ['wed'], startTime: '09:00', durationMinutes: 60 }), matchers: {}, version: 1, createdBy: 'u', createdAt: now, updatedAt: now };
    const active = toMaintenanceDto(w, t('2026-06-03T09:30:00Z'));
    expect(active).toMatchObject({ state: 'active', activeNow: true, currentOccurrence: { startsAt: '2026-06-03T09:00:00.000Z', endsAt: '2026-06-03T10:00:00.000Z' }, nextOccurrence: { startsAt: '2026-06-10T09:00:00.000Z' } });
    const idle = toMaintenanceDto(w, t('2026-06-03T12:00:00Z'));
    expect(idle).toMatchObject({ state: 'scheduled', activeNow: false, currentOccurrence: null, nextOccurrence: { startsAt: '2026-06-10T09:00:00.000Z' } });
    const off = toMaintenanceDto({ ...w, enabled: false }, t('2026-06-03T09:30:00Z'));
    expect(off).toMatchObject({ state: 'disabled', activeNow: false, currentOccurrence: null, nextOccurrence: null });
    expect(toMaintenanceDto({ ...w, schedule: weekly({ timezone: 'Not/AZone' }) }, now)).toMatchObject({ state: 'disabled', activeNow: false }); // corrupt document: shown, never crashes the list
  });
});
