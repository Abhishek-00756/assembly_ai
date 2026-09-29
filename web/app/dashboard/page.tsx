"use client";
import {Suspense,useEffect,useState} from "react";
import {useSearchParams} from "next/navigation";
import Link from "next/link";

type ContextWeather={observed_at:string|null;temperature_c:number|null;precipitation_mm:number|null;visibility_m:number|null;wind_kmh:number|null;weather_code:number|null;description:string|null};
type ContextTraffic={incident_count:number|null;density:"low"|"moderate"|"high"|"unavailable";provider:string|null};
type Risk={available:boolean;context_score:number|null;provider_status:{"weather":string;"traffic":string}|null;weather:ContextWeather|null;traffic:ContextTraffic|null;factors:string[];interpretation:string|null;is_liability_decision:boolean};
type GraphRelation={relation:string;value:string;source_tool:string};
type GraphNode={id:string;type:string;label:string;value:string|null;relations:GraphRelation[]};
type DashboardData={
  incident:{id:string;incident_code:string;incident_group_id:string;status:string;current_phase:string;started_at:string;completed_at:string|null;requires_followup:boolean};
  claimant:{display_name:string|null;email:string|null;phone_number:string|null}|null;
  completeness:{fields:{field:string;tier:string;status:"filled"|"unknown"|"missing"}[];missingRequired:string[];flaggedGaps:string[];integrityFlags:string[];isReportEligible:boolean;groupSummary:Record<string,{filled:number;total:number}>};
  graph:{nodes:GraphNode[];edges:{from:string;relation:string;to:string;source_tool:string}[];conflicts:string[];peer_sessions:{id:string;incident_code:string;status:string}[]};
  report:{generated:boolean;eligible:boolean;blocked_reason:string|null;pdf_status:"pending"|"ready"|"failed"|"none";pdf_error:string|null;pdf_url:string|null;download_url:string|null;summary_text:string|null;email_status:string|null;emailed_to:string|null;emailed_at:string|null};
  risk:Risk;
  cross_party:{available:boolean;related_session_count:number;grounded_narrative:string;conflicts:string[];note:string|null};
};

const FIELD_LABELS:Record<string,string>={"safety.injuries_reported":"whether anyone was injured","safety.still_at_scene":"whether you're still at the scene","incident.date_time":"the date and time of the incident","incident.location":"the incident location","incident.description_summary":"a description of what happened","user_vehicle.make":"your vehicle's make","user_vehicle.model":"your vehicle's model","user_vehicle.plate":"your vehicle's plate number","policy_info.policyholder_name":"the policyholder's name","policy_info.policy_number":"your policy number","policy_info.contact_phone":"a contact phone number","other_parties[0].name":"the other driver's name","other_parties[0].phone":"the other driver's phone number","other_parties[0].insurer_name":"the other driver's insurer","other_parties[0].policy_number":"the other driver's policy number","incident.weather":"the weather conditions","incident.road_conditions":"the road conditions","user_vehicle.damage_description":"a description of the damage","user_vehicle.drivable":"whether the vehicle is drivable","evidence.photos[]":"at least one photo"};
const phaseLabels:Record<string,string>={opening_safety:"Opening & Safety",grounding_consent:"Grounding & Consent",narrative:"Incident Narrative",structured_gathering:"Structured Data",evidence:"Photo & Evidence",review:"Review",output_generation:"Generate Report",closing:"Next Steps"};
const densityLabels:Record<string,string>={low:"Low",moderate:"Moderate",high:"High",unavailable:"Unavailable"};
const NODE_ORDER=["incident","incident group","vehicle","policy","other party","photo"];
function scoreClass(score:number){return score>=60?"text-amber-600":score>=30?"text-slate-900":"text-emerald-600"}
function num(v:number|null,suffix:string){return v==null?"Not available":v.toLocaleString()+suffix}
function providerLabel(s:string|undefined){return s==="available"?"Available":s==="not_configured"?"Not configured":s==="unavailable"?"Unavailable":"Not available"}
function friendlyRelation(r:string){return r.replace(/^risk_factor_\d+$/,"risk factor").replace(/_/g," ")}
function statusPill(status:string){return status==="completed"?"bg-emerald-100 text-emerald-700":status==="review"?"bg-amber-100 text-amber-700":"bg-slate-100 text-slate-600"}
function Stat({value,label,tone}:{value:string|number;label:string;tone?:string}){return <div className="rounded-3xl border bg-white p-5 shadow-sm"><p className={`text-3xl font-bold ${tone??"text-slate-900"}`}>{value}</p><p className="mt-1 text-xs text-slate-500">{label}</p></div>}
function Row({label,value}:{label:string;value:string}){return <div className="flex items-baseline justify-between gap-3 py-1"><span className="text-xs text-slate-500">{label}</span><span className="text-right text-xs font-medium text-slate-700">{value}</span></div>}

function DashboardContent(){
  const params=useSearchParams();const sessionId=params.get("session");
  const[data,setData]=useState<DashboardData|null>(null);const[error,setError]=useState("");const[loading,setLoading]=useState(true);
  useEffect(()=>{
    if(!sessionId){setError("Missing session.");setLoading(false);return}
    fetch(`/api/sessions/${sessionId}/dashboard`,{cache:"no-store"}).then(async r=>{const j=await r.json().catch(()=>null);if(!r.ok)throw new Error(j?.error??"Could not load dashboard");setData(j)}).catch(e=>setError(e instanceof Error?e.message:String(e))).finally(()=>setLoading(false));
  },[sessionId]);

  if(loading)return <main className="min-h-screen px-4 py-6 md:px-8"><div className="mx-auto max-w-6xl"><p className="text-sm text-slate-500">Loading incident…</p></div></main>;
  if(error)return <main className="min-h-screen px-4 py-6 md:px-8"><div className="mx-auto max-w-6xl"><p className="text-sm text-red-700">{error}</p><Link href="/" className="mt-4 inline-block rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white">Back to start</Link></div></main>;
  if(!data)return null;

  const d=data,inc=d.incident,rep=d.report,risk=d.risk,comp=d.completeness;
  const [resending,setResending]=useState(false);
  const [resendError,setResendError]=useState("");
  async function resendReport(){
    if(!sessionId||resending)return;
    setResending(true);
    setResendError("");
    try{
      const response=await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/report/resend`,{method:"POST"});
      const body=await response.json().catch(()=>null);
      if(!response.ok)throw new Error(body?.error==="email_delivery_failed"?"Email delivery failed. Check the Resend configuration.":body?.error==="no_contact_email_on_file"?"No contact email is available for this claim.":body?.error??"Could not resend report");
      setData(prev=>prev?{...prev,report:{...prev.report,email_status:body.email_status??"sent",emailed_to:body.emailed_to??prev.report.emailed_to,emailed_at:body.emailed_at??prev.report.emailed_at}}:prev);
    }catch(e){
      setResendError(e instanceof Error?e.message:String(e));
    }finally{
      setResending(false);
    }
  }
  const fieldsResolved=comp.fields.filter(f=>f.status!=="missing").length;
  const sorted=[...d.graph.nodes].sort((a,b)=>{const ai=NODE_ORDER.indexOf(a.type),bi=NODE_ORDER.indexOf(b.type);return (ai<0?99:ai)-(bi<0?99:bi)});
  const pdfHref=rep.download_url??rep.pdf_url;

  return <main className="min-h-screen px-4 py-6 md:px-8"><div className="mx-auto max-w-6xl">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">INSURANOS</p><h1 className="mt-1 text-2xl font-bold">Incident dashboard</h1><p className="mt-1 font-mono text-sm text-slate-600">{inc.incident_code}</p></div>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusPill(inc.status)}`}>{inc.status}</span>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{phaseLabels[inc.current_phase]??inc.current_phase}</span>
        {inc.requires_followup&&<span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700">Follow-up required</span>}
        <Link href="/" className="rounded-xl border px-3 py-2 text-xs font-semibold text-slate-600">Start new claim</Link>
      </div>
    </header>
    <p className="mt-2 text-xs text-slate-500">Started {new Date(inc.started_at).toLocaleString()}{inc.completed_at?` · Completed ${new Date(inc.completed_at).toLocaleString()}`:""} · Incident group <span className="font-mono">{inc.incident_group_id.slice(0,8)}</span></p>

    <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
      <Stat value={d.graph.nodes.length} label="Entities"/>
      <Stat value={d.graph.edges.length} label="Relations"/>
      <Stat value={`${fieldsResolved}/${comp.fields.length}`} label="Fields captured"/>
      <Stat value={risk.context_score==null?"—":risk.context_score} label="Context score" tone={risk.context_score==null?"text-slate-400":scoreClass(risk.context_score)}/>
    </div>

    <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-6">
        <section className="rounded-3xl border bg-white p-5 shadow-sm">
          <h2 className="font-semibold">Knowledge graph</h2>
          <p className="mt-1 text-xs text-slate-500">Every entity and relation below comes from the claim data actually collected on the call.</p>
          {d.graph.conflicts.length>0&&<div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"><strong>Consistency conflicts</strong>{d.graph.conflicts.map(x=><div key={x} className="mt-1">{x}</div>)}</div>}
          {sorted.length===0?<p className="mt-4 text-sm text-slate-500">No graph facts recorded yet.</p>:<div className="mt-4 space-y-4">{sorted.map(n=>
            <div key={n.id} className="rounded-2xl border p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-400">{n.type}</p>
              <p className="mt-1 text-sm font-semibold text-slate-900">{n.label}</p>
              <div className="mt-2 divide-y divide-slate-100">{n.relations.map(r=>
                <div key={r.relation} className="flex flex-wrap items-baseline justify-between gap-2 py-1.5"><span className="text-xs text-slate-500">{friendlyRelation(r.relation)}</span><span className="text-right text-xs font-medium text-slate-700">{r.value}</span></div>
              )}</div>
            </div>
          )}</div>}
        </section>

        <section className="rounded-3xl border bg-white p-5 shadow-sm">
          <h2 className="font-semibold">Claim report</h2>
          {!rep.generated&&<p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">{rep.eligible?"No report has been generated for this claim yet.":`No report has been generated for this claim yet. ${rep.blocked_reason??"Required fields are still missing."}`}</p>}
          {rep.generated&&rep.pdf_status==="ready"&&pdfHref&&<div className="mt-4 flex flex-wrap gap-2">
            <a href={pdfHref} target="_blank" rel="noreferrer" className="rounded-xl bg-slate-900 px-4 py-3 text-center text-sm font-semibold text-white">Open PDF report</a>
            <button onClick={resendReport} disabled={resending} className="rounded-xl border px-4 py-3 text-center text-sm font-semibold text-slate-700 disabled:cursor-not-allowed disabled:opacity-50">{resending?"Sending…":"Resend report email"}</button>
          </div>}
          {resendError&&<p className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">{resendError}</p>}
          {rep.pdf_status==="failed"&&<div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"><strong>PDF generation failed</strong><div className="mt-1">{rep.pdf_error??"Unknown error"}</div></div>}
          {rep.generated&&rep.summary_text&&<p className="mt-4 whitespace-pre-wrap text-sm text-slate-600">{rep.summary_text}</p>}
          {rep.email_status&&<p className="mt-3 text-xs text-slate-500">Email delivery: {rep.email_status}{rep.emailed_to?` → ${rep.emailed_to}`:""}</p>}
        </section>

        <section className="rounded-3xl border bg-white p-5 shadow-sm">
          <h2 className="font-semibold">Collected details</h2>
          <p className="mt-1 text-xs text-slate-500">{fieldsResolved} of {comp.fields.length} tracked fields resolved</p>
          <div className="mt-3 divide-y divide-slate-100">{comp.fields.map(f=>
            <div key={f.field} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="text-xs text-slate-500">{FIELD_LABELS[f.field]??f.field}</span>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${f.status==="filled"?"bg-emerald-100 text-emerald-700":f.status==="unknown"?"bg-slate-200 text-slate-600":"bg-amber-100 text-amber-700"}`}>{f.status}</span>
            </div>
          )}</div>
          {comp.integrityFlags.length>0&&<div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"><strong>Photo metadata flags</strong>{comp.integrityFlags.map(x=><div key={x} className="mt-1">{x}</div>)}</div>}
        </section>

        <section className="rounded-3xl border bg-white p-5 shadow-sm">
          <h2 className="font-semibold">Cross-party</h2>
          {!d.cross_party.available&&<p className="mt-3 text-sm text-slate-500">{d.cross_party.note??"Not available."}</p>}
          {d.cross_party.available&&<>
            <p className="mt-2 text-sm text-slate-600">{d.cross_party.related_session_count} linked session(s) found.</p>
            <p className="mt-3 whitespace-pre-wrap text-sm text-slate-600">{d.cross_party.grounded_narrative}</p>
            {d.cross_party.conflicts.length>0&&<div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">{d.cross_party.conflicts.map(x=><div key={x} className="mt-1">{x}</div>)}</div>}
          </>}
        </section>
      </div>

      <aside className="space-y-4">
        <section className="rounded-3xl border bg-white p-5 shadow-sm">
          <h2 className="font-semibold">External context</h2>
          <p className="mt-1 text-xs text-slate-500">Server-derived from device GPS and the incident time. Not caller-reported, and not a fault or liability decision.</p>
          {risk.context_score!=null?<div className="mt-4 rounded-2xl bg-slate-50 p-4"><p className="text-sm text-slate-500">Context score</p><p className={`mt-1 text-3xl font-bold ${scoreClass(risk.context_score)}`}>{risk.context_score}<span className="ml-1 text-sm font-normal text-slate-400">/ 100</span></p></div>:<div className="mt-4 rounded-2xl bg-slate-50 p-4"><p className="text-sm text-slate-500">Context score</p><p className="mt-1 text-sm text-slate-400">Not available</p></div>}
          {risk.interpretation&&<p className="mt-3 text-xs text-slate-600">{risk.interpretation}</p>}
          {risk.weather&&<div className="mt-4 divide-y divide-slate-100"><Row label="Conditions" value={risk.weather.description??"Not available"}/><Row label="Temperature" value={num(risk.weather.temperature_c," °C")}/><Row label="Precipitation" value={num(risk.weather.precipitation_mm," mm")}/><Row label="Visibility" value={num(risk.weather.visibility_m," m")}/><Row label="Wind" value={num(risk.weather.wind_kmh," km/h")}/><Row label="Observed at" value={risk.weather.observed_at?new Date(risk.weather.observed_at+"Z").toLocaleString():"Not available"}/></div>}
          {risk.traffic&&<div className="mt-4 divide-y divide-slate-100"><Row label="Nearby incidents" value={risk.traffic.incident_count==null?"Not available":String(risk.traffic.incident_count)}/><Row label="Congestion density" value={densityLabels[risk.traffic.density]??"Unavailable"}/></div>}
          <div className="mt-4 divide-y divide-slate-100"><Row label="Weather source" value={providerLabel(risk.provider_status?.weather)}/><Row label="Traffic source" value={providerLabel(risk.provider_status?.traffic)}/></div>
          {risk.factors.length>0&&<div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"><strong>Context signals</strong>{risk.factors.map(x=><div key={x} className="mt-1">{x}</div>)}</div>}
        </section>
        {d.graph.peer_sessions.length>0&&<section className="rounded-3xl border bg-white p-5 shadow-sm"><h2 className="font-semibold">Linked sessions</h2><div className="mt-3 space-y-2">{d.graph.peer_sessions.map(p=><div key={p.id} className="rounded-xl border px-3 py-2 text-xs"><span className="font-mono text-slate-700">{p.incident_code}</span><span className="ml-2 text-slate-400">{p.status}</span></div>)}</div></section>}
        <section className="rounded-3xl border bg-white p-5 shadow-sm"><h2 className="font-semibold">Claimant</h2><div className="mt-3 space-y-1 text-sm text-slate-600"><p>{d.claimant?.display_name??"Not provided"}</p><p className="text-xs text-slate-500">{d.claimant?.email??"No email"}</p><p className="text-xs text-slate-500">{d.claimant?.phone_number??"No phone"}</p></div></section>
      </aside>
    </div>
  </div></main>;
}

export default function DashboardPage(){return <Suspense fallback={<main className="min-h-screen px-4 py-6 md:px-8"><div className="mx-auto max-w-6xl"><p className="text-sm text-slate-500">Loading…</p></div></main>}><DashboardContent/></Suspense>}
