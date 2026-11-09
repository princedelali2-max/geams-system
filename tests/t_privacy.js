const fs=require('fs'),{spawn}=require('child_process');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c?'':'  '+(x||'')))};
const H='GH-VR-HOH-001-P3Q7',B='http://localhost:8094';
const J=async(m,p,t,b)=>{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});let j={};try{j=await r.json()}catch(e){}return{s:r.status,j}};
const kv=(k)=>'/api/kv/'+encodeURIComponent(k);
const desc=(seed,n=0)=>Array.from({length:128},(_,i)=>Math.sin(seed*7.1+i)*0.2+(i===0?n:0));
(async()=>{
 const ROOT='/tmp/gpriv';fs.rmSync(ROOT,{recursive:true,force:true});fs.mkdirSync(ROOT,{recursive:true});
 const srv=spawn('node',['geams-server.js'],{env:{...process.env,PORT:'8094',GEAMS_DATA:ROOT+'/d.json',GEAMS_HQ_USERS:ROOT+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:'Test-Owner-Pass-1',GEAMS_SEED_DEFAULT_STATIONS:'1',GEAMS_BACKUP_HOURS:'0'}});await sleep(2000);
 const hq=(await J('POST','/api/hq/login',null,{username:'hqadmin',password:'Test-Owner-Pass-1'})).j.token;
 await J('PUT',kv('registry:stations'),hq,{value:{[H]:{id:H,name:'Hohoe Control',region:'Volta',town:'Hohoe',lat:7.15,lng:0.47,jurisdictionRadiusM:3000}}});
 const lcr=(await J('POST','/api/lcr/login',null,{stationId:H,passphrase:'hohoe2024'})).j.token;ok('station login',!!lcr);
 const A=(await J('POST','/api/civilian/session',null,{secret:'secretA-'+'a'.repeat(30)})).j.token,Bt=(await J('POST','/api/civilian/session',null,{secret:'secretB-'+'b'.repeat(30)})).j.token;
 // officers
 await J('POST','/api/unit/signup',null,{kind:'officer',password:'pass1234',cred:{name:'Ofc One',phone:'0241111111',lcrId:H,rank:'Sgt'}});
 await J('POST','/api/unit/signup',null,{kind:'officer',password:'pass1234',cred:{name:'Ofc Two',phone:'0242222222',lcrId:H,rank:'Cpl'}});
 const pend=(await J('GET','/api/lcr/pending',lcr)).j.pending;for(const p of pend)await J('POST','/api/lcr/approve',lcr,{kind:'officer',badge:p.badge,approve:true});
 const o1=(await J('POST','/api/unit/login',null,{kind:'officer',name:'Ofc One',password:'pass1234'})).j,o2=(await J('POST','/api/unit/login',null,{kind:'officer',name:'Ofc Two',password:'pass1234'})).j;
 ok('officers signed in',!!o1.token&&!!o2.token,JSON.stringify(o1));
 // A raises an alert
 const IK='lcr:'+H+':incidents';
 let r=await J('PUT',kv(IK),A,{value:{'INC-A1':{id:'INC-A1',status:'new',type:'medical',lat:7.158,lng:0.48,civilianId:'CIV-1001',civilianName:'Alice A',civilianPhone:'0200000001',time:Date.now()}}});
 ok('A can raise an alert',r.s===200,JSON.stringify(r));
 const ga=await J('GET',kv(IK),A),gb=await J('GET',kv(IK),Bt),gl=await J('GET',kv(IK),lcr);
 ok('A sees own alert',ga.j.value&&ga.j.value['INC-A1']);
 ok('A view has no ownerDev',!JSON.stringify(ga.j).includes('ownerDev'));
 ok('B does NOT see A alert',!gb.j.value||!gb.j.value['INC-A1'],JSON.stringify(gb.j).slice(0,200));
 ok('control room sees it',gl.j.value&&gl.j.value['INC-A1']);
 // B tampering
 r=await J('PUT',kv(IK),Bt,{value:{'INC-A1':{id:'INC-A1',status:'cancelled',notes:'hacked'}}});
 ok('B cannot modify A alert',r.s>=400,JSON.stringify(r));
 r=await J('PUT',kv(IK),Bt,{value:{'INC-B1':{id:'INC-B1',status:'new',type:'fire',lat:7.159,lng:0.481,civilianId:'CIV-1002',civilianName:'Bob B',civilianPhone:'0200000002',time:Date.now()}}});
 ok('B can raise own alert',r.s===200,JSON.stringify(r));
 const gl2=(await J('GET',kv(IK),lcr)).j.value||{};ok('B PUT did not erase A alert',!!gl2['INC-A1']&&!!gl2['INC-B1']&&gl2['INC-A1'].status==='new',JSON.stringify(Object.keys(gl2)));
 const ga2=(await J('GET',kv(IK),A)).j.value||{};ok('A still sees only own',!!ga2['INC-A1']&&!ga2['INC-B1']);
 // registries not readable by civilians
 for(const k of ['registry:faces','registry:faceAudit','registry:civilians','registry:officers','registry:stationAuth','registry:unitAuth'])
   {const x=await J('GET',kv(k),A);ok('civilian cannot read '+k,x.s>=400||!x.j.value||Object.keys(x.j.value).length===0,JSON.stringify(x).slice(0,120));}
 const rost=await J('GET',kv('lcr:'+H+':officers'),A);ok('civilian cannot read officer roster',rost.s>=400||!rost.j.value);
 // per-incident keys
 for(const k of ['chat:INC-A1','archive:INC-A1:media','evidence:INC-A1'])
   {const x=await J('GET',kv(k),Bt);ok('B cannot read '+k,x.s>=400||x.j.value==null||(Array.isArray(x.j.value)&&!x.j.value.length),JSON.stringify(x).slice(0,100));}
 {const x=await J('PUT',kv('chat:INC-A1'),Bt,{value:[{from:'x',text:'spy'}]});ok('B cannot write A chat',x.s>=400,JSON.stringify(x));}
 {const x=await J('PUT',kv('chat:INC-A1'),A,{value:[{from:'civilian',text:'help'}]});ok('A can write own chat',x.s===200,JSON.stringify(x));}
 {const x=await J('GET',kv('chat:INC-A1'),A);ok('A can read own chat',x.s===200&&JSON.stringify(x.j).includes('help'));}
 // face enrol
 r=await J('PUT','/api/civilian/profile',A,{id:'CIV-1001',profile:{id:'CIV-1001',name:'Alice A',phone:'0200000001',ghCard:'GHA-111111111-1',address:'Hohoe'}});ok('A saves profile',r.s===200,JSON.stringify(r));
 r=await J('PUT','/api/civilian/profile',Bt,{id:'CIV-1001',profile:{name:'Mallory',phone:'0',ghCard:'x'}});ok('B cannot overwrite A profile',r.s>=400,JSON.stringify(r));
 const dA=desc(1);
 r=await J('POST','/api/face/enrol',A,{civilianId:'CIV-1001',descriptor:dA,faceConsent:true});ok('A enrols face',r.s===200,JSON.stringify(r));
 r=await J('POST','/api/face/enrol',Bt,{civilianId:'CIV-1001',descriptor:desc(9),faceConsent:true});ok('B cannot replace A face',r.s===403,JSON.stringify(r));
 r=await J('POST','/api/face/enrol',A,{civilianId:'CIV-1001',descriptor:[1,2,3],faceConsent:true});ok('bad descriptor refused',r.s===422);
 r=await J('POST','/api/face/remove',Bt,{civilianId:'CIV-1001'});r=await J('POST','/api/face/verify',lcr,{incId:'INC-A1'});ok('B remove did not delete A face',r.j.enrolled===true,JSON.stringify(r));
 // assign INC-A1 to officer one
 const map=(await J('GET',kv(IK),lcr)).j.value;map['INC-A1'].officerName='Ofc One';map['INC-A1'].officerBadge=o1.cred.badge;map['INC-A1'].status='dispatched';
 r=await J('PUT',kv(IK),lcr,{value:map});ok('station assigns officer',r.s===200,JSON.stringify(r));
 // verify
 r=await J('POST','/api/face/verify',o1.token,{incId:'INC-A1'});ok('assigned officer learns enrolled+name only',r.s===200&&r.j.enrolled&&r.j.name==='Alice A'&&!JSON.stringify(r.j).includes('descriptor'),JSON.stringify(r));
 r=await J('POST','/api/face/verify',o1.token,{incId:'INC-A1',descriptor:desc(1,0.05)});ok('same face matches',r.j.match===true&&r.j.distance<0.6,JSON.stringify(r));
 r=await J('POST','/api/face/verify',o1.token,{incId:'INC-A1',descriptor:desc(5,0.9)});ok('different face does not match',r.j.match===false,JSON.stringify(r));
 r=await J('POST','/api/face/verify',o2.token,{incId:'INC-A1',descriptor:dA});ok('unassigned officer refused',r.s===403,JSON.stringify(r));
 r=await J('POST','/api/face/verify',A,{incId:'INC-A1',descriptor:dA});ok('civilian cannot verify',r.s===403);
 r=await J('POST','/api/face/verify',o1.token,{incId:'INC-NOPE',descriptor:dA});ok('unknown incident refused',r.s===403);
 r=await J('POST','/api/face/verify',o1.token,{incId:'INC-A1',descriptor:Array(128).fill(NaN)});ok('NaN descriptor rejected',r.s===422||r.s===400,JSON.stringify(r));
 r=await J('POST','/api/face/search',o1.token,{incId:'INC-A1',descriptor:desc(1,0.02),subject:'Suspect'});ok('search finds enrolled person',r.j.found&&r.j.name==='Alice A'&&!JSON.stringify(r.j).includes('"descriptor"'),JSON.stringify(r));
 r=await J('POST','/api/face/search',o1.token,{incId:'INC-A1',descriptor:desc(6,1.5),subject:'Suspect'});ok('search unknown face -> not found',r.j.found===false,JSON.stringify(r));
 r=await J('POST','/api/face/lookup',o1.token,{incId:'INC-A1',ghCard:'gha-111111111-1'});ok('lookup by Ghana Card',r.j.found&&r.j.name==='Alice A',JSON.stringify(r));
 r=await J('POST','/api/face/lookup',o2.token,{incId:'INC-A1',ghCard:'gha-111111111-1'});ok('unassigned lookup refused',r.s===403);
 r=await J('POST','/api/face/search',lcr,{incId:'INC-A1',descriptor:dA});ok('control room may search on own incident',r.j.found===true,JSON.stringify(r));
 r=await J('POST','/api/face/search',lcr,{incId:'INC-B1',descriptor:dA});ok('control room ok on INC-B1 (its own station)',r.s===200);
 // audit
 r=await J('GET','/api/face/audit',hq);const kinds=(r.j.entries||[]).map(e=>e.what);ok('audit has verify/search/lookup',['verify','search','lookup'].every(k=>kinds.includes(k)),JSON.stringify(kinds));
 ok('audit never holds descriptors',!JSON.stringify(r.j).includes('descriptor'));
 r=await J('GET','/api/face/audit',o1.token);ok('officer cannot read audit',r.s===403);
 // rate limit
 let last;for(let i=0;i<45;i++)last=await J('POST','/api/face/verify',o1.token,{incId:'INC-A1',descriptor:dA});ok('face check rate limited',last.s===429,String(last.s));
 // verify officer
 r=await J('POST','/api/civilian/verify-officer',A,{badge:o1.cred.badge});ok('verify-officer answers (on-duty only)',r.s===200&&typeof r.j.valid==='boolean',JSON.stringify(r));
 r=await J('POST','/api/civilian/verify-officer',A,{badge:'ZZZ'});ok('fake badge invalid',r.j.valid===false);
 r=await J('POST','/api/civilian/verify-officer',null,{badge:'x'});ok('verify-officer needs session',r.s===401);
 // join nearby
 r=await J('POST','/api/civilian/join-nearby',Bt,{station:H,lat:7.158,lng:0.48,radiusM:200,id:'CIV-1002',name:'Bob',phone:'0200000002'});
 ok('B joins nearby incident, gets sanitized view',r.s===200&&r.j.found&&!JSON.stringify(r.j).includes('Alice')&&!JSON.stringify(r.j).includes('0200000001')&&!JSON.stringify(r.j).includes('ownerDev'),JSON.stringify(r).slice(0,300));
 // after joining, B may follow the incident
 const gb2=(await J('GET',kv(IK),Bt)).j.value||{};ok('B can now see the incident they joined',Object.keys(gb2).some(k=>gb2[k].lat===0.48||k==='INC-A1'||k==='INC-B1'));
 // civilian removing own profile removes face
 r=await J('DELETE','/api/civilian/profile',A,{id:'CIV-1001'});ok('delete profile',r.s===200,JSON.stringify(r));
 r=await J('POST','/api/face/verify',lcr,{incId:'INC-A1'});ok('face gone after delete',r.j.enrolled===false,JSON.stringify(r));
 // lockdown still blocks officers not civilians
 await J('POST','/api/hq/lockdown',hq,{on:true,reason:'t'});r=await J('GET',kv(IK),A);ok('civilian still works in lockdown',r.s===200);
 r=await J('PUT',kv(IK),o1.token,{value:{}});ok('officer write refused in lockdown',r.s===503,String(r.s));
 await J('POST','/api/hq/lockdown',hq,{on:false});
 // raw store check
 const raw=fs.existsSync(ROOT+'/d.json')?fs.readFileSync(ROOT+'/d.json','utf8'):'';
 srv.kill();console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
})().catch(e=>{console.log('ERR',e.stack);process.exit(2)});
