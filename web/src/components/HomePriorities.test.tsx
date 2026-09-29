import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HomePriorityCandidate } from "../homePriority";
import { HomePriorities } from "./HomePriorities";

const candidate = (changes: Partial<HomePriorityCandidate> = {}): HomePriorityCandidate => ({ id: "one", kind: "event-response", tier: 1, section: "attention", title: "Register for Canyon", detail: "Answers close in 4 hours", href: "/events/one", icon: "!", actionLabel: "Choose attendance", ...changes });

describe("HomePriorities", () => {
  it("renders one primary action, compact next actions and upcoming information", () => {
    const html = renderToStaticMarkup(<HomePriorities loading={false} onOpen={() => undefined} candidates={[
      candidate(),
      candidate({ id: "two", kind: "power", tier: 3, title: "Power report due soon" }),
      candidate({ id: "three", kind: "ministry-appointment", tier: 5, section: "upcoming", title: "Ministry appointment" }),
    ]} />);
    expect(html).toContain("Right now");
    expect(html).toContain("Register for Canyon");
    expect(html).toContain("Power report due soon");
    expect(html).toContain("Coming up");
    expect(html).toContain("Ministry appointment");
  });

  it("shows a calm state without deleting upcoming information", () => {
    const html = renderToStaticMarkup(<HomePriorities loading={false} onOpen={() => undefined} candidates={[candidate({ kind: "upcoming-event", tier: 5, section: "upcoming", title: "Foundry" })]} />);
    expect(html).toContain("You’re all caught up");
    expect(html).toContain("Foundry");
  });
});
