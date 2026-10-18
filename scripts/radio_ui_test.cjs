#!/usr/bin/env node
// Synthetic ESP32-only page acceptance. Requires Playwright and Chromium.
// No connections to collectors, Eir, MQTT or a database.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname,'../firmware/main/radio.html'),'utf8');
const output = process.env.EIR_RADIO_SCREENSHOTS || '/tmp/eir-radio-ui';
fs.mkdirSync(output,{recursive:true});
(async()=>{
  const browser = await chromium.launch({headless:true, ...(process.env.EIR_TEST_BROWSER ? {executablePath:process.env.EIR_TEST_BROWSER} : {})});
  try {
    const page=await browser.newPage({viewport:{width:390,height:844}}), errors=[], commands=[];
    page.on('pageerror',error=>errors.push(error.message));
    let active=false, session=0, until=0, now=10000, stale=false, offline=false, maintain=false, wifi=true, connected=true;
    const stats=(rssi,old=false)=>({rssi,min:rssi-6,max:rssi+4,mean:rssi-1.5,count:15,age_ms:old?16000:200,at_ms:now-(old?16000:200)});
    const device=(address,name,extra={})=>({address,address_type:0,name,configured:false,connected:false,profile:'',hint:'BLE 设备',services:['180F'],manufacturer_ids:['1234'],tx_power:null,event_type:0,payload_valid:true,advertisement_hex:'02010603030F18',scan_response_hex:'',age_ms:200,advertisement:stats(-72,stale),connection:null,...extra});
    function state(){return {session_id:session,uptime_ms:now,active,until_ms:until,remaining_ms:active?until-now:0,scanning:active,available:!maintain,connecting:false,capacity:32,evictions:0,wifi:{connected:wifi,rssi:wifi?-57:null,ssid:'Eir 测试网络 · 模拟',bssid:'02:00:00:00:00:01',channel:6,stats:session&&wifi?stats(-57):null},devices:session?[
      device('02:00:00:00:00:11','AFU-WL-TZ-A1 · 模拟',{configured:true,connected,profile:'afu-wl-tz-a1',connection:stats(-64,stale),services:['FFF0'],hint:'阿福体脂秤广播'}),
      device('02:00:00:00:00:12','OMRON · 模拟',{configured:true,profile:'omron-hem-7374t1',services:['FE4A'],manufacturer_ids:['020E'],hint:'Omron 广播'}),
      device('02:00:00:00:00:13','<img src=x onerror="window.radioXss=1">',{address_type:1,advertisement:stats(-88,stale)}),
      device('02:00:00:00:00:14','',{advertisement:stats(-91,stale),payload_valid:false,event_type:3})]:[]};}
    await page.route('http://eir-test-radio.test/**',async route=>{
      const url=new URL(route.request().url());
      if(url.pathname==='/radio/status'){if(offline)return route.abort();return route.fulfill({json:state()});}
      if(url.pathname==='/radio/scan'){
        const {seconds}=route.request().postDataJSON();commands.push(seconds);
        if(maintain&&seconds)return route.fulfill({status:409,body:'Collector maintenance in progress'});
        active=seconds>0;if(active){session++;stale=false;until=now+seconds*1000;}else{until=Math.min(until,now);}return route.fulfill({json:{ok:true}});
      }
      if(url.pathname==='/radio')return route.fulfill({contentType:'text/html',body:html});
      return route.fulfill({status:404,body:'Not found'});
    });
    await page.goto('http://eir-test-radio.test/radio');
    await page.waitForFunction(()=>document.getElementById('badge').textContent==='尚未开始');
    assert.equal(await page.locator('#stop').isDisabled(),true);
    await page.locator('#start').click();
    await page.waitForFunction(()=>document.querySelectorAll('.device').length===4);
    assert.deepEqual(commands,[180]);
    assert.equal(await page.evaluate(()=>window.radioXss),undefined);
    assert.equal(await page.locator('#devices img').count(),0);
    assert.equal(await page.locator('#devices').innerText().then(t=>t.includes('<img src=x')),true);
    await page.locator('.device').filter({hasText:'AFU-WL-TZ-A1'}).getByRole('button',{name:'关注',exact:true}).click();
    await page.locator('.device').filter({hasText:'OMRON'}).getByRole('button',{name:'关注',exact:true}).click();
    for(let i=0;i<8;i++){now+=2000;await page.evaluate(()=>refresh());}
    await page.locator('#only-focus').check();assert.equal(await page.locator('.device').count(),2);
    const scale=page.locator('.device').filter({hasText:'AFU-WL-TZ-A1'});
    await scale.locator('summary').click();
    now+=2000;await page.evaluate(()=>refresh());assert.equal(await scale.locator('details').getAttribute('open'),'');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=390),true);
    await page.evaluate(async()=>{scrollTo(0,0);await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);});
    await page.screenshot({path:path.join(output,'radio-test-mobile.png'),fullPage:true});
    await page.setViewportSize({width:1280,height:960});
    await page.evaluate(async()=>{await refresh();scrollTo(0,0);await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=1280),true);
    await page.screenshot({path:path.join(output,'radio-test-desktop.png'),fullPage:true});
    await page.locator('#filter').fill('00:00:12');assert.equal(await page.locator('.device').count(),1);
    await page.locator('#filter').fill('FE4A');assert.equal(await page.locator('.device').count(),1);
    await page.locator('#filter').fill('missing');assert.equal(await page.locator('.empty').count(),1);
    await page.locator('#filter').fill('');
    stale=true;now+=16000;await page.evaluate(()=>refresh());
    assert((await page.locator('#devices').innerText()).includes('旧读数'));
    connected=false;await page.evaluate(()=>refresh());assert((await scale.innerText()).includes('已断开'));
    offline=true;await page.evaluate(()=>refresh());assert.equal(await page.locator('body').getAttribute('class'),'offline');
    assert((await page.locator('#error').innerText()).includes('上次数据'));
    offline=false;wifi=false;await page.evaluate(()=>refresh());assert.equal(await page.locator('#wifi-rssi').innerText(),'—');
    assert.equal(await page.locator('#error').innerText(),'');wifi=true;
    await page.locator('#restart').click();await page.waitForFunction(()=>document.getElementById('badge').textContent==='测试进行中');
    assert.equal(commands.at(-1),180);assert.equal(session,2);
    assert.equal(await page.locator('.device.focus').count(),2);
    await page.locator('#stop').click();await page.waitForFunction(()=>document.getElementById('badge').textContent==='已停止');
    assert.equal(commands.at(-1),0);assert((await page.locator('#devices').innerText()).includes('测试已停止'));
    await page.locator('#duration').selectOption('60');await page.locator('#start').click();
    await page.waitForFunction(()=>document.getElementById('badge').textContent==='测试进行中');assert.equal(commands.at(-1),60);
    active=false;now+=61000;await page.evaluate(()=>refresh());assert.equal(await page.locator('#stop').isDisabled(),true);
    maintain=true;await page.evaluate(()=>refresh());assert.equal(await page.locator('#start').isDisabled(),true);assert.equal(await page.locator('#restart').isDisabled(),true);
    maintain=false;active=false;session=0;now=500;await page.evaluate(()=>refresh());assert.equal(await page.locator('.device').count(),0);
    assert.deepEqual(errors,[]);
    console.log('Radio UI: 390px / desktop, start-stop-restart, expiry, filter, focus, source freshness, disconnect/recovery, maintenance, reboot and unsafe names passed.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
