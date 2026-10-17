import test from "node:test";
import assert from "node:assert/strict";
import {bodyFatValue, memberProfile} from "../src/bodyDomain.ts";
import {measurementQuery} from "../src/domain.ts";
test("missing body fat stored as zero is displayed as missing",()=>{
 assert.equal(bodyFatValue({body_fat_pct:0,body_fat_status:"missing_adc"}),null);
 assert.equal(bodyFatValue({body_fat_pct:0,body_fat_status:"missing_profile"}),null);
 assert.equal(bodyFatValue({body_fat_pct:21.2,body_fat_status:"estimated"}),21.2);
 assert.equal(bodyFatValue({weight_valid:false,body_fat_pct:21.2,body_fat_status:"estimated"}),null);
});
test("scale queries and CSV use the same kind, member and time boundary",()=>{
 const q=new URLSearchParams(measurementQuery({kind:"body_composition",member:"m",device:"d",unassigned:false,period:"all",from:"",to:"",group:"week",page:2}));
 assert.equal(q.get("kind"),"body_composition");assert.equal(q.get("member_id"),"m");assert.equal(q.get("device_id"),"d");assert.equal(q.has("from"),false);
});
test("optional height is numeric or null without inventing personal data",()=>{
 assert.equal(memberProfile({height_cm:"170.5"}).height_cm,170.5);assert.equal(memberProfile({height_cm:""}).height_cm,null);
});
