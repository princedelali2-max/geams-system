const { chromium } = require('playwright');const fs=require('fs'),{spawn}=require('child_process');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c?'':'  '+String(typeof x==='string'?x:JSON.stringify(x)).slice(0,250)))};
const H='GH-VR-HOH-001-P3Q7',B='http://localhost:8075';
const J=async(m,p,t,b)=>{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});let j={};try{j=await r.json()}catch(e){}return{s:r.status,j}};
(async()=>{
 const ROOT='/tmp/goutbox';fs.rmSync(ROOT,{recursive:true,force:true});fs.mkdirSync(ROOT,{recursive:true});
 const srv=spawn('node',['geams-server.js'],{env:{...process.env,PORT:'8075',GEAMS_DATA:ROOT+'/d.json',GEAMS_HQ_USERS:ROOT+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:'Test-Owner-Pass-1',GEAMS_SEED_DEFAULT_STATIONS:'1',GEAMS_BACKUP_HOURS:'0'}});await sleep(2500);
 const hq=(await J('POST','/api/hq/login',null,{username:'hqadmin',password:'Test-Owner-Pass-1'})).j.token;
 await J('PUT','/api/kv/'+encodeURIComponent('registry:stations'),hq,{value:{[H]:{id:H,name:'Hohoe Control',region:'V',town:'x',lat:7.15,lng:0.47,jurisdictionRadiusM:3000}}});
 const mkUnit=async(kind,name,phone,lcr)=>{await J('POST','/api/unit/signup',null,{kind,password:'pass1234',cred:{name,phone,lcrId:lcr,rank:'X'}});const p=(await J('GET','/api/lcr/pending',hq)).j.pending.find(x=>x.name===name);await J('POST','/api/lcr/approve',hq,{kind,badge:p.badge,approve:true});return (await J('POST','/api/unit/login',null,{kind,name,password:'pass1234'})).j};
 const br=await chromium.launch();

 const off=await mkUnit('officer','Off One','0240000101',H);const fire=await mkUnit('fire','Fire One','0240000102',H);const amb=await mkUnit('ambulance','Amb One','0240000103',H);
 ok('crew signed in',!!off.token&&!!fire.token,[off,fire]);
 const lcr=(await J('POST','/api/lcr/login',null,{stationId:H,passphrase:'hohoe2024'})).j.token;
 const now=Date.now();
 await J('PUT','/api/kv/'+encodeURIComponent('lcr:'+H+':incidents'),lcr,{value:{I1:{id:'I1',type:'medical',priority:'high',status:'new',location:'x',lat:7.15,lng:0.47,civilianName:'C',createdAt:new Date(now).toISOString(),source:'civilian-app',officerName:'Off One',officerBadge:off.badge||off.user&&off.user.badge,officerStatus:'assigned'}}});
 await J('PUT','/api/kv/'+encodeURIComponent('fire:'+H+':incidents'),lcr,{value:{F1:{id:'F1',type:'fire',status:'new',location:'x',lat:7.15,lng:0.47,createdAt:now}}});
 const run=async(file,key,id,patch,tok)=>{
  const c=await br.newContext();const P=await c.newPage();await P.goto(B+'/'+file);await sleep(2500);
  await P.evaluate((t)=>{GeamsSync.setToken(t)},tok);await sleep(500);
  await c.setOffline(true);
  const r1=await P.evaluate(async([k,i,p])=>{return await GeamsSync.patchQueued(k,i,p)},[key,id,patch]);
  const n1=await P.evaluate(()=>GeamsSync.outboxCount());
  ok(file+': offline update is kept, not lost',r1===false&&n1===1,[r1,n1]);
  ok(file+': the crew is told it is waiting',/saved on this phone/.test(await P.evaluate(()=>(document.getElementById('geams-outbox')||{innerText:''}).innerText)));
  const stillOld=(await J('GET','/api/kv/'+encodeURIComponent(key),hq)).j.value[id];
  ok(file+': server has not got it yet',!Object.keys(patch).some(k=>stillOld[k]===patch[k]),stillOld);
  await P.evaluate(()=>{window.__ls=localStorage.getItem('geams_outq')});
  await P.evaluate(([k,i,p])=>{GeamsSync.patchQueued(k,i,Object.assign({},p,{extra:'second'}))},[key,id,patch]);
  ok(file+': a second update for the same job is merged',(await P.evaluate(()=>GeamsSync.outboxCount()))===1);
  await c.setOffline(false);await P.evaluate(()=>{GeamsSync.outFlush()});await sleep(2500);
  const now2=(await J('GET','/api/kv/'+encodeURIComponent(key),hq)).j.value[id];
  ok(file+': after the signal returns the server has it',Object.keys(patch).every(k=>now2[k]===patch[k])&&now2.extra==='second',now2);
  ok(file+': queue empty and notice gone',(await P.evaluate(()=>GeamsSync.outboxCount()))===0&&!(await P.evaluate(()=>{const e=document.getElementById('geams-outbox');return e&&e.style.display!=='none'})));
  await c.close();
 };
 await run('geams-dispatch-app.html','lcr:'+H+':incidents','I1',{officerStatus:'arrived'},off.token);
 await run('geams-fire-service.html','fire:'+H+':incidents','F1',{status:'accepted'},fire.token);
 await J('PUT','/api/kv/'+encodeURIComponent('ambulance:'+H+':incidents'),lcr,{value:{A1:{id:'A1',type:'medical',status:'new',location:'x',lat:7.15,lng:0.47,createdAt:now}}});
 await run('geams-ambulance-service.html','ambulance:'+H+':incidents','A1',{status:'accepted'},amb.token);
 // survive a restart of the app: queue is on the phone
 {const c=await br.newContext();const P=await c.newPage();await P.goto(B+'/geams-dispatch-app.html');await sleep(2000);await P.evaluate((t)=>{GeamsSync.setToken(t)},off.token);await c.setOffline(true);
  await P.evaluate((H)=>{GeamsSync.patchQueued('lcr:'+H+':incidents','I1',{officerStatus:'case_closed'})},H);await sleep(300);
  await c.setOffline(false);await P.reload();await sleep(2500);await P.evaluate((t)=>{GeamsSync.setToken(t)},off.token);
  ok('queue survives closing the app',(await P.evaluate(()=>GeamsSync.outboxCount()))>=1);
  await P.evaluate(()=>{GeamsSync.outFlush()});await sleep(2500);
  ok('and is sent on the next start',(await J('GET','/api/kv/'+encodeURIComponent('lcr:'+H+':incidents'),hq)).j.value.I1.officerStatus==='case_closed');await c.close();}
 // a refused update is dropped, not retried for ever
 {const c=await br.newContext();const P=await c.newPage();await P.goto(B+'/geams-dispatch-app.html');await sleep(2000);await P.evaluate((t)=>{GeamsSync.setToken(t)},off.token);
  await P.evaluate(()=>{localStorage.setItem('geams_outq',JSON.stringify([{kind:'patch',key:'lcr:GH-VR-HOH-001-P3Q7:incidents',id:'I1',patch:{civilianName:'Hacker'},at:1}]))});
  await P.evaluate(()=>{GeamsSync.outFlush()});await sleep(2500);
  ok('refused saved update is dropped',(await P.evaluate(()=>GeamsSync.outboxCount()))===0&&(await J('GET','/api/kv/'+encodeURIComponent('lcr:'+H+':incidents'),hq)).j.value.I1.civilianName==='C');await c.close();}
 await br.close();srv.kill();console.log('\n'+pass+' passed, '+fail+' failed');process.exit(fail?1:0);
})().catch(e=>{console.log('ERR',e.stack);process.exit(2)});
