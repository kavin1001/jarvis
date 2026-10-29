import { ApiError, unreachable } from "../api";
import { isCrossing } from "../geofence";
import { parseLink } from "../links";
import { plainText } from "../Markdown";
import { fileSize } from "../taskFiles";
import { relativeTime } from "../ui";

describe("plainText", () => {
  it("drops markdown so replies read aloud cleanly", () => {
    expect(plainText("## Plan\n- **Book** the *train*\n- Pack `charger`")).toBe("Plan\nBook the train\nPack charger");
  });

  it("keeps link labels, including tap-to-call and text links", () => {
    expect(plainText("[Call Mom](tel:+15551234567) or [Text Sam](sms:+15551234567?body=Late)")).toBe("Call Mom or Text Sam");
    expect(plainText("See [the menu](https://example.com/menu).")).toBe("See the menu.");
  });

  it("reads a table one row at a time", () => {
    expect(plainText("| Flight | Price |\n|---|---|\n| BA 117 | $420 |")).toBe("Flight, Price\nBA 117, $420");
  });

  it("leaves underscores and asterisks inside words alone", () => {
    expect(plainText("snake_case_name and 2*3*4")).toBe("snake_case_name and 2*3*4");
  });
});

describe("parseLink", () => {
  it("reads Shortcut and Siri links", () => {
    expect(parseLink("jarvis://ask?text=What%27s%20up&voice=1")).toMatchObject({ kind: "ask", text: "What's up", voice: true });
    expect(parseLink("jarvis://ask")).toMatchObject({ kind: "listen", handsFree: false });
    expect(parseLink("jarvis://listen?handsfree=yes")).toMatchObject({ kind: "listen", handsFree: true });
    expect(parseLink("jarvis:///new")).toMatchObject({ kind: "new" });
    expect(parseLink("jarvis://unknown")).toBeNull();
  });

  it("reads the web app's paths and the Android share target", () => {
    expect(parseLink("https://jarvis.example.com/ask?text=hi")).toMatchObject({ kind: "ask", text: "hi" });
    // A link that arrives twice (as text and url) is kept once.
    expect(parseLink("https://jarvis.example.com/share?title=Read&text=https%3A%2F%2Fa.example&url=https%3A%2F%2Fa.example")).toMatchObject({
      kind: "draft",
      text: "Read\nhttps://a.example",
    });
    expect(parseLink("https://jarvis.example.com/share")).toBeNull();
  });

  it("gives each command a new id, so the same link twice still runs", () => {
    expect(parseLink("jarvis://new")!.id).not.toBe(parseLink("jarvis://new")!.id);
  });
});

describe("place reminders", () => {
  it("ignores the first report and repeats, and acts only on the event asked for", () => {
    expect(isCrossing(undefined, true, "arrive")).toBe(false); // already home when watching started
    expect(isCrossing(true, true, "arrive")).toBe(false); // the app relaunched while home
    expect(isCrossing(false, true, "arrive")).toBe(true); // got home
    expect(isCrossing(false, true, "leave")).toBe(false);
    expect(isCrossing(true, false, "leave")).toBe(true); // left
    expect(isCrossing(true, false, "arrive")).toBe(false);
  });
});

describe("formatting", () => {
  it("sizes files", () => {
    expect(fileSize(512)).toBe("512 B");
    expect(fileSize(2048)).toBe("2 KB");
    expect(fileSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("says how long ago", () => {
    const ago = (ms: number) => relativeTime(new Date(Date.now() - ms).toISOString());
    expect(ago(10_000)).toBe("just now");
    expect(ago(5 * 60_000)).toBe("5 min ago");
    expect(ago(3 * 3600_000)).toBe("3 h ago");
  });
});

describe("unreachable", () => {
  it("tells a request that never got through from an error the server sent", () => {
    expect(unreachable(new TypeError("Network request failed"))).toBe(true);
    expect(unreachable(new Error("Unable to resolve host"))).toBe(true);
    expect(unreachable(new ApiError("Not found", 404))).toBe(false);
  });
});
