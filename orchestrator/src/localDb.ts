import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
export type LocalDbState={claimants:any[];claim_sessions:any[];report_artifacts:any[];session_event_log:any[]};
const DATA_DIR=process.env.INSURANOS_LOCAL_DATA_DIR||path.resolve(process.cwd(),"../.localdata");
const DATA_FILE=path.join(DATA_DIR,"insuranos.json");
const EMPTY:LocalDbState={claimants:[],claim_sessions:[],report_artifacts:[],session_event_log:[]};
export function ensureDb(){fs.mkdirSync(DATA_DIR,{recursive:true});if(!fs.existsSync(DATA_FILE))fs.writeFileSync(DATA_FILE,JSON.stringify(EMPTY,null,2));}
export function readDb():LocalDbState{ensureDb();return JSON.parse(fs.readFileSync(DATA_FILE,"utf8"));}
export function writeDb(state:LocalDbState){ensureDb();const tmp=DATA_FILE+".tmp";fs.writeFileSync(tmp,JSON.stringify(state,null,2));fs.renameSync(tmp,DATA_FILE);}
export function mutateDb<T>(fn:(state:LocalDbState)=>T):T{const state=readDb();const result=fn(state);writeDb(state);return result;}
export {DATA_DIR,DATA_FILE,randomUUID};
