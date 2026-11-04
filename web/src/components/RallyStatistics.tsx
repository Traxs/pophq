import { useEffect, useState } from "react";
import type { RallyStatsView, BattleSummary, EventListItem } from "../api";
import { useSession } from "../session";
type RallyEventOption = Pick<EventListItem,"eventId"|"title"|"startsAt">;
const duration = (ms:number) => `${Math.floor(ms/3600000)}h ${Math.floor(ms/60000)%60}m`;
// Game event dates use UTC, matching the event schedule rather than the viewer's timezone.
export function suggestedBattleEvents(events: RallyEventOption[], startedAt:number) {
 const day=new Date(startedAt).toISOString().slice(0,10);
 return [...events].sort((a,b)=>Number(b.startsAt.slice(0,10)===day)-Number(a.startsAt.slice(0,10)===day)
   || Math.abs(Date.parse(a.startsAt)-startedAt)-Math.abs(Date.parse(b.startsAt)-startedAt));
}
export function visibleBattleStats(stats:RallyStatsView):RallyStatsView {
 const hidden=[...stats.recent,...(stats.current?[stats.current]:[])].filter(row=>row.hidden);
 const totals={...stats.totals};
 for(const row of hidden) {totals.sessions=Math.max(0,totals.sessions-1);for(const key of ["durationMs","attacks","counters","incoming"] as const) totals[key]=Math.max(0,totals[key]-row[key]);}
 return {...stats,totals};
}
export function RallyStatistics({eventId}:{eventId?:string}) {
 const {api}=useSession();
 const [stats,setStats]=useState<RallyStatsView|null>(null);
 const [events,setEvents]=useState<RallyEventOption[]>([]);
 const [busy,setBusy]=useState<string|null>(null);
 const [error,setError]=useState("");
 const [refresh,setRefresh]=useState(0);
 useEffect(()=>{let mounted=true; api.rallyStats().then(data=>{if(mounted){setStats(data);setError("");}}).catch(()=>{if(mounted)setError("Battle statistics are temporarily unavailable.");});return()=>{mounted=false;};},[api,refresh]);
 useEffect(()=>{let mounted=true;api.rallyEventOptions().then(data=>{if(mounted)setEvents(data.items);}).catch(()=>{if(mounted)setError("Could not load events. Refresh to try again.");});return()=>{mounted=false;};},[api,refresh]);
 const link=async(id:string,selected:string|null)=>{
  setBusy(id);setError("");
  try {await api.linkRallyEvent(id,selected);setRefresh(n=>n+1);}
  catch (error) {setError("Could not save the event link. Please try again.");throw error;}
  finally {setBusy(null);}
 };
 const hide=async(id:string,hidden:boolean)=>{
  setBusy(id);setError("");
  try {await api.hideRallySession(id,hidden);setRefresh(n=>n+1);}
  catch(error){setError("Could not change session visibility. Please try again.");throw error;}
  finally{setBusy(null);}
 };
 const visible=stats ? visibleBattleStats(stats) : null;
 const shown=visible && eventId ? (()=>{
  const recent=visible.recent.filter(row=>row.eventId===eventId && !row.hidden);
  const current=visible.current?.eventId===eventId && !visible.current.hidden ? visible.current : null;
  const rows=[...recent,...(current?[current]:[])];
  return {...visible,recent,current,totals:rows.reduce((t,row)=>({sessions:t.sessions+1,durationMs:t.durationMs+row.durationMs,attacks:t.attacks+row.attacks,counters:t.counters+row.counters,incoming:t.incoming+row.incoming}),{sessions:0,durationMs:0,attacks:0,counters:0,incoming:0})};
 })() : visible;
 return <RallyStatisticsView stats={shown} error={error} refresh={()=>setRefresh(n=>n+1)} events={events} link={link} hide={hide} eventView={Boolean(eventId)} busy={busy} />;
}
export function RallyStatisticsView({stats,error,refresh,events=[],link,hide,eventView=false,busy=null}:{stats:RallyStatsView|null;error:string;refresh:()=>void;events?:RallyEventOption[];link?:(id:string,eventId:string|null)=>Promise<void>;busy?:string|null;hide?:(id:string,hidden:boolean)=>Promise<void>;eventView?:boolean}) {
 const [filter,setFilter]=useState("unlinked");
 const rows=stats ? [...(stats.current?[stats.current]:[]),...stats.recent].filter(row=>eventView ? !row.hidden : filter==="hidden" ? row.hidden : !row.hidden && (filter==="linked" ? Boolean(row.eventId) : !row.eventId)) : [];
 return <section className="card rally-statistics" aria-labelledby="rally-statistics-title">
  <div className="alliance-growth-head"><h2 id="rally-statistics-title">Bot battle sessions</h2><button className="btn btn-quiet" onClick={refresh}>Refresh</button></div>
  <p className="muted">Rallies coordinated by POP Rally Bot. Session time runs while battle monitoring is active, including quiet periods; it does not measure individual play time.</p>
  {error ? <p role="alert">{error}</p> : !stats ? <p>Loading battle history…</p> : !stats.trackingSince ? <p>No recorded battles yet. Tracking starts with the bot’s next battle; earlier tests are not included.</p> : <>
   <div className="rally-statistics-totals">
    <div><strong>{stats.totals.attacks+stats.totals.counters}</strong><span>Rallies called</span></div>
    <div><strong>{duration(stats.totals.durationMs)}</strong><span>Battle-session time</span></div>
    <div><strong>{stats.totals.sessions}</strong><span>Sessions</span></div>
    <div><strong>{stats.totals.incoming}</strong><span>Incoming rallies tracked</span></div>
   </div>
   <p className="muted small">{stats.totals.attacks} attack / deployment calls · {stats.totals.counters} counter-rally calls. Calls are recorded by the bot, not verified in-game. Since {new Date(stats.trackingSince).toLocaleDateString()}.</p>
   {!eventView && <label>Show sessions <select value={filter} onChange={e=>setFilter(e.target.value)}><option value="unlinked">Unlinked sessions</option><option value="linked">Linked sessions</option><option value="hidden">Hidden / testing</option></select></label>}
   <p className="muted small">Each row is one full bot session. Totals exclude hidden test sessions. Linked sessions are also available on their event page.</p>
   {rows.length===0 && <p>No sessions in this view.</p>}
   <div className="table-scroll"><table className="table"><thead><tr><th>Session started</th><th>Duration</th><th>Attacks</th><th>Counters</th><th>Incoming</th><th>POPHQ event</th><th>Manage session</th></tr></thead><tbody>{rows.map(row=><tr key={row.id}><td>{new Date(row.startedAt).toLocaleString()}{!row.endedAt && " · active at last update"}</td><td>{duration(row.durationMs)}</td><td>{row.attacks}</td><td>{row.counters}</td><td>{row.incoming}</td><td><BattleEventLink row={row} events={events} {...(link ? {link} : {})} busy={busy===row.id} /></td><td>{hide && <SessionVisibility row={row} hide={hide} busy={busy===row.id} />}</td></tr>)}</tbody></table></div>
   <p className="muted small">Battle history is saved independently of event links. R4s can link or unlink any battle. Suggested events use the battle’s UTC date. Updated {stats.updatedAt ? new Date(stats.updatedAt).toLocaleString() : "—"}. Setup still expires separately after six hours.</p>
  </>}
 </section>;
}

function BattleEventLink({row,events,link,busy}:{row:BattleSummary;events:RallyEventOption[];link?: (id:string,eventId:string|null)=>Promise<void>;busy:boolean}) {
 const [editing,setEditing]=useState(false);
 const [selected,setSelected]=useState(row.eventId ?? "");
 useEffect(()=>setSelected(row.eventId ?? ""),[row.eventId]);
 const event=events.find(e=>e.eventId===row.eventId);
 if(!editing) return <><span>{row.eventId ? <a href={`/events/${encodeURIComponent(row.eventId)}`}>{event?.title ?? "Linked event"}</a> : "Unlinked"}</span>{link && <button className="btn btn-quiet" onClick={()=>setEditing(true)}>{row.eventId ? "Change event" : "Link event"}</button>}</>;
 const day=new Date(row.startedAt).toISOString().slice(0,10);
 return <div className="stack"><label>Event for this battle<select aria-label="Event for this battle" value={selected} disabled={busy} onChange={e=>setSelected(e.target.value)}><option value="">Unlinked</option>{suggestedBattleEvents(events,row.startedAt).map(e=><option key={e.eventId} value={e.eventId}>{e.startsAt.slice(0,10)===day ? "Same day · " : ""}{e.title} · {e.startsAt.slice(0,10)}</option>)}</select></label><button className="btn" disabled={busy} onClick={()=>void link?.(row.id,selected || null).then(()=>setEditing(false)).catch(()=>{})}>{busy ? "Saving…" : "Save link"}</button><button className="btn btn-quiet" disabled={busy} onClick={()=>{setSelected(row.eventId ?? "");setEditing(false);}}>Cancel</button></div>;
}

function SessionVisibility({row,hide,busy}:{row:BattleSummary;hide:(id:string,hidden:boolean)=>Promise<void>;busy:boolean}) {
 const [confirm,setConfirm]=useState(false);
 if(!row.endedAt) return <span className="muted">Active session</span>;
 if(row.hidden) return <button className="btn btn-quiet" disabled={busy} onClick={()=>void hide(row.id,false).catch(()=>{})}>Restore session</button>;
 if(!confirm) return <button className="btn btn-quiet" disabled={busy} onClick={()=>setConfirm(true)}>Hide test session</button>;
 return <div className="stack"><span>Hide this full session and exclude its statistics? You can restore it in Hidden / testing.</span><button className="btn" disabled={busy} onClick={()=>void hide(row.id,true).then(()=>setConfirm(false)).catch(()=>{})}>{busy ? "Saving…" : "Hide session"}</button><button className="btn btn-quiet" disabled={busy} onClick={()=>setConfirm(false)}>Keep session</button></div>;
}
