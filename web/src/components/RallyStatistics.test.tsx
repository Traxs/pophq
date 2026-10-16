vi.mock("../session", () => ({ useSession: () => ({}) }));
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RallyStatisticsView, suggestedBattleEvents } from "./RallyStatistics";
describe("battle statistics card",()=>{
 it("labels session time and calls without claiming in-game participation",()=>{
 const html=renderToStaticMarkup(<RallyStatisticsView error="" refresh={()=>{}} stats={{trackingSince:1000,updatedAt:2000,totals:{sessions:2,durationMs:5400000,attacks:3,counters:2,incoming:8},recent:[],current:null}}/>);
 expect(html).toContain("1h 30m");expect(html).toContain("Rallies called");expect(html).toContain("not verified in-game");
 });
 it("distinguishes absent historical tracking from a measured zero",()=>{
 const html=renderToStaticMarkup(<RallyStatisticsView error="" refresh={()=>{}} stats={{trackingSince:null,updatedAt:null,totals:{sessions:0,durationMs:0,attacks:0,counters:0,incoming:0},recent:[],current:null}}/>);
 expect(html).toContain("earlier tests are not included");
 });
});

it("suggests UTC battle-day events before nearer events on another day",()=>{
 const events=[{eventId:"other",startsAt:"2026-10-17T00:01:00Z"},{eventId:"same",startsAt:"2026-10-16T12:00:00Z"}] as import("../api").EventListItem[];
 expect(suggestedBattleEvents(events,Date.parse("2026-10-16T23:59:00Z")).map(e=>e.eventId)).toEqual(["same","other"]);
 expect(events[0]?.eventId).toBe("other");
});
