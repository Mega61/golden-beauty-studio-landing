import { describe, expect, it } from "vitest";

import {
  addMinutes,
  bogotaToUtcStamp,
  buildDays,
  dayPartOf,
  fill,
  formatDuration,
  formatPhoneInput,
  formatTime,
  googleCalendarUrl,
  groupByDayPart,
  icsFile,
  isDayOpen,
  isPlausiblePhone,
  weekdayOf,
  whatsappLink,
} from "./booking";

describe("isPlausiblePhone", () => {
  it.each([
    ["3001234567", true],
    ["300 123 4567", true],
    ["+57 300 123 4567", true],
    ["573001234567", true],
    ["+1 415 555 0100", true],
    ["300123456", false],
    ["6041234567", false],
    ["+57 604 123 4567", false],
    ["", false],
  ])("%s → %s", (raw, ok) => expect(isPlausiblePhone(raw)).toBe(ok));
});

describe("formatPhoneInput", () => {
  it("groups a Colombian mobile as it is typed", () => {
    expect(formatPhoneInput("300")).toBe("300");
    expect(formatPhoneInput("30012")).toBe("300 12");
    expect(formatPhoneInput("3001234567")).toBe("300 123 4567");
    expect(formatPhoneInput("30012345678")).toBe("300 123 4567");
  });
  it("leaves a foreign number alone", () => {
    expect(formatPhoneInput("+1 415")).toBe("+1 415");
  });
});

describe("days", () => {
  it("counts from the studio's today, across a month end", () => {
    expect(buildDays("2026-10-30", 4)).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });

  it("knows the weekday from the date alone", () => {
    expect(weekdayOf("2026-10-18")).toBe(0); // domingo
    expect(weekdayOf("2026-10-17")).toBe(6);
  });

  const lina = { offWeekdays: [0], closedDates: ["2026-10-20"], openDates: [] };
  const dani = { offWeekdays: [0, 1], closedDates: [], openDates: ["2026-10-18"] };

  it("a day is open if anyone works it", () => {
    expect(isDayOpen("2026-10-18", [lina])).toBe(false);
    expect(isDayOpen("2026-10-18", [lina, dani])).toBe(true);
    expect(isDayOpen("2026-10-20", [lina])).toBe(false);
    expect(isDayOpen("2026-10-20", [lina, dani])).toBe(true);
  });

  it("never closes a day it knows nothing about", () => {
    expect(isDayOpen("2026-10-18", [])).toBe(true);
    expect(isDayOpen("2026-10-18", [undefined])).toBe(true);
  });
});

describe("times", () => {
  it("12-hour clock, the way Colombia reads it", () => {
    expect(formatTime("09:00", "es")).toBe("9:00 a. m.");
    expect(formatTime("12:30", "es")).toBe("12:30 p. m.");
    expect(formatTime("00:15", "en")).toBe("12:15 AM");
    expect(formatTime("17:45", "en")).toBe("5:45 PM");
  });

  it("splits the day the way people say it", () => {
    expect(dayPartOf("11:59")).toBe("morning");
    expect(dayPartOf("12:00")).toBe("afternoon");
    expect(dayPartOf("17:00")).toBe("evening");
    const grouped = groupByDayPart([{ time: "09:00" }, { time: "18:00" }]);
    expect(grouped.map((g) => g.part)).toEqual(["morning", "evening"]);
  });

  it("adds minutes and durations", () => {
    expect(addMinutes("10:30", 150)).toBe("13:00");
    expect(formatDuration(45, "es")).toBe("45 min");
    expect(formatDuration(120, "es")).toBe("2 h");
    expect(formatDuration(150, "en")).toBe("2 h 30 min");
  });
});

describe("calendar", () => {
  const appt = {
    title: "Golden Beauty Studio — Semipermanente",
    date: "2026-10-16",
    time: "10:00",
    durationMin: 60,
    location: "Calle 69 Sur #43a - 41, Sabaneta",
    details: "Con Lina",
  };

  it("Bogotá is UTC-5, so 10:00 there is 15:00Z", () => {
    expect(bogotaToUtcStamp("2026-10-16", "10:00")).toBe("20261016T150000Z");
    expect(bogotaToUtcStamp("2026-10-16", "22:00", 180)).toBe("20261017T060000Z");
  });

  it("Google link carries start and end in UTC", () => {
    expect(googleCalendarUrl(appt)).toContain("dates=20261016T150000Z%2F20261016T160000Z");
  });

  it("the .ics escapes commas and carries the reminders", () => {
    const ics = icsFile(appt, "x", new Date("2026-10-15T00:00:00Z"));
    expect(ics).toContain("LOCATION:Calle 69 Sur #43a - 41\\, Sabaneta");
    expect(ics).toContain("TRIGGER:-P1D");
    expect(ics.split("\r\n")[0]).toBe("BEGIN:VCALENDAR");
  });
});

describe("whatsapp + fill", () => {
  it("adds the country code to a bare mobile, once", () => {
    expect(whatsappLink("3014445566", "hola")).toBe("https://wa.me/573014445566?text=hola");
    expect(whatsappLink("573014445566", "a b")).toBe("https://wa.me/573014445566?text=a%20b");
  });
  it("fills placeholders and leaves unknown ones visible", () => {
    expect(fill("{a} y {b}", { a: "1" })).toBe("1 y {b}");
  });
});
