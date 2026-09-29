/**
 * End-to-end smoke test for the post-call dashboard path.
 * Also wired to `npm run smoke` in package.json. Run: npx tsx src/demoSmoke.ts
 */
import fs from "node:fs";
import path from "node:path";
import { JsonFileClaimRepository } from "./repository/JsonFileClaimRepository";
import { GraphStore } from "./graphStore";
import { callTool } from "./tools/handlers";
import { computeCompleteness } from "@insuranos/schema";
import { describeContext, enrichContext } from "./riskEngine";

const DATA_DIR = path.resolve(process.env.INSURANOS_LOCAL_DATA_DIR ?? ".localdata");
let failures = 0;

function check(label:string,ok:boolean,detail?:unknown){
  if(!ok)failures++;
  console.log(`${ok?"PASS":"FAIL"}  ${label}${detail!==undefined&&!ok?` -> ${JSON.stringify(detail)}`:""}`);
}

/** Mirrors buildDashboard() in server.ts. */
async function buildDashboardPayload(repo:JsonFileClaimRepository,graph:GraphStore,sessionId:string){
  const session=(await repo.ensureIncidentCode(sessionId))??(await repo.getSession(sessionId));
  if(!session)return null;
  const completeness=computeCompleteness(session.claim_data);
  const [edges,nodes,conflicts,artifact]=await Promise.all([
    graph.edgesForSession(session.id),
    graph.nodesForSession(session.id),
    graph.findConflicts(session.incident_group_id).catch(()=>[] as string[]),
    repo.getReportArtifact(session.id),
  ]);
  const ctx=session.claim_data.context_factors;
  return{
    incident:{id:session.id,incident_code:session.incident_code,incident_group_id:session.incident_group_id,status:session.status,current_phase:session.current_phase},
    completeness,
    graph:{nodes,edges,conflicts},
    report:{generated:Boolean(artifact),eligible:completeness.isReportEligible,pdf_status:artifact?.pdf_status??"none",pdf_error:artifact?.pdf_error??null,pdf_url:artifact?.pdf_url??null,download_url:artifact?.pdf_download_url??null,summary_text:artifact?.summary_text??null},
    risk:{available:Boolean(ctx),context_score:ctx?.context_score??null,factors:ctx?.factors??[],interpretation:describeContext(ctx),is_liability_decision:false}
  };
}

async function main(){
 const repo=new JsonFileClaimRepository();
 const graph=new GraphStore();

 console.log("== incident codes ==");
 const claimant=await repo.createClaimant({auth_mode:"demo",display_name:"Smoke",email:"smoke@test.local"});
 const session=await repo.createSession(claimant.id);
 const ctx={repo,sessionId:session.id};
 check("demo name prefilled into policyholder_name",session.claim_data.policy_info.policyholder_name==="Smoke",session.claim_data.policy_info.policyholder_name);
 check("demo email prefilled into policy contact_email",session.claim_data.policy_info.contact_email==="smoke@test.local",session.claim_data.policy_info.contact_email);
 check("code matches INC-XXXXXX",/^INC-[A-Z0-9]{6}$/.test(session.incident_code),session.incident_code);
 check("lookup by exact code",(await repo.findSessionByIncidentCode(session.incident_code))?.id===session.id);
 check("lookup is case-insensitive",(await repo.findSessionByIncidentCode(session.incident_code.toLowerCase()))?.id===session.id);
 check("unknown code returns null",(await repo.findSessionByIncidentCode("INC-ZZZZZZ"))===null);

 console.log("\n== claim data + graph ==");
 await callTool("record_safety_status",{injuries_reported:false,still_at_scene:false},ctx);
 await callTool("record_incident_basics",{date_time:new Date(Date.now()-3_600_000).toISOString(),location:"Pune",description_summary:"rear ended at a signal"},ctx);
 await callTool("record_vehicle_damage",{make:"Maruti",model:"Swift",plate:"MH12AB1234",damage_description:"rear bumper",drivable:true},ctx);
 await callTool("record_policyholder_info",{policyholder_name:"Smoke",policy_number:"POL9",contact_phone:"9999999999"},ctx);

 await repo.writeFieldGroup(session.id,"incident_location",{latitude:18.60487,longitude:73.87511,accuracy_m:20,address:"Pune",captured_at:new Date().toISOString(),source:"device_gps",reverse_geocoder:"nominatim"});
 const enriched=await enrichContext((await repo.getSession(session.id))!);
 if(enriched)await repo.writeFieldGroup(session.id,"context_factors",enriched);
 await graph.syncSession((await repo.getSession(session.id))!,"record_incident_basics");

 const edges=await graph.edgesForSession(session.id);
 const relations=edges.map(e=>e.relation);
 check("edges are session-scoped",edges.every(e=>e.session_id===session.id));
 check("located_at edge present",relations.includes("located_at"));
 check("gps_location edge present",relations.includes("gps_location"));
 if(enriched){
  check("context_score edge present",relations.includes("context_score"));
  check("risk factors indexed not duplicated",relations.filter(r=>r.startsWith("risk_factor_")).length===enriched.factors.length);
 }
 const conflicts=await graph.findConflicts(session.incident_group_id);
 check("single session reports no conflicts",conflicts.length===0,conflicts);

 console.log("\n== report + pdf ==");
 const report=await callTool("generate_report",{},ctx);
 check("generate_report succeeded",report.ok,report.result);
 const artifact=await repo.getReportArtifact(session.id);
 check("pdf_status is ready",artifact?.pdf_status==="ready",artifact?.pdf_error);
 check("pdf_error is null",artifact?.pdf_error==null);
 const pdfPath=path.join(DATA_DIR,"reports",`${session.id}.pdf`);
 check("pdf written to disk",fs.existsSync(pdfPath));
 if(fs.existsSync(pdfPath))check("pdf has %PDF- magic bytes",fs.readFileSync(pdfPath).subarray(0,5).toString("latin1")==="%PDF-");
 check("summary_text includes risk",String(artifact?.summary_text).includes("External context:"));
 check("risk text avoids liability claims",!enriched||/not a determination of fault/.test(describeContext(enriched)??""));

 console.log("\n== dashboard payload ==");
 const d=await buildDashboardPayload(repo,graph,session.id);
 check("payload built",d!==null);
 check("incident_code present",Boolean(d?.incident.incident_code));
 check("graph has nodes",(d?.graph.nodes.length??0)>0);
 check("graph has edges",(d?.graph.edges.length??0)>0);
 check("is_liability_decision is false",d?.risk.is_liability_decision===false);
 check("pdf_status in enum",["pending","ready","failed","none"].includes(String(d?.report.pdf_status)));
 check("report eligible",d?.report.eligible===true);

 console.log(`\n${failures===0?"ALL CHECKS PASSED":failures+" CHECK(S) FAILED"}`);
 if(failures>0)process.exitCode=1;
}

void main();
