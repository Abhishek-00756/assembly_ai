import * as exifr from "exifr";
import { ClaimSession } from "./types";
import { IncidentLocation, PhotoVerification } from "@insuranos/schema";

const NOMINATIM_URL="https://nominatim.openstreetmap.org/reverse";
const geoCache=new Map<string,string|null>();
let lastGeoRequestAt=0;

function geoCacheKey(latitude:number,longitude:number){return latitude.toFixed(4)+","+longitude.toFixed(4)}
async function waitForGeoRateLimit(){const wait=Math.max(0,1100-(Date.now()-lastGeoRequestAt));if(wait>0)await new Promise(r=>setTimeout(r,wait))}
export async function reverseGeocode(latitude:number,longitude:number){
 const key=geoCacheKey(latitude,longitude);
 if(geoCache.has(key))return geoCache.get(key)??null;
 await waitForGeoRateLimit();
 const base=process.env.NOMINATIM_URL??NOMINATIM_URL;
 const url=new URL(base);url.searchParams.set("format","jsonv2");url.searchParams.set("lat",String(latitude));url.searchParams.set("lon",String(longitude));url.searchParams.set("zoom","18");
 try{
  lastGeoRequestAt=Date.now();
  const response=await fetch(url,{headers:{"Accept":"application/json","User-Agent":process.env.NOMINATIM_USER_AGENT??"Insuranos/1.0 (local demo)"},signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new Error("reverse geocode http "+response.status);
  const body=await response.json() as {display_name?:string};
  const address=typeof body.display_name==="string"?body.display_name:null;
  geoCache.set(key,address);
  return address;
 }catch{geoCache.set(key,null);return null}
}

function exifDate(value:unknown):Date|null{
 if(value instanceof Date&&!Number.isNaN(value.getTime()))return value;
 if(typeof value==="number"){const d=new Date(value<1e12?value*1000:value);return Number.isNaN(d.getTime())?null:d}
 if(typeof value==="string"){const normalized=value.replace(/^(\\d{4}):(\\d{2}):(\\d{2})/,"$1-$2-$3");const d=new Date(normalized);return Number.isNaN(d.getTime())?null:d}
 return null;
}
function distanceM(aLat:number,aLon:number,bLat:number,bLon:number){
 const r=6371000,rad=Math.PI/180,p1=aLat*rad,p2=bLat*rad,dp=(bLat-aLat)*rad,dl=(bLon-aLon)*rad;
 const x=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
 return 2*r*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}
export async function verifyPhoto(buffer:Buffer,session:ClaimSession):Promise<PhotoVerification>{
 const empty:PhotoVerification={photo_verified:null,photo_verification_note:null,exif_capture_at:null,exif_latitude:null,exif_longitude:null,time_delta_seconds:null,distance_m:null};
 try{
  const exif=await exifr.parse(buffer,{pick:["DateTimeOriginal","CreateDate","ModifyDate"]}) as Record<string,unknown>|undefined;
  const gps=await exifr.gps(buffer) as {latitude?:number;longitude?:number}|undefined;
  const capture=exifDate(exif?.DateTimeOriginal??exif?.CreateDate??exif?.ModifyDate);
  const lat=typeof gps?.latitude==="number"?gps.latitude:null;
  const lon=typeof gps?.longitude==="number"?gps.longitude:null;
  const result:PhotoVerification={...empty,exif_capture_at:capture?.toISOString()??null,exif_latitude:lat,exif_longitude:lon};
  const checks:boolean[]=[];const notes:string[]=[];
  const maxHours=Number(process.env.PHOTO_EXIF_MAX_DELTA_HOURS??24);
  const maxDistance=Number(process.env.PHOTO_GPS_MAX_DISTANCE_M??1000);
  if(capture){
   const delta=Math.abs(capture.getTime()-new Date(session.started_at).getTime())/1000;
   result.time_delta_seconds=Math.round(delta);
   const ok=delta<=maxHours*3600;checks.push(ok);notes.push(ok?"capture time matched":"capture time is outside the configured time window");
  }
  const incidentLocation=session.claim_data.incident_location;
  if(lat!=null&&lon!=null&&incidentLocation){
   const distance=distanceM(lat,lon,incidentLocation.latitude,incidentLocation.longitude);
   result.distance_m=Math.round(distance);
   const ok=distance<=maxDistance;checks.push(ok);notes.push(ok?"GPS is near the incident location":"GPS is far from the incident location");
  }
  if(checks.length===0){result.photo_verification_note="No usable EXIF timestamp or GPS metadata was available.";return result}
  result.photo_verified=checks.every(Boolean);
  result.photo_verification_note=notes.join("; ");
  return result;
 }catch(error){return{...empty,photo_verification_note:"EXIF metadata could not be parsed: "+(error instanceof Error?error.message:String(error))}}
}

export function buildIncidentLocation(latitude:number,longitude:number,accuracy:number|null,address:string|null):IncidentLocation{
 return{latitude,longitude,accuracy_m:accuracy,address,captured_at:new Date().toISOString(),source:"device_gps",reverse_geocoder:address?"OpenStreetMap Nominatim":null};
}
