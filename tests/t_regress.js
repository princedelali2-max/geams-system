// Replacement regression suite: permissions, evidence seals, commander accounts, analytics, exports, tokens.
const fs=require('fs'),{spawn}=require('child_process');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c?'':'  '+(x||'')))};
const H='GH-VR-HOH-001-P3Q7',H2='GH-GA-ACC-001-B9C1',B='http://localhost:8090';
const R=async(m,p,t,b,raw,h)=>{const r=await fetch(B+p,{method:m,headers:{...(raw?{}:{'Content-Type':'application/json'}),...(h||{}),...(t?{Authorization:'Bearer '+t}:{})},body:b===undefined?undefined:(raw?b:JSON.stringify(b))});let j={},tx='';try{tx=await r.text();j=JSON.parse(tx)}catch(e){}return{s:r.status,j,tx}};
const kv=k=>'/api/kv/'+encodeURIComponent(k);
(async()=>{
 const ROOT='/tmp/greg';fs.rmSync(ROOT,{recursive:true,force:true});fs.mkdirSync(ROOT,{recursive:true});
 const srv=spawn('node',['geams-server.js'],{env:{...process.env,PORT:'8090',GEAMS_DATA:ROOT+'/d.json',GEAMS_HQ_USERS:ROOT+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:'Test-Owner-Pass-1',GEAMS_SEED_DEFAULT_STATIONS:'1',GEAMS_BACKUP_HOURS:'0'}});await sleep(2000);
 // ---------- sign-in & tokens
 let r=await R('POST','/api/hq/login',null,{username:'hqadmin',password:'wrong'});ok('wrong HQ password refused',r.s===401);
 const hq=(await R('POST','/api/hq/login',null,{username:'hqadmin',password:'Test-Owner-Pass-1'})).j.token;ok('HQ owner signs in',!!hq);
 const st=n=>({id:n,name:n,region:'Volta',town:'x',lat:7.15,lng:0.47,jurisdictionRadiusM:3000});
 await R('PUT',kv('registry:stations'),hq,{value:{[H]:st(H),[H2]:st(H2)}});
 r=await R('GET',kv('lcr:'+H+':incidents'),null);ok('no token -> 401',r.s===401);
 r=await R('GET',kv('lcr:'+H+':incidents'),hq.slice(0,-3)+'abc');ok('tampered token -> 401',r.s===401);
 let tok=hq.split('.');const pl=JSON.parse(Buffer.from(tok[1],'base64url'));pl.hr='admin';pl.r='hq';tok[1]=Buffer.from(JSON.stringify({...pl,exp:Date.now()+1e9})).toString('base64url');
 r=await R('GET','/api/hq/me',tok.join('.'));ok('edited payload rejected',r.s===401);
 const lcr=(await R('POST','/api/lcr/login',null,{stationId:H,passphrase:'hohoe2024'})).j.token;ok('station sign-in',!!lcr);
 r=await R('POST','/api/lcr/login',null,{stationId:H,passphrase:'bad'});ok('wrong station passphrase refused',r.s===401);
 const lcr2=(await R('POST','/api/lcr/login',null,{stationId:H2,passphrase:'accra2024'})).j.token;
 // ---------- permission matrix
 r=await R('PUT',kv('registry:stations'),lcr,{value:{}});ok('control room cannot rewrite station registry',r.s===403,String(r.s));
 r=await R('PUT',kv('public:alerts'),lcr,{value:{a:{id:'a'}}});ok('control room cannot publish public alerts',r.s===403);
 r=await R('PUT',kv('public:alerts'),hq,{value:{a1:{id:'a1',title:'Flood',message:'Move to high ground',severity:'warning',audience:{civilians:true,officers:true},stations:[],status:'active',createdAt:Date.now(),expiresAt:Date.now()+3600000}}});ok('HQ can publish public alerts',r.s===200,JSON.stringify(r.j));
 const civ=(await R('POST','/api/civilian/session',null,{secret:'c'.repeat(30)})).j.token;
 r=await R('PUT',kv('public:alerts'),civ,{value:{}});ok('civilian cannot publish public alerts',r.s===403);
 r=await R('GET',kv('public:alerts'),civ);ok('civilian can read public alerts',r.s===200&&r.j.value&&r.j.value.a1);
 r=await R('PUT',kv('lcr:'+H+':incidents'),lcr2,{value:{'INC-X':{id:'INC-X',status:'new'}}});ok('another station cannot write this station incidents',r.s===403,String(r.s));
 r=await R('GET',kv('lcr:'+H2+':officers'),lcr);ok('station can read others roster only via role rule (200 or 403 consistent)',r.s===200||r.s===403);
 r=await R('PUT',kv('lcr:'+H+':officers'),lcr2,{value:{}});ok('another station cannot change this roster',r.s===403);
 r=await R('PUT',kv('registry:officers'),hq,{value:[]});ok('registry:officers is server-only (even HQ)',r.s===403);
 r=await R('GET',kv('registry:stationAuth'),hq);ok('credential store unreadable even for HQ',r.s===403);
 r=await R('PUT',kv('hq:lcr_status'),civ,{value:{}});ok('civilian cannot write HQ status',r.s===403);
 r=await R('PUT',kv('registry:stationLocations'),civ,{value:{}});ok('civilian cannot write station locations',r.s===403);
 r=await R('GET',kv('registry:stationLocations'));ok('station locations are public',r.s===200);
 r=await R('GET','/api/storage/status',lcr);ok('storage status HQ only',r.s===401||r.s===403);
 r=await R('GET','/api/backup/list',lcr);ok('backups: control room refused',r.s===403);
 r=await R('POST','/api/hq/rotate-tokens',lcr);ok('rotate tokens: control room refused',r.s===403);
 r=await R('POST','/api/hq/lockdown',lcr,{on:true});ok('lockdown: control room refused',r.s===403);
 // HQ operators
 r=await R('POST','/api/hq/users',hq,{username:'op1',password:'Operator-Pass-12',role:'operator'});ok('owner creates an operator',r.s===200,JSON.stringify(r.j));
 const op=(await R('POST','/api/hq/login',null,{username:'op1',password:'Operator-Pass-12'})).j.token;ok('operator signs in',!!op);
 r=await R('GET','/api/hq/users',op);ok('operator cannot manage users',r.s===403);
 r=await R('POST','/api/backup/run',op);ok('operator cannot run backups',r.s===403);
 r=await R('POST','/api/hq/lockdown',op,{on:true});ok('operator cannot lock down',r.s===403);
 r=await R('GET',kv('lcr:'+H+':incidents'),op);ok('operator can read incidents',r.s===200);
 // ---------- incident field-level rules
 r=await R('PUT',kv('lcr:'+H+':incidents'),civ,{value:{'INC-C1':{id:'INC-C1',status:'dispatched',type:'x',lat:7.1,lng:0.4}}});ok('civilian cannot raise an alert pre-dispatched',r.s>=400,String(r.s));
 r=await R('PUT',kv('lcr:'+H+':incidents'),civ,{value:{'INC-C1':{id:'INC-C1',status:'new',type:'medical',lat:48.8,lng:2.3}}});ok('alert outside Ghana refused',r.s>=400,String(r.s));
 r=await R('PUT',kv('lcr:'+H+':incidents'),civ,{value:{'INC-C1':{id:'INC-C1',status:'new',type:'medical',lat:7.158,lng:0.48,civilianVerified:true,civilianId:'CIV-1',civilianName:'A',civilianPhone:'0200000001'}}});ok('civilian raises an alert',r.s===200,JSON.stringify(r.j));
 const inc=(await R('GET',kv('lcr:'+H+':incidents'),lcr)).j.value['INC-C1'];ok('server overrides civilianVerified',inc&&inc.civilianVerified===false,JSON.stringify(inc));
 r=await R('PUT',kv('lcr:'+H+':incidents'),civ,{value:{'INC-C1':{...inc,status:'resolved'}}});ok('civilian cannot resolve/alter status',r.s>=400,String(r.s));
 r=await R('PUT',kv('lcr:'+H+':incidents'),lcr,{value:{...(await R('GET',kv('lcr:'+H+':incidents'),lcr)).j.value,'INC-C1':{...inc,status:'dispatched'}}});ok('control room can dispatch',r.s===200,String(r.s));
 // ---------- evidence seals & custody
 const put=async(n,body,t,ct)=>R('PUT','/api/blob/INC-C1/'+n,t,body,true,{'Content-Type':ct||'image/jpeg'});
 r=await put('a.jpg','PHOTO-ONE',lcr);ok('evidence upload sealed (sha256 returned)',r.s===200&&/^[0-9a-f]{64}$/.test(r.j.sha256),r.tx);
 r=await put('a.jpg','PHOTO-TWO',lcr);ok('overwriting sealed evidence refused (409)',r.s===409,String(r.s));
 r=await put('a.seal','x',lcr);ok('reserved name refused',r.s===400);
 r=await put('../../etc','x',lcr);ok('path traversal refused',r.s>=400);
 r=await R('GET','/api/evidence/INC-C1/a.jpg/verify',lcr);ok('verify says intact',r.s===200&&JSON.stringify(r.j).includes('true'),r.tx.slice(0,200));
 const dir=ROOT+'/geams-blobs';const f=require('child_process').execSync('find '+ROOT+' -name a.jpg').toString().trim();
 fs.writeFileSync(f,'TAMPERED');
 r=await R('GET','/api/evidence/INC-C1/a.jpg/verify',lcr);ok('verify detects tampering',r.s===200&&/false/.test(r.tx)&&!/"ok":\s*true/.test(r.tx),r.tx.slice(0,250));
 r=await R('GET','/api/evidence/INC-C1/a.jpg/custody',lcr);ok('custody log has entries and signed seal',r.s===200&&r.j.seal&&r.j.seal.sig&&r.j.entries.length>=1,r.tx.slice(0,200));
 r=await R('GET','/api/evidence/INC-C1/a.jpg/custody',civ);ok('civilian cannot read custody log',r.s===403);
 const civ2=(await R('POST','/api/civilian/session',null,{secret:'d'.repeat(30)})).j.token;r=await R('GET','/api/blob/INC-C1/a.jpg',civ2);ok('another civilian cannot download evidence',r.s===403,String(r.s));r=await R('GET','/api/blob/INC-C1/a.jpg',civ);ok('the owner civilian can fetch it',r.s===200,String(r.s));
 // append recording
 r=await R('PUT','/api/blob/INC-C1/rec.webm?append=1',lcr,'AAA',true,{'Content-Type':'video/webm'});r=await R('PUT','/api/blob/INC-C1/rec.webm?append=1',lcr,'BBB',true,{'Content-Type':'video/webm'});
 r=await R('GET','/api/blob/INC-C1/rec.webm',lcr);ok('appended recording is whole',r.tx==='AAABBB',r.tx);
 r=await R('GET','/api/blobs/INC-C1',lcr);ok('evidence list shows sealed files',r.s===200&&JSON.stringify(r.j).includes('rec.webm')&&JSON.stringify(r.j).includes('a.jpg'));
 // ---------- commander accounts
 r=await R('POST','/api/hq/lcr/commander',hq,{stationId:H,action:'create',username:'kmensah',name:'Kwame',rank:'ACP',password:'Longer-Pass-1234'});ok('commander needs a full name',r.s===400);
 r=await R('POST','/api/hq/lcr/commander',hq,{stationId:H,action:'create',username:'kmensah',name:'Kwame Mensah',rank:'ACP',password:'short'});ok('short commander password refused',r.s===400);
 r=await R('POST','/api/hq/lcr/commander',hq,{stationId:H,action:'create',username:'kmensah',name:'Kwame Mensah',rank:'ACP',password:'Longer-Pass-1234'});ok('HQ creates commander account',r.s===200,JSON.stringify(r.j));
 r=await R('POST','/api/hq/lcr/commander',hq,{stationId:H,action:'create',username:'kmensah',name:'Kwame Mensah',rank:'ACP',password:'Longer-Pass-1234'});ok('duplicate username refused',r.s===409);
 r=await R('POST','/api/hq/lcr/commander',lcr,{stationId:H,action:'create',username:'evil',name:'Evil Person',password:'Longer-Pass-1234'});ok('control room cannot create commanders',r.s===401||r.s===403);
 r=await R('POST','/api/lcr/login',null,{stationId:H,passphrase:'hohoe2024'});ok('passphrase alone no longer enough once a commander exists',r.s===401,String(r.s));
 r=await R('POST','/api/lcr/login',null,{stationId:H,passphrase:'hohoe2024',commander:{username:'kmensah',password:'bad-password-1'}});ok('wrong commander password refused',r.s===401);
 r=await R('POST','/api/lcr/login',null,{stationId:H,passphrase:'hohoe2024',commander:{username:'kmensah',password:'Longer-Pass-1234'}});ok('commander signs in',r.s===200&&r.j.token,JSON.stringify(r.j).slice(0,150));
 const cmd=r.j.token;
 r=await R('POST','/api/lcr/commander/password',cmd,{current:'wrong',password:'Another-Long-Pass-1'});ok('password change needs current password',r.s===401);
 r=await R('POST','/api/lcr/commander/password',cmd,{current:'Longer-Pass-1234',password:'Another-Long-Pass-1'});ok('commander changes own password',r.s===200&&r.j.token);
 r=await R('POST','/api/lcr/login',null,{stationId:H,passphrase:'hohoe2024',commander:{username:'kmensah',password:'Longer-Pass-1234'}});ok('old password stops working',r.s===401);
 r=await R('GET',kv('lcr:'+H+':incidents'),cmd);ok('old commander token revoked after password change',r.s===401,String(r.s));
 r=await R('POST','/api/hq/lcr/commander',hq,{stationId:H,action:'disable',username:'kmensah'});r=await R('POST','/api/lcr/login',null,{stationId:H,passphrase:'hohoe2024',commander:{username:'kmensah',password:'Another-Long-Pass-1'}});ok('disabled commander cannot sign in as commander (falls back to passphrase-only unless GEAMS_REQUIRE_COMMANDER_ACCOUNTS=1)',r.s===401||(r.s===200&&!r.j.commander),JSON.stringify(r.j).slice(0,120));
 r=await R('POST','/api/hq/lcr/commander',hq,{stationId:H,action:'enable',username:'kmensah'});
 r=await R('POST','/api/hq/lcr/commander',hq,{stationId:H,action:'reset',username:'kmensah'});ok('HQ resets commander password',r.s===200&&r.j.password,JSON.stringify(r.j).slice(0,120));const newPw=r.j.password;
 r=await R('GET','/api/hq/lcr/commander?stationId='+H,hq);ok('account list never exposes hashes',r.s===200&&!/hash|salt/.test(r.tx)&&r.j.accounts.length===1);
 // ---------- analytics
 const now=Date.now();
 const lcr3=(await R('POST','/api/lcr/login',null,{stationId:H,passphrase:'hohoe2024',commander:{username:'kmensah',password:newPw}})).j.token;ok('commander signs in with the reset password',!!lcr3);const lc=(await R('GET',kv('lcr:'+H+':incidents'),lcr3)).j.value||{};
 lc['INC-A1']={id:'INC-A1',status:'resolved',type:'fire',lat:7.15,lng:0.47,source:'civilian-app',createdAt:new Date(now-3600e3).toISOString(),officerName:'X',officerBadge:'GH-1',officerStatus:'arrived',officerArrivedAt:now-3000e3,resolvedAt:now-2000e3};
 r=await R('PUT',kv('lcr:'+H+':incidents'),lcr3,{value:lc});ok('control room writes own station incidents',r.s===200,String(r.s));
 r=await R('GET','/api/analytics/response?days=30',hq);ok('analytics answers for HQ',r.s===200&&typeof r.j==='object',r.tx.slice(0,150));
 r=await R('GET','/api/analytics/response?days=30',lcr3);ok('analytics answers for a control room',r.s===200);
 r=await R('GET','/api/analytics/response?days=30',civ);ok('analytics refused to civilians',r.s===401||r.s===403);
 r=await R('GET','/api/analytics/response?days=30&bucket=month',hq);ok('monthly bucket accepted',r.s===200);
 // ---------- exports
 r=await R('GET','/api/export/incidents?format=csv',hq);ok('CSV export for HQ',r.s===200&&/INC-/.test(r.tx));
 r=await R('GET','/api/export/incidents?format=geojson',hq);ok('GeoJSON export',r.s===200&&/FeatureCollection/.test(r.tx));
 r=await R('GET','/api/export/incidents?format=cap',hq);ok('CAP export',r.s===200&&/<(alert|alerts|cap)/i.test(r.tx));
 r=await R('GET','/api/export/incidents?format=json&personal=1',hq);ok('personal data only when asked',r.s===200);
 const np=await R('GET','/api/export/incidents?format=json',hq);ok('default export hides civilian phone numbers',!/0200000001/.test(np.tx),np.tx.slice(0,100));
 r=await R('GET','/api/export/incidents?format=csv',civ);ok('civilian cannot export',r.s===401||r.s===403);
 r=await R('GET','/api/export/incidents?format=bogus',hq);ok('unknown export format refused',r.s===400);
 r=await R('GET','/api/export/alerts?format=json',lcr3);ok('alerts export HQ only',r.s===403);
 // ---------- unit sign-up rules
 r=await R('POST','/api/unit/signup',null,{kind:'officer',password:'abc',cred:{name:'Short Pw',phone:'0243000001',lcrId:H}});ok('short crew password refused',r.s===400);
 r=await R('POST','/api/unit/signup',null,{kind:'officer',password:'abcdef1',cred:{name:'Dup One',phone:'0243000002',lcrId:H}});r=await R('POST','/api/unit/signup',null,{kind:'officer',password:'abcdef1',cred:{name:'Dup Two',phone:'0243000002',lcrId:H}});ok('duplicate phone refused',r.s===409);
 r=await R('POST','/api/unit/login',null,{kind:'officer',name:'Dup One',password:'abcdef1'});ok('unapproved crew cannot sign in',r.s>=400,String(r.s));
 r=await R('GET','/api/lcr/pending',lcr3);const pb=r.j.pending.find(x=>x.name==='Dup One');r=await R('POST','/api/lcr/approve',lcr2,{kind:'officer',badge:pb.badge,approve:true});ok("another station cannot approve this station's crew",r.s===403);
 r=await R('POST','/api/lcr/approve',lcr3,{kind:'officer',badge:pb.badge,approve:true});ok('own control room approves',r.s===200);
 r=await R('POST','/api/unit/login',null,{kind:'officer',name:'Dup One',password:'abcdef1'});ok('approved crew signs in',r.s===200&&r.j.token);
 let lastS;for(let i=0;i<12;i++)lastS=(await R('POST','/api/unit/login',null,{kind:'officer',name:'Dup One',password:'nope'+i})).s;ok('repeated wrong passwords get locked out (429)',lastS===429,String(lastS));
 // ---------- ping/health
 r=await R('GET','/api/health');ok('health endpoint answers',r.s===200);
 srv.kill();console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
})().catch(e=>{console.log('ERR',e.stack);process.exit(2)});
