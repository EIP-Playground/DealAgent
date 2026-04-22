export interface ParsedUtcTimestamp {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatDateOnly(date: Date): string {
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
  ].join("-");
}

export function parseDateOnly(raw: unknown, fieldName: string): Date {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`${fieldName} is required`);
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) {
    throw new Error(`${fieldName} must use YYYY-MM-DD`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`${fieldName} must use YYYY-MM-DD`);
  }
  return parsed;
}

export function formatUtcTimestamp(date: Date): string {
  return `${formatDateOnly(date)} ${pad(date.getUTCHours())}:${pad(
    date.getUTCMinutes(),
  )}:${pad(date.getUTCSeconds())}`;
}

export function nowUtcTimestamp(): string {
  const now = new Date();
  now.setUTCMilliseconds(0);
  return formatUtcTimestamp(now);
}

export function futureUtcTimestamp(minutes: number): string {
  const now = new Date(Date.now() + minutes * 60_000);
  now.setUTCMilliseconds(0);
  return formatUtcTimestamp(now);
}

export function addDays(date: Date, days: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

export function todayLocalDateOnly(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

export function dateRangeInclusive(fromDate: Date, toDate: Date): Date[] {
  const result: Date[] = [];
  for (
    let current = fromDate;
    current.getTime() <= toDate.getTime();
    current = addDays(current, 1)
  ) {
    result.push(current);
  }
  return result;
}

export function dateRangeExclusiveEnd(checkIn: Date, checkOut: Date): Date[] {
  const result: Date[] = [];
  for (
    let current = checkIn;
    current.getTime() < checkOut.getTime();
    current = addDays(current, 1)
  ) {
    result.push(current);
  }
  return result;
}
