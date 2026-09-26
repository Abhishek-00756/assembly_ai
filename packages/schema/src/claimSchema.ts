/** ClaimSchema — single source of truth for all FNOL claim fields. */
import { z } from "zod";
export const UNKNOWN_VALUE_SENTINEL="__UNKNOWN__" as const;
export const unknownable=<T extends z.ZodTypeAny>(schema:T)=>z.union([schema,z.literal(UNKNOWN_VALUE_SENTINEL)]).nullable();
export const RequirementTier=z.enum(["required","recommended","optional"]); export type RequirementTier=z.infer<typeof RequirementTier>;
export const SafetySchema=z.object({injuries_reported:unknownable(z.boolean()),still_at_scene:unknownable(z.boolean()),injury_flag_note:z.string().max(280).nullable().default(null)});
export const IncidentSchema=z.object({date_time:unknownable(z.string()),location:unknownable(z.string()),description_summary:unknownable(z.string().max(2000)),weather:unknownable(z.string()),road_conditions:unknownable(z.string()),police_report_number:unknownable(z.string()).default(null)});
export const IncidentLocationSchema=z.object({latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180),accuracy_m:z.number().nonnegative().nullable().default(null),address:z.string().nullable().default(null),captured_at:z.string(),source:z.literal("device_gps").default("device_gps"),reverse_geocoder:z.string().nullable().default(null)}).nullable().default(null);
export type IncidentLocation=z.infer<typeof IncidentLocationSchema>;
export const ContextFactorsSchema=z.object({
  generated_at:z.string(),
  provider_status:z.object({weather:z.string(),traffic:z.string()}),
  weather:z.object({observed_at:z.string().nullable(),temperature_c:z.number().nullable(),precipitation_mm:z.number().nullable(),visibility_m:z.number().nullable(),wind_kmh:z.number().nullable(),weather_code:z.number().nullable(),description:z.string().nullable()}).nullable(),
  traffic:z.object({incident_count:z.number().nonnegative().nullable(),density:z.enum(["low","moderate","high","unavailable"]),provider:z.string().nullable()}).nullable(),
  context_score:z.number().min(0).max(100).nullable(),
  factors:z.array(z.string()).default([])
}).nullable().default(null);
export type ContextFactors=z.infer<typeof ContextFactorsSchema>;
export const CrossPartyContextSchema=z.object({
  incident_group_id:z.string(),
  related_session_count:z.number().int().nonnegative(),
  grounded_narrative:z.string(),
  conflicts:z.array(z.string()).default([]),
  checked_at:z.string()
}).nullable().default(null);
export type CrossPartyContext=z.infer<typeof CrossPartyContextSchema>;
export const OtherPartySchema=z.object({name:unknownable(z.string()),phone:unknownable(z.string()),insurer_name:unknownable(z.string()),policy_number:unknownable(z.string()),vehicle:z.object({make:unknownable(z.string()).default(null),model:unknownable(z.string()).default(null),plate:unknownable(z.string()).default(null)}).default({make:null,model:null,plate:null})});
export const UserVehicleSchema=z.object({make:unknownable(z.string()),model:unknownable(z.string()),plate:unknownable(z.string()),damage_description:unknownable(z.string()),drivable:unknownable(z.boolean()),airbags_deployed:unknownable(z.boolean()).default(null)});
export const PhotoTypeEnum=z.enum(["plate","damage","scene","insurance_card"]); export type PhotoType=z.infer<typeof PhotoTypeEnum>;
export const PhotoVerificationSchema=z.object({photo_verified:z.boolean().nullable().default(null),photo_verification_note:z.string().nullable().default(null),exif_capture_at:z.string().nullable().default(null),exif_latitude:z.number().nullable().default(null),exif_longitude:z.number().nullable().default(null),time_delta_seconds:z.number().nullable().default(null),distance_m:z.number().nullable().default(null)});
export type PhotoVerification=z.infer<typeof PhotoVerificationSchema>;
export const PhotoEntrySchema=z.object({photo_type:PhotoTypeEnum,storage_path:z.string(),uploaded_at:z.string(),verification:PhotoVerificationSchema.default({photo_verified:null,photo_verification_note:null,exif_capture_at:null,exif_latitude:null,exif_longitude:null,time_delta_seconds:null,distance_m:null})});
export const EvidenceSchema=z.object({photos:z.array(PhotoEntrySchema).default([]),witnesses:unknownable(z.string()).default(null),dashcam_available:unknownable(z.boolean()).default(null)});
export const PolicyInfoSchema=z.object({policyholder_name:unknownable(z.string()),policy_number:unknownable(z.string()),contact_phone:unknownable(z.string()),contact_email:unknownable(z.string()).default(null)});
export const ClaimDataSchema=z.object({safety:SafetySchema,incident:IncidentSchema,incident_location:IncidentLocationSchema,context_factors:ContextFactorsSchema,cross_party_context:CrossPartyContextSchema,other_parties:z.array(OtherPartySchema).default([]),user_vehicle:UserVehicleSchema,evidence:EvidenceSchema,policy_info:PolicyInfoSchema});
export type ClaimData=z.infer<typeof ClaimDataSchema>;
export const emptyClaimData=():ClaimData=>({safety:{injuries_reported:null,still_at_scene:null,injury_flag_note:null},incident:{date_time:null,location:null,description_summary:null,weather:null,road_conditions:null,police_report_number:null},incident_location:null,context_factors:null,cross_party_context:null,other_parties:[],user_vehicle:{make:null,model:null,plate:null,damage_description:null,drivable:null,airbags_deployed:null},evidence:{photos:[],witnesses:null,dashcam_available:null},policy_info:{policyholder_name:null,policy_number:null,contact_phone:null,contact_email:null}});
export const FIELD_TIERS:Record<string,RequirementTier>={"safety.injuries_reported":"required","safety.still_at_scene":"required","incident.date_time":"required","incident.location":"required","incident.description_summary":"required","user_vehicle.make":"required","user_vehicle.model":"required","user_vehicle.plate":"required","policy_info.policyholder_name":"required","policy_info.policy_number":"required","policy_info.contact_phone":"required","other_parties[0].name":"recommended","other_parties[0].phone":"recommended","other_parties[0].insurer_name":"recommended","other_parties[0].policy_number":"recommended","incident.weather":"recommended","incident.road_conditions":"recommended","user_vehicle.damage_description":"recommended","user_vehicle.drivable":"recommended","evidence.photos[]":"recommended","incident.police_report_number":"optional","other_parties[0].vehicle.make":"optional","other_parties[0].vehicle.model":"optional","other_parties[0].vehicle.plate":"optional","evidence.witnesses":"optional","evidence.dashcam_available":"optional","user_vehicle.airbags_deployed":"optional"};
export const REQUIRED_FIELDS=Object.entries(FIELD_TIERS).filter(([,t])=>t==="required").map(([f])=>f); export const RECOMMENDED_FIELDS=Object.entries(FIELD_TIERS).filter(([,t])=>t==="recommended").map(([f])=>f);
