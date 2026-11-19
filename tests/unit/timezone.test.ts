import { afterEach, describe, expect, it } from 'vitest';
import { addDays, localDateString, localDayRangeToUtc, localStamp, setShopTimeZone, shopTimeZone, toLocalDateTime } from '../../src/shared/clock';

afterEach(() => setShopTimeZone(undefined));

describe('the shop time zone (identical on every operating system)', () => {
  it('India (UTC+5:30): the day starts at 18:30 UTC the evening before', () => {
    setShopTimeZone('Asia/Kolkata');
    expect(shopTimeZone()).toBe('Asia/Kolkata');
    expect(localDateString(new Date('2026-10-31T19:00:00Z'))).toBe('2026-11-01'); // 00:30 on 1 November
    expect(localDateString(new Date('2026-10-31T17:30:00Z'))).toBe('2026-10-31'); // 23:00 on 31 October
    expect(toLocalDateTime('2026-10-31T19:00:00.000Z')).toBe('2026-11-01 00:30');
    expect(localStamp(new Date('2026-11-07T10:00:00Z'))).toBe('20261107-153000');
    expect(localDayRangeToUtc('2026-11-01', '2026-11-01')).toEqual({ fromUtc: '2026-10-31T18:30:00.000Z', toUtcExclusive: '2026-11-01T18:30:00.000Z' });
  });

  it('gives the same answers whatever zone the computer itself is set to', () => {
    for (const machine of ['UTC', 'America/Los_Angeles', 'Pacific/Auckland', 'Asia/Kolkata']) {
      setShopTimeZone('Asia/Kolkata');
      const before = process.env.TZ;
      process.env.TZ = machine; // on Linux this really changes the computer's zone; on Windows it is ignored: the answers must be the same either way
      try {
        expect(toLocalDateTime('2026-10-31T19:00:00.000Z')).toBe('2026-11-01 00:30');
        expect(localDayRangeToUtc('2026-11-02')).toEqual({ fromUtc: '2026-11-01T18:30:00.000Z' });
      } finally {
        if (before === undefined) delete process.env.TZ;
        else process.env.TZ = before;
      }
    }
  });

  it('copes with daylight saving (a 23-hour day), and with zones west of UTC', () => {
    setShopTimeZone('America/New_York');
    const spring = localDayRangeToUtc('2026-03-08', '2026-03-08'); // clocks go forward that day
    expect(spring).toEqual({ fromUtc: '2026-03-08T05:00:00.000Z', toUtcExclusive: '2026-03-09T04:00:00.000Z' });
    const autumn = localDayRangeToUtc('2026-11-01', '2026-11-01'); // clocks go back: a 25-hour day
    expect(autumn).toEqual({ fromUtc: '2026-11-01T04:00:00.000Z', toUtcExclusive: '2026-11-02T05:00:00.000Z' });
    expect(localDateString(new Date('2026-07-04T03:30:00Z'))).toBe('2026-07-03'); // still the evening of the 3rd in New York
  });

  it('UTC, and a zone with a half-day shift', () => {
    setShopTimeZone('UTC');
    expect(localDayRangeToUtc('2026-11-01', '2026-11-03')).toEqual({ fromUtc: '2026-11-01T00:00:00.000Z', toUtcExclusive: '2026-11-04T00:00:00.000Z' });
    setShopTimeZone('Pacific/Auckland');
    expect(localDateString(new Date('2026-11-07T12:30:00Z'))).toBe('2026-11-08'); // 01:30 the next day
  });

  it('rejects an unknown zone and bad dates; calendar arithmetic needs no zone at all', () => {
    expect(() => setShopTimeZone('Mars/Olympus')).toThrow(/unknown time zone/);
    expect(() => localDayRangeToUtc('2026-02-30')).toThrow();
    expect(() => localDayRangeToUtc('01/11/2026')).toThrow();
    expect(() => localDayRangeToUtc('2026-11-05', '2026-11-01')).toThrow();
    expect(addDays('2026-11-07', -89)).toBe('2026-08-10');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29'); // leap year
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
