import { useEffect, useState } from "react";
import type { RallyStatsView } from "../api";
import { useSession } from "../session";
const duration = (ms:number) => `${Math.floor(ms/3600000)}h ${Math.floor(ms/60000)%60}m`;
export function RallyStatistics() {
 const {api}=useSession();
 const [stats,setStats]=useState<RallyStatsView|null>(null);
 const [error,setError]=useState("");
 const [refresh,setRefresh]=useState(0);
 useEffect(()=>{let mounted=true; api.rallyStats().then(data=>{if(mounted){setStats(data);setError("");}}).catch(()=>{if(mounted)setError("Battle statistics are temporarily unavailable.");});return()=>{mounted=false;};},[api,refresh]);
 return <RallyStatisticsView stats={stats} error={error} refresh={()=>setRefresh(n=>n+1)} />;
}
export function RallyStatisticsView({stats,error,refresh}:{stats:RallyStatsView|null;error:string;refresh:()=>void}) {
 return <section className="card rally-statistics" aria-labelledby="rally-statistics-title">
  <div className="alliance-growth-head"><h2 id="rally-statistics-title">Castle battles</h2><button className="btn btn-quiet" onClick={refresh}>Refresh</button></div>
  <p className="muted">Rallies coordinated by POP Rally Bot. Session time runs while battle monitoring is active, including quiet periods; it does not measure individual play time.</p>
  {error ? <p role="alert">{error}</p> : !stats ? <p>Loading battle history…</p> : !stats.trackingSince ? <p>No recorded battles yet. Tracking starts with the bot’s next battle; earlier tests are not included.</p> : <>
   <div className="rally-statistics-totals">
    <div><strong>{stats.totals.attacks+stats.totals.counters}</strong><span>Rallies called</span></div>
    <div><strong>{duration(stats.totals.durationMs)}</strong><span>Battle-session time</span></div>
    <div><strong>{stats.totals.sessions}</strong><span>Sessions</span></div>
    <div><strong>{stats.totals.incoming}</strong><span>Incoming rallies tracked</span></div>
   </div>
   <p className="muted small">{stats.totals.attacks} attack / deployment calls · {stats.totals.counters} counter-rally calls. Calls are recorded by the bot, not verified in-game. Since {new Date(stats.trackingSince).toLocaleDateString()}.</p>
   <div className="table-scroll"><table className="table"><thead><tr><th>Battle started</th><th>Duration</th><th>Attacks</th><th>Counters</th><th>Incoming</th></tr></thead><tbody>{[...(stats.current?[stats.current]:[]),...stats.recent].map(row=><tr key={row.id}><td>{new Date(row.startedAt).toLocaleString()}{!row.endedAt && " · active at last update"}</td><td>{duration(row.durationMs)}</td><td>{row.attacks}</td><td>{row.counters}</td><td>{row.incoming}</td></tr>)}</tbody></table></div>
   <p className="muted small">Latest 50 sessions. Totals retain older sessions. Updated {stats.updatedAt ? new Date(stats.updatedAt).toLocaleString() : "—"}. Setup still expires separately after six hours.</p>
  </>}
 </section>;
}
