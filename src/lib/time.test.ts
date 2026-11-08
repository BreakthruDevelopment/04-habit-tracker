import { describe, expect, it } from "vitest";
import {
  TIME_ZONES,
  addDays,
  isValidDate,
  isValidIsoWeek,
  isValidTimeZone,
  isoWeek,
  isoWeekday,
  isoWeeksInYear,
  localToday,
  normalizeTimeZone,
  parseIsoWeek,
  shiftIsoWeek,
  weekBounds,
  weekIndex,
  weekStart,
} from "./time";

const at = (iso: string) => new Date(iso);

describe("localToday", () => {
  it("is the local date, not the UTC one (11:30 PM in Denver)", () => {
    expect(localToday("America/Denver", at("2026-11-08T06:30:00Z"))).toBe("2026-11-07");
    expect(localToday("UTC", at("2026-11-08T06:30:00Z"))).toBe("2026-11-08");
  });

  it("handles US spring forward (2026-03-08) in Denver", () => {
    // 01:59 MST is 08:59 UTC; the clock then jumps to 03:00 MDT.
    expect(localToday("America/Denver", at("2026-03-08T06:59:59Z"))).toBe("2026-03-07"); // 23:59:59 MST on the 7th
    expect(localToday("America/Denver", at("2026-03-08T07:00:00Z"))).toBe("2026-03-08"); // 00:00 MST
    expect(localToday("America/Denver", at("2026-03-08T08:59:59Z"))).toBe("2026-03-08"); // 01:59:59 MST
    expect(localToday("America/Denver", at("2026-03-08T09:00:00Z"))).toBe("2026-03-08"); // 03:00 MDT
    expect(localToday("America/Denver", at("2026-03-09T05:59:59Z"))).toBe("2026-03-08"); // 23:59:59 MDT, a 23-hour day
    expect(localToday("America/Denver", at("2026-03-09T06:00:00Z"))).toBe("2026-03-09");
  });

  it("handles US fall back (2026-11-01) in Denver", () => {
    expect(localToday("America/Denver", at("2026-11-01T05:59:59Z"))).toBe("2026-10-31");
    expect(localToday("America/Denver", at("2026-11-01T06:00:00Z"))).toBe("2026-11-01"); // 00:00 MDT
    expect(localToday("America/Denver", at("2026-11-01T08:30:00Z"))).toBe("2026-11-01"); // 01:30 MDT
    expect(localToday("America/Denver", at("2026-11-01T09:30:00Z"))).toBe("2026-11-01"); // 01:30 MST, the repeated hour
    expect(localToday("America/Denver", at("2026-11-02T06:59:59Z"))).toBe("2026-11-01"); // 23:59:59 MST, a 25-hour day
    expect(localToday("America/Denver", at("2026-11-02T07:00:00Z"))).toBe("2026-11-02");
  });

  it("handles Lord Howe's 30-minute shift (+11:00 to +10:30 on 2026-04-05)", () => {
    // Before: UTC+11. 2026-04-04T12:59Z is 23:59 on the 4th.
    expect(localToday("Australia/Lord_Howe", at("2026-04-04T12:59:59Z"))).toBe("2026-04-04");
    expect(localToday("Australia/Lord_Howe", at("2026-04-04T13:00:00Z"))).toBe("2026-04-05");
    // After the shift (02:00 local falls back to 01:30), midnight of the 6th is 13:30Z on the 5th.
    expect(localToday("Australia/Lord_Howe", at("2026-04-05T13:29:59Z"))).toBe("2026-04-05");
    expect(localToday("Australia/Lord_Howe", at("2026-04-05T13:30:00Z"))).toBe("2026-04-06");
  });

  it("handles Kolkata (+05:30, no DST) all year", () => {
    expect(localToday("Asia/Kolkata", at("2026-06-01T18:29:59Z"))).toBe("2026-06-01");
    expect(localToday("Asia/Kolkata", at("2026-06-01T18:30:00Z"))).toBe("2026-06-02");
    expect(localToday("Asia/Kolkata", at("2026-12-31T18:30:00Z"))).toBe("2027-01-01");
  });

  it("covers the extremes at one instant: UTC-11 and UTC+14 differ by two dates", () => {
    const now = at("2026-11-08T11:00:00Z");
    expect(localToday("Pacific/Pago_Pago", now)).toBe("2026-11-08");
    expect(localToday("Pacific/Kiritimati", now)).toBe("2026-11-09");
  });

  it("rejects an unknown zone", () => {
    expect(() => localToday("Mars/Olympus", at("2026-01-01T00:00:00Z"))).toThrow(RangeError);
  });
});

describe("time zone validation", () => {
  it("accepts real zones, UTC and the old spellings a browser may report", () => {
    for (const z of ["UTC", "America/Denver", "Asia/Kolkata", "Asia/Calcutta", "Australia/Lord_Howe", "Europe/Kyiv", "Europe/Kiev"]) {
      expect(isValidTimeZone(z), z).toBe(true);
    }
  });

  it("stores the modern name", () => {
    expect(normalizeTimeZone("Asia/Calcutta")).toBe("Asia/Kolkata");
    expect(normalizeTimeZone("Europe/Kiev")).toBe("Europe/Kyiv");
    expect(normalizeTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata");
  });

  it("rejects junk, wrong case, offsets and non-strings", () => {
    for (const z of ["", "Mars/Olympus", "asia/kolkata", "utc", "+05:30", "EST5EDT; drop table", "America/Denver ", null, undefined, 5]) {
      expect(isValidTimeZone(z), String(z)).toBe(false);
    }
  });

  it("lists each zone once, sorted, with the zones the tests rely on", () => {
    expect(new Set(TIME_ZONES).size).toBe(TIME_ZONES.length);
    expect([...TIME_ZONES].sort()).toEqual([...TIME_ZONES]);
    for (const z of ["UTC", "America/Denver", "Europe/London", "Asia/Kolkata", "Australia/Lord_Howe", "Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
      expect(TIME_ZONES).toContain(z);
    }
  });
});

describe("dates", () => {
  it("validates real calendar dates only", () => {
    expect(isValidDate("2028-02-29")).toBe(true);
    for (const d of ["2027-02-29", "2026-13-01", "2026-00-10", "2026-1-1", "26-01-01", "2026-01-01T00:00", "", 5]) {
      expect(isValidDate(d), String(d)).toBe(false);
    }
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
  });

  it("knows the weekday", () => {
    expect(isoWeekday("2026-11-08")).toBe(7); // a Sunday
    expect(isoWeekday("2026-11-09")).toBe(1);
    expect(isoWeekday("1970-01-01")).toBe(4);
    expect(isoWeekday("1969-12-31")).toBe(3);
  });
});

describe("ISO weeks", () => {
  it("labels year-end dates with the ISO week-year", () => {
    expect(isoWeek("2027-01-01")).toBe("2026-W53");
    expect(isoWeek("2024-12-30")).toBe("2025-W01");
    expect(isoWeek("2026-12-28")).toBe("2026-W53");
    expect(isoWeek("2027-01-03")).toBe("2026-W53");
    expect(isoWeek("2027-01-04")).toBe("2027-W01");
    expect(isoWeek("2021-01-03")).toBe("2020-W53");
    expect(isoWeek("2026-01-01")).toBe("2026-W01");
  });

  it("knows which years have 53 weeks", () => {
    const with53 = [2020, 2026, 2032].filter((y) => isoWeeksInYear(y) === 53);
    expect(with53).toEqual([2020, 2026, 2032]);
    for (const y of [2021, 2022, 2023, 2024, 2025, 2027, 2028, 2029, 2030]) expect(isoWeeksInYear(y), String(y)).toBe(52);
  });

  it("rejects weeks a year doesn't have", () => {
    for (const w of ["2027-W53", "2026-W54", "2026-W00", "2025-W53", "2026-W5", "2026W05", "26-W05", "2026-w05", "", "2026-W05 "]) {
      expect(isValidIsoWeek(w), w).toBe(false);
      expect(() => parseIsoWeek(w), w).toThrowError(/Invalid week/);
    }
    expect(isValidIsoWeek("2026-W53")).toBe(true);
    expect(isValidIsoWeek(undefined)).toBe(false);
  });

  it("parses a label to the Monday, and bounds run Monday to Sunday", () => {
    expect(parseIsoWeek("2026-W53")).toBe("2026-12-28");
    expect(weekBounds("2027-01-01")).toEqual({ monday: "2026-12-28", sunday: "2027-01-03" });
    expect(parseIsoWeek("2025-W01")).toBe("2024-12-30");
    expect(weekStart("2026-11-08")).toBe("2026-11-02");
    expect(weekBounds("2026-11-02")).toEqual({ monday: "2026-11-02", sunday: "2026-11-08" });
  });

  it("round-trips every week from 2020 to 2030", () => {
    let count = 0;
    for (let year = 2020; year <= 2030; year++) {
      for (let n = 1; n <= isoWeeksInYear(year); n++) {
        const label = `${year}-W${String(n).padStart(2, "0")}`;
        const monday = parseIsoWeek(label);
        expect(isoWeek(monday), label).toBe(label);
        expect(isoWeekday(monday), label).toBe(1);
        // Every day of the week maps back to the same label.
        for (let d = 0; d < 7; d++) expect(isoWeek(addDays(monday, d)), `${label}+${d}`).toBe(label);
        count++;
      }
    }
    expect(count).toBe(52 * 9 + 53 * 2);
    expect(isValidIsoWeek("2026-W53")).toBe(true);
  });

  it("agrees with Date-based ISO week numbers for every day of 2020 to 2030", () => {
    // Independent algorithm: shift to the Thursday of the week, then count weeks from 1 January.
    for (let day = Date.UTC(2020, 0, 1); day <= Date.UTC(2030, 11, 31); day += 86_400_000) {
      const d = new Date(day);
      const dow = (d.getUTCDay() + 6) % 7;
      const thu = new Date(day + (3 - dow) * 86_400_000);
      const week = Math.floor((thu.getTime() - Date.UTC(thu.getUTCFullYear(), 0, 1)) / (7 * 86_400_000)) + 1;
      const label = `${thu.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
      expect(isoWeek(d.toISOString().slice(0, 10)), d.toISOString()).toBe(label);
    }
  });

  it("weekIndex goes up by exactly 1 every week, across every year end", () => {
    let monday = "2018-01-01";
    let prev = weekIndex(monday);
    while (monday < "2032-01-01") {
      monday = addDays(monday, 7);
      const idx = weekIndex(monday);
      expect(idx).toBe(prev + 1);
      // The whole week shares one index.
      expect(weekIndex(addDays(monday, 6))).toBe(idx);
      prev = idx;
    }
    expect(weekIndex("2001-01-01")).toBe(0);
    expect(weekIndex("2026-12-28")).toBe(weekIndex("2027-01-03"));
    expect(weekIndex("2027-01-04")).toBe(weekIndex("2026-12-28") + 1);
    expect(weekIndex("2024-12-30") - weekIndex("2024-12-23")).toBe(1);
  });

  it("moves between weeks across year ends", () => {
    expect(shiftIsoWeek("2026-W52", 1)).toBe("2026-W53");
    expect(shiftIsoWeek("2026-W53", 1)).toBe("2027-W01");
    expect(shiftIsoWeek("2027-W01", -1)).toBe("2026-W53");
    expect(shiftIsoWeek("2025-W52", 1)).toBe("2026-W01");
  });
});
