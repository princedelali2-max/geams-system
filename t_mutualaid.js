// Mutual aid for fire AND ambulance, on the real server: two crews on two devices, real sign-ups, real sync.
const { chromium } = require('playwright');const fs=require('fs'),{spawn}=require('child_process');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c?'':'  '+String(typeof x==='string'?x:JSON.stringify(x)).slice(0,250)))};
const ACC='GH-GA-ACC-001-B9C1',TEM='GH-GA-ACC-007-F2A3',B='http://localhost:8089';
const hav=(a,b,c,d)=>{const R=6371,t=x=>x*Math.PI/180,dl=t(c-a),dg=t(d-b),q=Math.sin(dl/2)**2+Math.cos(t(a))*Math.cos(t(c))*Math.sin(dg/2)**2;return R*2*Math.atan2(Math.sqrt(q),Math.sqrt(1-q))};
const J=async(m,p,t,b)=>{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});let j={};try{j=await r.json()}catch(e){}return{s:r.status,j}};
(async()=>{
 const ROOT='/tmp/gma';fs.rmSync(ROOT,{recursive:true,force:true});fs.mkdirSync(ROOT,{recursive:true});
 const srv=spawn('node',['geams-server.js'],{env:{...process.env,PORT:'8089',GEAMS_DATA:ROOT+'/d.json',GEAMS_HQ_USERS:ROOT+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:'Test-Owner-Pass-1',GEAMS_SEED_DEFAULT_STATIONS:'1',GEAMS_BACKUP_HOURS:'0'}});await sleep(2000);
 const hq=(await J('POST','/api/hq/login',null,{username:'hqadmin',password:'Test-Owner-Pass-1'})).j.token;
 const stRes=await J('GET','/api/kv/'+encodeURIComponent('registry:stationLocations'));const locs=stRes.j.value||{};
 const A0={lat:5.5502,lng:-0.2174},T0={lat:5.6698,lng:-0.0167};
 const br=await chromium.launch();
 const mk=async(f)=>{const c=await br.newContext({geolocation:{latitude:5.55,longitude:-0.2},permissions:['geolocation']});await c.route(/cdnjs|unpkg|jsdelivr|tile|arcgis|openstreetmap|fonts|osrm/,r=>r.abort());const p=await c.newPage();p.on('pageerror',e=>{if(!/L is not defined|reading '(addTo|on|setView|remove|classList|invalidateSize|getContainer|setLatLng|getZoom|fitBounds)'/.test(e.message))console.log('PAGEERR',e.message)});await p.goto(B+'/'+f);await sleep(1800);return p};
 for(const S of [{k:'fire',file:'geams-fire-service.html',Data:'FireData',App:'FireApp',MA:'FireMutualAid',type:'Structure Fire',ico:'🚒'},{k:'ambulance',file:'geams-ambulance-service.html',Data:'AmbulanceData',App:'AmbulanceApp',MA:'AmbulanceMutualAid',type:'Cardiac Arrest',ico:'🚑'}]){
  console.log('\n=== '+S.k.toUpperCase());
  const mkCrew=async(name,phone,lcr)=>{await J('POST','/api/unit/signup',null,{kind:S.k,password:'secret123',cred:{name,phone,lcrId:lcr,rank:'Officer',vehicle:'Unit 1'}});const p=(await J('GET','/api/lcr/pending',hq)).j.pending.find(x=>x.name===name);await J('POST','/api/lcr/approve',hq,{kind:S.k,badge:p.badge,approve:true})};
  const nA='Crew Accra '+S.k,nB='Crew Tema '+S.k;await mkCrew(nA,'02455'+(S.k==='fire'?'10001':'20001'),ACC);await mkCrew(nB,'02455'+(S.k==='fire'?'10002':'20002'),TEM);
  const pA=await mk(S.file),pB=await mk(S.file);
  for(const [p,n] of [[pA,nA],[pB,nB]]){await p.fill('#login-name',n);await p.fill('#login-pass','secret123');await p.click('#login-btn');await sleep(3500)}
  const cA=await pA.evaluate(D=>(0,eval)(D)&&(0,eval)(D).crew&&{n:(0,eval)(D).crew.name,l:(0,eval)(D).crew.lcrId},S.Data),cB=await pB.evaluate(D=>(0,eval)(D)&&(0,eval)(D).crew&&{n:(0,eval)(D).crew.name,l:(0,eval)(D).crew.lcrId},S.Data);
  ok('crew A signed in (Accra)',cA&&cA.n===nA&&cA.l===ACC,cA);ok('crew B signed in (Tema)',cB&&cB.n===nB&&cB.l===TEM,cB);
  // station forwards an incident (written by HQ as a stand-in for the control room)
  const inc={id:'INC-'+S.k+'-1',type:S.type,priority:'critical',location:'12 Ring Road, Accra',lat:5.556,lng:-0.199,notes:'trapped',serviceStatus:'new',status:'new',forwardedBy:'Accra Central LCR',createdAt:new Date().toISOString()};
  let r=await J('PUT','/api/kv/'+encodeURIComponent(S.k+':'+ACC+':incidents'),hq,{value:{[inc.id]:inc}});ok('incident forwarded to the service',r.s===200,r);
  await sleep(3500);
  ok('crew A queue shows it',await pA.evaluate(t=>document.getElementById('screen-queue').innerHTML.includes(t),S.type));
  ok("crew B (other station) queue does NOT show it",!(await pB.evaluate(t=>document.getElementById('screen-queue').innerHTML.includes(t),S.type)));
  await pA.click('text=Respond');await sleep(800);
  const job=await pA.evaluate(D=>{const j=(0,eval)(D).currentJob;return j&&{lat:j.lat,lng:j.lng}},S.Data);ok('A has the job at the incident GPS',job&&job.lat===5.556&&job.lng===-0.199,job);
  const near=await pA.evaluate(D=>(0,eval)(D).nearbyStations((0,eval)(D).crew.lcrId).slice(0,5).map(s=>({id:s.id,km:s.distanceKm})),S.Data);
  const te=near.find(s=>s.id===TEM);const own=await pA.evaluate(D=>{const s=(0,eval)(D).findStation((0,eval)(D).crew.lcrId);return {lat:s.lat,lng:s.lng}},S.Data);ok('nearby ranking uses real distance',te&&Math.abs(te.km-hav(own.lat,own.lng,T0.lat,T0.lng))<0.05,{te,exp:hav(own.lat,own.lng,T0.lat,T0.lng)});
  ok('nearest first',near.every((s,i)=>!i||s.km>=near[i-1].km),near);
  await pA.click('text=Request Mutual Aid');await sleep(400);
  await pA.evaluate(id=>{const b=[...document.querySelectorAll('button')].find(b=>/Send Request/.test(b.textContent)&&b.getAttribute('onclick').includes(id));b&&b.click()},TEM);await sleep(1200);
  const out=await pA.evaluate(M=>(0,eval)(M).myOutgoing(),S.MA);ok('outgoing request is pending',out.length===1&&out[0].status==='pending',out);
  const reqId=out[0]&&out[0].id;
  await sleep(3500);
  const inB=await pB.evaluate(M=>(0,eval)(M).myIncoming(),S.MA);ok('Tema crew receives exactly one request',inB.length===1,inB);
  ok('request carries real incident GPS',inB[0]&&inB[0].lat===5.556,inB[0]);
  await pB.evaluate(A=>(0,eval)(A).navigate('aid'),S.App);await sleep(500);
  await pB.click('text=Accept & Respond');await sleep(1200);
  const jb=await pB.evaluate(D=>{const j=(0,eval)(D).currentJob;return j&&{m:j.isMutualAid,lat:j.lat}},S.Data);ok('Tema crew has an active mutual-aid job',jb&&jb.m&&jb.lat===5.556,jb);
  await sleep(3500);
  const rec=await pA.evaluate(([M,id])=>(0,eval)(M).recordFor(id),[S.MA,reqId]);ok('Accra sees accepted + responder name',rec&&rec.status==='accepted'&&rec.acceptedByName===nB,rec);
  await pB.evaluate(([A])=>(0,eval)(A).setStatus('en_route'),[S.App]);await sleep(1500);await pB.context().setGeolocation({latitude:5.62,longitude:-0.1});await sleep(5000);
  const mv=await pA.evaluate(([M,id])=>(0,eval)(M).recordFor(id),[S.MA,reqId]);ok('responder live position/ETA reaches origin (real GPS fix from the responder device)',mv&&mv.unitETA!=null&&Math.abs(mv.unitLat-5.62)<0.01,mv);
  // a third party cannot spoof: another station's crew cannot tamper with the request
  // decline path with a second incident
  await pA.evaluate(([A])=>{(0,eval)(A).setStatus('on_scene');(0,eval)(A).setStatus('complete')},[S.App]);await sleep(800);
  const inc2={...inc,id:'INC-'+S.k+'-2',location:'Spintex Rd',lat:5.60,lng:-0.15};
  const cur=(await J('GET','/api/kv/'+encodeURIComponent(S.k+':'+ACC+':incidents'),hq)).j.value;cur[inc2.id]=inc2;await J('PUT','/api/kv/'+encodeURIComponent(S.k+':'+ACC+':incidents'),hq,{value:cur});
  await pA.evaluate(A=>(0,eval)(A).navigate('queue'),S.App);await sleep(3500);
  await pA.click('text=Respond');await sleep(600);await pA.click('text=Request Mutual Aid');await sleep(400);
  await pA.evaluate(id=>{const b=[...document.querySelectorAll('button')].find(b=>/Send Request/.test(b.textContent)&&b.getAttribute('onclick').includes(id));b&&b.click()},TEM);await sleep(3500);
  const o2=await pA.evaluate(M=>(0,eval)(M).myOutgoing().find(r=>r.incidentId==='INC-'+(M.startsWith('Fire')?'fire':'ambulance')+'-2'),S.MA);
  const r2=o2&&o2.id;await sleep(3000);
  ok('second request reached Tema',!!(await pB.evaluate(([M,id])=>(0,eval)(M).recordFor(id),[S.MA,r2])),o2);
  await pB.evaluate(A=>(0,eval)(A).navigate('aid'),S.App);await sleep(500);
  await pB.evaluate(()=>{const b=[...document.querySelectorAll('button')].find(b=>/Decline/.test(b.textContent));b&&b.click()});await sleep(3500);
  const dec=await pA.evaluate(([M,id])=>(0,eval)(M).recordFor(id),[S.MA,r2]);ok('decline propagates back honestly',dec&&dec.status==='declined',dec);
 }
 await br.close();srv.kill();console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
})().catch(e=>{console.log('ERR',e.stack);process.exit(2)});
