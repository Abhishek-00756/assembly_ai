import { ClaimData, CompletenessResult, UNKNOWN_VALUE_SENTINEL, FIELD_LABELS } from "@insuranos/schema";
export interface ReportJson{generated_at:string;narrative:string;groups:{safety:Record<string,string>;incident:Record<string,string>;other_parties:Record<string,string>[];user_vehicle:Record<string,string>;evidence:Record<string,string>;policy_info:Record<string,string>};flagged_gaps:string[];next_steps:string[]}
const NOT_PROVIDED="Not provided";
function render(v:unknown){if(v===UNKNOWN_VALUE_SENTINEL||v===null||v===undefined||v==="")return NOT_PROVIDED;if(typeof v==="boolean")return v?"Yes":"No";return String(v)}
const NEXT_STEPS=["Keep your claim reference and this report for your records.","Keep any receipts for towing, rental, or emergency repairs.","An adjuster may contact you for follow-up if required."];
export function buildReport(claim:ClaimData,completeness:CompletenessResult){
 const gps=claim.incident_location;
 const location=claim.incident.location??gps?.address??(gps?"GPS ("+gps.latitude.toFixed(6)+", "+gps.longitude.toFixed(6)+")":null);
 const coordinates=gps?gps.latitude.toFixed(6)+", "+gps.longitude.toFixed(6):NOT_PROVIDED;
 const verifiedPhotos=claim.evidence.photos.filter(p=>p.verification?.photo_verified===true).length;
 const flaggedPhotos=claim.evidence.photos.filter(p=>p.verification?.photo_verified===false).length;
 const report_json:ReportJson={
  generated_at:new Date().toISOString(),
  narrative:render(claim.incident.description_summary),
  groups:{
   safety:{"Injuries reported":render(claim.safety.injuries_reported),"Still at scene":render(claim.safety.still_at_scene)},
   incident:{"Date/time":render(claim.incident.date_time),"Location":render(location),"GPS coordinates":coordinates,"Location source":gps?"Device GPS":"Caller-provided or unavailable","Weather":render(claim.incident.weather),"Road conditions":render(claim.incident.road_conditions),"Police report #":render(claim.incident.police_report_number)},
   other_parties:claim.other_parties.map(p=>({Name:render(p.name),Phone:render(p.phone),Insurer:render(p.insurer_name),"Policy #":render(p.policy_number),Vehicle:[render(p.vehicle.make),render(p.vehicle.model),render(p.vehicle.plate)].filter(v=>v!==NOT_PROVIDED).join(" / ")||NOT_PROVIDED})),
   user_vehicle:{Make:render(claim.user_vehicle.make),Model:render(claim.user_vehicle.model),Plate:render(claim.user_vehicle.plate),Damage:render(claim.user_vehicle.damage_description),Drivable:render(claim.user_vehicle.drivable),"Airbags deployed":render(claim.user_vehicle.airbags_deployed)},
   evidence:{Photos:claim.evidence.photos.length?claim.evidence.photos.length+" photo(s) attached":NOT_PROVIDED,Witnesses:render(claim.evidence.witnesses),"Dashcam available":render(claim.evidence.dashcam_available),"Verified photos":verifiedPhotos?String(verifiedPhotos):"None","Metadata flags":flaggedPhotos?String(flaggedPhotos):"None"},
   policy_info:{Policyholder:render(claim.policy_info.policyholder_name),"Policy #":render(claim.policy_info.policy_number),"Contact phone":render(claim.policy_info.contact_phone),"Contact email":render(claim.policy_info.contact_email)}
  },
  flagged_gaps:[...completeness.flaggedGaps.map(f=>FIELD_LABELS[f]??f),...completeness.integrityFlags],
  next_steps:NEXT_STEPS
 };
 const summary_text=[ "Incident summary: "+report_json.narrative,"",...Object.entries(report_json.groups).flatMap(([group,val])=>group==="other_parties"?[]:[group.replace("_"," ")+": "+Object.entries(val as Record<string,string>).map(([k,v])=>k+": "+v).join("; ")]),report_json.flagged_gaps.length?"Gaps noted: "+report_json.flagged_gaps.join(", "):"No flagged gaps.","Next steps: "+NEXT_STEPS.join(" ")].join("\\n");
 return{report_json,summary_text};
}
