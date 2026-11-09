const fs=require('fs'),{spawn}=require('child_process');const sleep=ms=>new Promise(r=>setTimeout(r,ms));let pass=0,fail=0;
const ck=(n,c,x)=>{c?(pass++,console.log('PASS',n)):(fail++,console.log('FAIL',n,x===undefined?'':JSON.stringify(x).slice(0,400)))};
const B='http://localhost:8111';const J=async(m,p,t,b)=>{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});let j={};try{j=await r.json()}catch(e){}return{s:r.status,j}};
(async()=>{const R='/tmp/gescal';fs.rmSync(R,{recursive:true,force:true});fs.mkdirSync(R,{recursive:true});
 const srv=spawn('node',['geams-server.js'],{env:{...process.env,PORT:'8111',GEAMS_DATA:R+'/d.json',GEAMS_HQ_USERS:R+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:'Test-Owner-Pass-1',GEAMS_BACKUP_HOURS:'0',GEAMS_SEED_DEFAULT_STATIONS:'1',GEAMS_ESCALATE_SECS:'4',GEAMS_ESCALATE_OFFLINE_SECS:'2',GEAMS_ESCALATE_GRACE_SECS:'1',GEAMS_ESCALATE_TICK_MS:'500'}});await sleep(2500);
 const hq=(await J('POST','/api/hq/login',null,{username:'hqadmin',password:'Test-Owner-Pass-1'})).j.token;
 const T='GH-GA-ACC-007-F2A3',A='GH-VR-HOH-001-P3Q7',Bn='GH-VR-HO-001-J4K7',C='GH-GA-ACC-001-B9C1';
 await J('PUT','/api/kv/'+encodeURIComponent('registry:stations'),hq,{value:{[A]:{id:A,name:'Hohoe Control',region:'V',town:'Hohoe',lat:7.15,lng:0.47,phone:'0322000001'},[Bn]:{id:Bn,name:'Ho Control',region:'V',town:'Ho',lat:6.61,lng:0.47,phone:'0322000002'},[T]:{id:T,name:'Tema Control',region:'G',town:'Tema',lat:5.67,lng:0.0,phone:'0302000004'},[C]:{id:C,name:'Accra Control',region:'G',town:'Accra',lat:5.6,lng:-0.2,phone:'0302000003'}}});
 const lg=async(s,p)=>(await J('POST','/api/lcr/login',null,{stationId:s,passphrase:p})).j.token;
 const tA=await lg(A,'hohoe2024'),tB=await lg(Bn,'ho2024'),tC=await lg(C,'accra2024'),tT=await lg(T,'tema2024');
 ck('control room logins work',tA&&tC,[!!tA,!!tB,!!tC]);
 const KA='/api/kv/'+encodeURIComponent('lcr:'+A+':incidents'),KC='/api/kv/'+encodeURIComponent('lcr:'+T+':incidents');
 const rec=(id,x)=>({id,type:'Fire',priority:'critical',status:'new',location:'Secret Street 5',lat:7.15,lng:0.47,civilianName:'Private Person',civilianPhone:'0201234567',createdAt:new Date().toISOString(),source:'walk-in',...x});
 // station A keeps a screen open
 let poll=true;(async()=>{while(poll){await J('GET',KA,tA);await sleep(800)}})();
 await J('PUT',KA,tA,{value:{E1:rec('E1'),D1:rec('D1',{drill:true,location:'[DRILL] x'}),X1:rec('X1')}});
 await sleep(1500);let r=await J('GET','/api/escalations',hq);ck('nothing flagged before the waiting time',r.s===200&&r.j.open.length===0,r.j);
 await sleep(4000);r=await J('GET','/api/escalations',hq);
 const e1=(r.j.open||[]).find(e=>e.ref==='E1');
 ck('an alert nobody took is flagged to HQ after the waiting time',!!e1&&e1.reason==='unanswered'&&e1.station==='Hohoe Control'&&e1.type==='Fire'&&e1.priority==='critical',r.j);
 ck('drills are never flagged',!(r.j.open||[]).some(e=>e.ref==='D1'),r.j.open);
 ck('it names the nearest other control rooms with phone numbers, not far ones',e1&&e1.neighbours.length===1&&e1.neighbours[0].name==='Ho Control'&&e1.neighbours[0].phone==='0322000002'&&e1.neighbours[0].km>10&&e1.neighbours[0].km<80,e1&&e1.neighbours);
 ck('no caller details or exact location are in the warning',!/Secret|Private|0201234567|lat|lng/.test(JSON.stringify(r.j)),JSON.stringify(r.j).slice(0,300));
 ck('the station that is online is not called offline',e1&&e1.reason!=='station_offline');
 ck('HQ only: others are refused',(await J('GET','/api/escalations',tA)).s===403&&(await J('GET','/api/escalations')).s===403);
 ck('the stored list cannot be read through the generic data route, even by HQ',(await J('GET','/api/kv/'+encodeURIComponent('registry:escalations'),hq)).s===403);
 // neighbours
 let m=await J('GET','/api/escalations/mine',tB);ck('the neighbouring control room is told, with the other station\'s phone',m.s===200&&m.j.items.filter(i=>i.key.endsWith(':E1')).length===1&&m.j.items.find(i=>i.key.endsWith(':E1')).fromStation==='Hohoe Control'&&m.j.items.find(i=>i.key.endsWith(':E1')).type==='Fire'&&m.j.items[0].km>10,m.j);
 ck('the neighbour notice carries no caller details',!/Secret|Private|0201234567/.test(JSON.stringify(m.j)));
 m=await J('GET','/api/escalations/mine',tC);ck('a far control room is not told',m.s===200&&m.j.items.length===0,m.j);
 m=await J('GET','/api/escalations/mine',tA);ck('the station itself gets no neighbour notice about its own alert',m.s===200&&m.j.items.length===0,m.j);
 ck('only control rooms can ask for neighbour notices',(await J('GET','/api/escalations/mine',hq)).s===403);
 let L=(await J('GET','/api/stafflog',hq)).j.items;ck('the flag is in the staff log with the alert number and no personal data',L.some(x=>x.action==='escalation.flagged'&&x.ref==='E1')&&!/Secret|Private|0201234567/.test(JSON.stringify(L)),L.slice(0,2));
 // acknowledge
 r=await J('POST','/api/escalations/ack',hq,{key:A+':E1',note:'Phoned Ho'});ck('HQ can mark that it is handling it',r.s===200,r);
 r=await J('GET','/api/escalations',hq);ck('the acknowledgement shows who and when',r.j.open[0].ackBy&&r.j.open[0].ackAt&&r.j.open[0].ackNote==='Phoned Ho',r.j.open[0]);
 ck('others cannot acknowledge',(await J('POST','/api/escalations/ack',tA,{key:A+':E1'})).s===403);
 // taken -> cleared
 let cur=(await J('GET',KA,tA)).j.value;cur.E1.status='active';cur.E1.officerStatus='assigned';cur.E1.officerName='Off A';cur.E1.officerBadge='B1';
 r=await J('PUT',KA,tA,{value:cur});await sleep(1500);r=await J('GET','/api/escalations',hq);
 ck('once the station takes the alert the warning clears and says why',!r.j.open.some(e=>e.ref==='E1')&&r.j.recent.some(e=>e.ref==='E1'&&e.outcome==='taken'&&e.clearedAt),r.j);
 m=await J('GET','/api/escalations/mine',tB);ck('and the neighbour notice for it goes away',!m.j.items.some(i=>i.key.endsWith(':E1')),m.j);
 // cancelled
 cur=(await J('GET',KA,tA)).j.value;cur.X1.status='cancelled';await J('PUT',KA,tA,{value:cur});await sleep(1500);
 r=await J('GET','/api/escalations',hq);ck('a cancelled alert is cleared as cancelled',r.j.recent.some(e=>e.ref==='X1'&&e.outcome==='cancelled')||!r.j.open.some(e=>e.ref==='X1'),r.j);
 // offline station
 const w=await J('PUT',KC,hq,{value:{O1:rec('O1',{lat:5.67,lng:0.0})}});ck('(set-up) the alert was stored',w.s===200,w);await sleep(3300);
 r=await J('GET','/api/escalations',hq);const o1=(r.j.open||[]).find(e=>e.ref==='O1');
 ck('a station with no screen open is flagged sooner, as offline',!!o1&&o1.reason==='station_offline',r.j.open);
 ck('offline flag happened before the normal waiting time',o1&&o1.flaggedAt-o1.since<4000,o1&&[o1.flaggedAt-o1.since]);
  // staff log is system actor
 L=(await J('GET','/api/stafflog',hq)).j.items;ck('system flags are logged as the server, not as a person',L.filter(x=>/^escalation\.(flagged|cleared)$/.test(x.action)).every(x=>/server/.test(x.by||'')||x.role==='system'),L.filter(x=>/^escalation/.test(x.action)).slice(0,3));
 poll=false;srv.kill();
 // switched off
 const srv2=spawn('node',['geams-server.js'],{env:{...process.env,PORT:'8111',GEAMS_DATA:R+'/d2.json',GEAMS_HQ_USERS:R+'/u2.json',GEAMS_HQ_ADMIN_PASSWORD:'Test-Owner-Pass-1',GEAMS_BACKUP_HOURS:'0',GEAMS_SEED_DEFAULT_STATIONS:'1',GEAMS_ESCALATE_SECS:'0',GEAMS_ESCALATE_TICK_MS:'500'}});await sleep(2500);
 const hq2=(await J('POST','/api/hq/login',null,{username:'hqadmin',password:'Test-Owner-Pass-1'})).j.token;await J('PUT','/api/kv/'+encodeURIComponent('registry:stations'),hq2,{value:{[A]:{id:A,name:'Hohoe',lat:7.15,lng:0.47}}});
 const t2=await lg(A,'hohoe2024');await J('PUT',KA,t2,{value:{E9:rec('E9')}});await sleep(2500);r=await J('GET','/api/escalations',hq2);ck('GEAMS_ESCALATE_SECS=0 switches the watch off',r.s===200&&r.j.open.length===0,r.j);
 srv2.kill();console.log(`\nescalation: ${pass} passed, ${fail} failed`);process.exit(fail?1:0)})().catch(e=>{console.log('ERR',e.stack);process.exit(2)});
