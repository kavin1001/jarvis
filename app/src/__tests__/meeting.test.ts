import { addResult, elapsed, fullText, meetingMessage, utf8ToBase64 } from "../meeting";

describe("meeting transcript", () => {
  it("keeps final results and shows partial ones until replaced", () => {
    let t = { committed: "", live: "" };
    t = addResult(t, "let's start", false);
    expect(fullText(t)).toBe("let's start");
    t = addResult(t, "Let's start.", true);
    t = addResult(t, "budget is", false);
    t = addResult(t, "budget is fine", false);
    expect(t).toEqual({ committed: "Let's start.", live: "budget is fine" });
    t = addResult(t, "The budget is fine.", true);
    expect(fullText(t)).toBe("Let's start. The budget is fine.");
    expect(addResult(t, "  ", true).committed).toBe("Let's start. The budget is fine.");
  });

  it("formats the timer", () => {
    expect(elapsed(0)).toBe("0:00");
    expect(elapsed(245_000)).toBe("4:05");
    expect(elapsed(3_729_000)).toBe("1:02:09");
  });

  it("encodes UTF-8 text as base64", () => {
    for (const s of ["", "a", "ab", "abc", "Café ☕ – naïve 日本"]) expect(utf8ToBase64(s)).toBe(Buffer.from(s, "utf8").toString("base64"));
  });

  it("asks for notes with the transcript attached", () => {
    const { text, doc } = meetingMessage("We agreed to ship Friday.", new Date(2026, 9, 29, 15, 5), 32 * 60_000);
    expect(doc).toEqual({ name: "Meeting transcript, Thu, Oct 29 3:05 PM.txt", media_type: "text/plain", data: utf8ToBase64("We agreed to ship Friday.") });
    expect(text).toMatch(/^I recorded a meeting \(32 minutes, started Thu, Oct 29 at 3:05 PM\)/);
    expect(text).toMatch(/save that as a note titled "Meeting notes, Thu, Oct 29"\. /);
    expect(text).toMatch(/offer, in one line, to put the notes in a Google Doc to share and to set reminders for action items with a date\.$/);
  });
});
