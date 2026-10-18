import test from "node:test";
import assert from "node:assert/strict";
import {calendarDate, calendarValue, monthsBefore, rangeBounds, rangePresets} from "../src/dateDomain.ts";
import {measurementQuery} from "../src/domain.ts";
import {healthQuery} from "../src/healthDomain.ts";
import {normalizeSearch} from "../src/routingDomain.ts";
import {deviceLabel, scaleNumber, scaleProfile} from "../src/bodyDomain.ts";

test("half-year and year presets use calendar months and clamp month ends",()=>{
  assert.equal(new Date(monthsBefore(Date.parse("2026-08-31T04:30:00Z"),6)).toISOString(),"2026-02-28T04:30:00.000Z");
  assert.equal(new Date(monthsBefore(Date.parse("2024-02-29T12:30:00Z"),12)).toISOString(),"2023-02-28T12:30:00.000Z");
  const now=Date.parse("2026-10-18T04:00:00Z");
  for(const period of ["30","90","180","365"]){
    const measurement=new URLSearchParams(measurementQuery({kind:"blood_pressure",member:"",device:"",unassigned:false,period,from:"",to:"",group:"day",page:1},now));
    const health=new URLSearchParams(healthQuery("member","weight",1,"","","day","",period,now));
    assert.equal(measurement.get("from"),health.get("from"));
    assert.equal(normalizeSearch("period="+period),"period="+period);
  }
  assert.deepEqual(rangePresets.map(p=>p.value),["30","90","180","365","all"]);
});
test("calendar selections retain their chosen date in different browser timezones",()=>{
  const timezone=process.env.TZ;
  try{
    for(const tz of ["America/Los_Angeles","Asia/Tokyo","Pacific/Auckland"]){
      process.env.TZ=tz;
      assert.equal(calendarValue(calendarDate("2026-10-18")),"2026-10-18");
      assert.deepEqual(rangeBounds("custom","2026-10-18","2026-10-18"),{from:"2026-10-17T16:00:00.000Z",to:"2026-10-18T16:00:00.000Z"});
    }
  }finally{if(timezone===undefined)delete process.env.TZ;else process.env.TZ=timezone;}
  assert.equal(calendarDate("2026-02-30"),undefined);
});
test("scale labels use stable assigned numbers, independently of list order",()=>{
  const a={id:"a",name:"卧室秤",profile:scaleProfile,scale_number:1};
  const b={id:"b",name:"客厅秤",profile:scaleProfile,scale_number:12};
  assert.equal(scaleNumber(a),"S001");
  assert.equal(deviceLabel(b),"S012 · 客厅秤");
  assert.equal([b,a].map(deviceLabel)[1],"S001 · 卧室秤");
  assert.equal(deviceLabel({name:"血压计",profile:"omron-hem-7374t1"}),"血压计");
});
