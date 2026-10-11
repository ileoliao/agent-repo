// 5-field cron matcher: minute hour day-of-month month day-of-week.
// Supports "*", "*/n", "a-b", "a-b/n" and comma lists. Day-of-week 0-7 (0 and 7 = Sunday).
// Standard semantics: when both day-of-month and day-of-week are restricted, either may match.
// Evaluated in the machine's local time zone.
const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

export function validateCron(expr: string): string | undefined {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) {
    return `cron "${expr}" must have 5 fields`;
  }
  for (let i = 0; i < 5; i++) {
    try {
      expand(f[i], RANGES[i][0], RANGES[i][1]);
    } catch (e: any) {
      return `cron "${expr}": ${e.message}`;
    }
  }
  return undefined;
}

/** UTC minute, `YYYY-MM-DDTHH:MM`. This is the identity stored for "already fired". */
export function minuteKey(d: Date): string {
  return d.toISOString().slice(0, 16);
}

/**
 * True when a cron hit exists after `lastKey` and up to `now`.
 * No history means nothing was missed (the live tick still fires the current minute).
 * A gap longer than `maxMinutes` counts as missed without walking every minute.
 */
export function missedSince(expr: string, lastKey: string | undefined, now: Date, maxMinutes = 48 * 60): boolean {
  if (!lastKey || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(lastKey)) return false;
  const startMs = new Date(`${lastKey}:00.000Z`).getTime();
  if (Number.isNaN(startMs) || startMs > now.getTime()) return false;
  const gapMin = Math.floor((now.getTime() - startMs) / 60_000);
  if (gapMin > maxMinutes) return true;
  for (let t = startMs + 60_000; t <= now.getTime(); t += 60_000) {
    if (cronMatches(expr, new Date(t))) return true;
  }
  return false;
}

/**
 * First minute strictly after `from` that matches, searched up to `maxDays` ahead. Undefined when none is found.
 * Used for the "next run" display only; the scheduler still decides with cronMatches on each tick.
 */
export function nextMatch(expr: string, from: Date, maxDays = 8): Date | undefined {
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  for (let t = start.getTime() + 60_000, i = 0; i < maxDays * 24 * 60; i++, t += 60_000) {
    const d = new Date(t);
    if (cronMatches(expr, d)) { return d; }
  }
  return undefined;
}

export function cronMatches(expr: string, d: Date): boolean {
  const f = expr.trim().split(/\s+/);
  const [min, hour, dom, mon, dow] = f.map((x, i) => expand(x, RANGES[i][0], RANGES[i][1]));
  if (!min.has(d.getMinutes()) || !hour.has(d.getHours()) || !mon.has(d.getMonth() + 1)) {
    return false;
  }
  const day = d.getDay();
  const domOk = dom.has(d.getDate());
  const dowOk = dow.has(day) || (day === 0 && dow.has(7));
  const domStar = f[2] === '*';
  const dowStar = f[4] === '*';
  if (domStar && dowStar) { return true; }
  if (domStar) { return dowOk; }
  if (dowStar) { return domOk; }
  return domOk || dowOk;
}

function expand(field: string, lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) {
      throw new Error(`bad field "${part}"`);
    }
    let a = lo;
    let b = hi;
    if (m[1] !== '*') {
      const [x, y] = m[1].split('-').map(Number);
      a = x;
      b = y ?? (m[2] ? hi : x);
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (a < lo || b > hi || a > b || step < 1) {
      throw new Error(`out of range "${part}"`);
    }
    for (let v = a; v <= b; v += step) {
      out.add(v);
    }
  }
  return out;
}
