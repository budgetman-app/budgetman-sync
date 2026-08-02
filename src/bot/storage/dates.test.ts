import { toJerusalemDate } from "./dates.js";

describe("toJerusalemDate", () => {
  it("keeps a FIBI 21:00Z stamp on the NEXT (Israeli) calendar day", () => {
    // FIBI stamps at 21:00 UTC = 00:00 Asia/Jerusalem the following day.
    // A UTC formatter would report 07-30 and shift/duplicate the row.
    expect(toJerusalemDate("2026-07-30T21:00:00.000Z")).toBe("2026-07-31");
  });

  it("keeps a UTC-midnight purchase date on the same Israeli day", () => {
    // isracardPending emits Date.UTC(...) midnight; in Israel that is still the
    // same calendar day (03:00 local), so the base key stays stable.
    expect(toJerusalemDate("2026-07-03T00:00:00.000Z")).toBe("2026-07-03");
  });

  it("formats a mid-day stamp as its Israeli calendar date", () => {
    expect(toJerusalemDate("2026-07-03T13:27:00.000Z")).toBe("2026-07-03");
  });

  it("accepts a Date instance", () => {
    expect(toJerusalemDate(new Date("2026-01-15T10:00:00.000Z"))).toBe(
      "2026-01-15",
    );
  });
});
