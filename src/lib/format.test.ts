import { describe, expect, it } from "vitest";
import { isValidReminderTime } from "@/lib/settings";
import { clockLabel, reminderOptions } from "./format";

describe("reminder choices", () => {
  it("run 05:00 to 21:00 in 15-minute steps and all pass the server rule", () => {
    const options = reminderOptions();
    expect(options[0]).toBe("05:00");
    expect(options.at(-1)).toBe("21:00");
    expect(options).toHaveLength(65);
    expect(options.every(isValidReminderTime)).toBe(true);
  });

  it("labels clock times", () => {
    expect(clockLabel("05:00")).toBe("5:00 AM");
    expect(clockLabel("12:15")).toBe("12:15 PM");
    expect(clockLabel("20:00")).toBe("8:00 PM");
  });
});
