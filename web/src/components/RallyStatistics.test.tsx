vi.mock("../session", () => ({ useSession: () => ({}) }));
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RallyStatisticsView } from "./RallyStatistics";
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
