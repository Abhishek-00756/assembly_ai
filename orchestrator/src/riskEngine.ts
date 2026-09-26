import { ContextFactors } from "@insuranos/schema";
import { ClaimSession } from "./types";

type HourlyWeather={time:string[];temperature_2m?:Array<number|null>;precipitation?:Array<number|null>;visibility?:Array<number|null>;wind_speed_10m?:Array<number|null>;weather_code?:Array<number|null>};
const weatherDescription=(code:number|null)=>{if(code==null)return null;if(code===0)return"Clear sky";if(code<=3)return"Cloudy";if(code===48||code===45)return"Fog";if(code<=67)return"Rain or drizzle";if(code<=77)return"Snow";if(code<=82)return"Rain showers";if(code<=86)return"Snow showers";if(code<=99)return"Thunderstorm";return"Unknown"};
function parsedDate(value:string){const d=new Date(value);return Number.isNaN(d.getTime())?null:d}
function nearestHour(data:HourlyWeather,target:Date){let best=-1,bestDelta=Infinity;for(let i=0;i<data.time.length;i++){const t=new Date(data.time[i]).getTime();if(Number.isNaN(t))continue;const delta=Math.abs(t-target.getTime());if(delta<bestDelta){bestDelta=delta;best=i}}return best}
async function fetchWeather(latitude:number,longitude:number,target:Date){
 const start=target.toISOString().slice(0,10),useForecast=target.getTime()>=Date.now()-2*24*3600*1000&&target.getTime()<=Date.now()+2*24*3600*1000,url=new URL(useForecast?"https://api.open-meteo.com/v1/forecast":"https://archive-api.open-meteo.com/v1/archive");
 url.searchParams.set("latitude",String(latitude));url.searchParams.set("longitude",String(longitude));url.searchParams.set("hourly","temperature_2m,precipitation,visibility,wind_speed_10m,weather_code");url.searchParams.set("timezone","UTC");url.searchParams.set("start_date",start);url.searchParams.set("end_date",start);
 if(useForecast){url.searchParams.set("past_days","2");url.searchParams.set("forecast_days","2")}
 const r=await fetch(url,{signal:AbortSignal.timeout(8000)});if(!r.ok)throw new Error("weather_http_"+r.status);const j=await r.json() as {hourly:HourlyWeather};const i=nearestHour(j.hourly,target);if(i<0)throw new Error("weather_hour_not_found");
 return{observed_at:j.hourly.time[i]??null,temperature_c:j.hourly.temperature_2m?.[i]??null,precipitation_mm:j.hourly.precipitation?.[i]??null,visibility_m:j.hourly.visibility?.[i]??null,wind_kmh:j.hourly.wind_speed_10m?.[i]??null,weather_code:j.hourly.weather_code?.[i]??null,description:weatherDescription(j.hourly.weather_code?.[i]??null)}
}
async function fetchTraffic(latitude:number,longitude:number){
 const key=process.env.TOMTOM_API_KEY;if(!key)return{incident_count:null,density:"unavailable" as const,provider:null};
 const span=Number(process.env.TOMTOM_TRAFFIC_BBOX_DEGREES??0.02),minLat=latitude-span/2,maxLat=latitude+span/2,minLon=longitude-span/2,maxLon=longitude+span/2;
 const url=new URL("https://api.tomtom.com/traffic/services/5/incidentDetails");url.searchParams.set("key",key);url.searchParams.set("bbox",\`\${minLon},\${minLat},\${maxLon},\${maxLat}\`);url.searchParams.set("fields","{incidents{type,geometry{type,coordinates},properties{iconCategory,numberOfReports,lastReportTime}}}");url.searchParams.set("language","en-GB");url.searchParams.set("timeValidityFilter","present");
 const r=await fetch(url,{signal:AbortSignal.timeout(8000)});if(!r.ok)throw new Error("traffic_http_"+r.status);const j=await r.json() as {incidents?:unknown[]};const count=Array.isArray(j.incidents)?j.incidents.length:0;return{incident_count:count,density:count===0?"low" as const:count<=2?"moderate" as const:"high" as const,provider:"TomTom Traffic Incidents API"}
}
function score(weather:NonNullable<ContextFactors>["weather"],traffic:NonNullable<ContextFactors>["traffic"]){
 let value=0;const factors:string[]=[];
 const p=weather?.precipitation_mm??0;if(p>=5){value+=20;factors.push("Heavy precipitation in external weather context")}else if(p>0){value+=10;factors.push("Precipitation present in external weather context")}
 const vis=weather?.visibility_m;if(vis!=null&&vis<500){value+=30;factors.push("Very low external visibility")}else if(vis!=null&&vis<2000){value+=15;factors.push("Reduced external visibility")}
 const wind=weather?.wind_kmh;if(wind!=null&&wind>40){value+=20;factors.push("High external wind speed")}else if(wind!=null&&wind>25){value+=10;factors.push("Elevated external wind speed")}
 const code=weather?.weather_code??0;if([45,48].includes(code)){value+=15;factors.push("Fog indicated by external weather model")}else if(code>=95){value+=35;factors.push("Thunderstorm indicated by external weather model")}else if(code>=61){value+=20;factors.push("Rain or snow indicated by external weather model")}
 const c=traffic?.incident_count;if(c!=null){if(c>5){value+=30;factors.push("High nearby traffic-incident count")}else if(c>=3){value+=20;factors.push("Moderate nearby traffic-incident count")}else if(c>0){value+=10;factors.push("Nearby traffic incidents detected")}}
 return{score:Math.min(100,value),factors}
}
export async function enrichContext(session:ClaimSession):Promise<ContextFactors>{
 const location=session.claim_data.incident_location,at=parsedDate(String(session.claim_data.incident.date_time??""));
 if(!location||!at)return null;
 let weather:NonNullable<ContextFactors>["weather"]=null,traffic:NonNullable<ContextFactors>["traffic"]=null;
 let ws="unavailable",ts="unavailable";const factors:string[]=[];
 try{weather=await fetchWeather(location.latitude,location.longitude,at);ws="available"}catch{factors.push("Weather context unavailable")}
 try{traffic=await fetchTraffic(location.latitude,location.longitude);ts=traffic.provider?"available":"not_configured"}catch{factors.push("Traffic context unavailable")}
 const scored=score(weather,traffic);
 return{generated_at:new Date().toISOString(),provider_status:{weather:ws,traffic:ts},weather,traffic,context_score:(weather||traffic)?scored.score:null,factors:[...scored.factors,...factors]}
}
