import type { MaintenanceDto } from '@nexus/contracts';
import { describe, expect, test } from 'vitest';
import { bodyFromForm, describeSchedule, emptyForm, formFromWindow, formIssues, formatInZone, isoToLocalInput, knownZones, localInputToIso, utcShort } from './maintenance-model';

describe('maintenance window form', () => {
  test('a weekly form becomes the API body: days in week order, minutes as a number, matchers only when chosen', () => {
    const f = { ...emptyForm('Europe/Berlin'), name: ' Release ', weekdays: ['sun', 'sat'] as never, startTime: '01:30', durationMinutes: '90', severity: 'critical' };
    expect(bodyFromForm(f)).toEqual({
      name: 'Release', comment: '', enabled: true,
      schedule: { type: 'weekly', timezone: 'Europe/Berlin', weekdays: ['sat', 'sun'], startTime: '01:30', durationMinutes: 90 },
      matchers: { severities: ['critical'] },
    });
    expect(formIssues(f)).toEqual([]);
  });
  test('the form refuses what the server would refuse, with readable messages', () => {
    const f = emptyForm('Europe/Berlin');
    expect(formIssues({ ...f, name: 'x', weekdays: [] }).join()).toMatch(/at least|too small|Too small/i);
    expect(formIssues({ ...f, name: 'x', timezone: '+05:30' }).join()).toMatch(/IANA/);
    expect(formIssues({ ...f, name: 'x', timezone: 'Mars/Olympus' }).join()).toMatch(/Unknown time zone/);
    expect(formIssues({ ...f, name: 'x', durationMinutes: '0' }).length).toBeGreaterThan(0);
    expect(formIssues({ ...f, name: 'x', durationMinutes: '2000' }).length).toBeGreaterThan(0);
    expect(formIssues({ ...f, name: 'x', startTime: '' }).length).toBeGreaterThan(0);
    expect(formIssues({ ...f, name: 'x', type: 'once' })).toEqual(['Choose when the window starts and ends']);
    expect(formIssues({ ...f, name: 'x', type: 'once', onceStart: '2026-06-02T10:00', onceEnd: '2026-06-02T09:00' }).join()).toMatch(/after/);
  });
  test('an existing window loads into the form and back without losing anything', () => {
    const w: MaintenanceDto = {
      id: crypto.randomUUID(), projectId: crypto.randomUUID(), name: 'Nightly', comment: 'db backup', enabled: false,
      schedule: { type: 'weekly', timezone: 'America/New_York', weekdays: ['mon', 'fri'], startTime: '23:00', durationMinutes: 120 },
      matchers: { ruleIds: [crypto.randomUUID()], environmentIds: [crypto.randomUUID()] }, version: 3,
      state: 'disabled', activeNow: false, currentOccurrence: null, nextOccurrence: null, createdBy: crypto.randomUUID(), createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z',
    };
    const body = bodyFromForm(formFromWindow(w));
    expect(body).toMatchObject({ name: 'Nightly', comment: 'db backup', enabled: false, schedule: w.schedule, matchers: { ruleIds: w.matchers.ruleIds, environmentIds: w.matchers.environmentIds } });
  });
  test('datetime-local values round-trip through ISO in the browser zone', () => {
    const iso = '2026-06-02T09:15:00.000Z';
    expect(localInputToIso(isoToLocalInput(iso))).toBe(iso);
    expect(localInputToIso('')).toBe('');
    expect(localInputToIso('garbage')).toBe('');
    expect(isoToLocalInput('garbage')).toBe('');
  });
});

describe('plain-language rendering', () => {
  test('schedules read naturally', () => {
    expect(describeSchedule({ type: 'weekly', timezone: 'Europe/Berlin', weekdays: ['sun'], startTime: '02:00', durationMinutes: 120 })).toBe('Sun at 02:00 (Europe/Berlin) for 2 h');
    expect(describeSchedule({ type: 'weekly', timezone: 'UTC', weekdays: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], startTime: '23:30', durationMinutes: 45 })).toBe('every day at 23:30 (UTC) for 45 min');
    expect(describeSchedule({ type: 'weekly', timezone: 'UTC', weekdays: ['fri', 'mon'], startTime: '00:00', durationMinutes: 90 })).toBe('Mon, Fri at 00:00 (UTC) for 1 h 30 min');
    expect(describeSchedule({ type: 'once', startsAt: '2026-06-01T10:00:00.000Z', endsAt: '2026-06-01T12:00:00.000Z' })).toBe('once: 2026-06-01 10:00 to 2026-06-01 12:00 UTC');
  });
  test('instants are shown in the window\'s own zone (daylight saving included) and in UTC', () => {
    expect(formatInZone('2026-03-29T01:00:00.000Z', 'Europe/Berlin')).toMatch(/29 Mar 2026.*03:00/); // the first moment after the spring-forward jump
    expect(formatInZone('2026-03-28T01:00:00.000Z', 'Europe/Berlin')).toMatch(/28 Mar 2026.*02:00/);
    expect(formatInZone('2026-06-01T10:00:00.000Z', 'No/Such_Zone')).toMatch(/10:00/); // unknown zone: falls back to UTC rather than throwing
    expect(formatInZone('nope', 'UTC')).toBe('—');
    expect(utcShort('2026-06-01T10:05:00.000Z')).toBe('2026-06-01 10:05 UTC');
  });
  test('the zone list always offers UTC', () => { expect(knownZones()).toContain('UTC'); });
});
