// Automated security probes against a running server. Not a penetration test: it checks the things we know to check.
const fs=require('fs'),{spawn}=require('child_process'),http=require('http');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ck=(n,c,x)=>{c?pass++:(fail++,console.log('  FAIL',n,x===undefined?'':String(typeof x==='string'?x:JSON.stringify(x)).slice(0,300)))};
const B='http://localhost:8074';
const raw=(m,p,{t,body,headers}={})=>new Promise(res=>{const d=body==null?null:(typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body));const r=http.request(B+p,{method:m,headers:{...(d!=null?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(d)}:{}),...(t?{Authorization:'Bearer '+t}:{}),...headers}},rs=>{let s='';rs.on('data',c=>s+=c);rs.on('end',()=>res({s:rs.statusCode,h:rs.headers,t:s}))});r.on('error',e=>res({s:0,t:String(e)}));if(d!=null)r.write(d);r.end()});
const J=async(...a)=>{const r=await raw(...a);let j={};try{j=JSON.parse(r.t)}catch(e){}return{...r,j}};
(async()=>{
 const R='/tmp/gsec';fs.rmSync(R,{recursive:true,force:true});fs.mkdirSync(R,{recursive:true});
 const env={...process.env,PORT:'8074',GEAMS_DATA:R+'/d.json',GEAMS_HQ_USERS:R+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:'Test-Owner-Pass-1',GEAMS_SEED_DEFAULT_STATIONS:'1',GEAMS_BACKUP_HOURS:'0',GEAMS_ALLOWED_ORIGIN:'https://geams.example.gov.gh'};
 let srv=spawn('node',['geams-server.js'],{env});let log='';srv.stdout.on('data',d=>log+=d);srv.stderr.on('data',d=>log+=d);await sleep(2500);
 const H='GH-VR-HOH-001-P3Q7',K=k=>'/api/kv/'+encodeURIComponent(k);
 const hq=(await J('POST','/api/hq/login',{body:{username:'hqadmin',password:'Test-Owner-Pass-1'}})).j.token;
 await J('PUT',K('registry:stations'),{t:hq,body:{value:{[H]:{id:H,name:'Hohoe',region:'V',town:'x',lat:7.15,lng:0.47,jurisdictionRadiusM:3000}}}});
 // 1 headers
 let r=await raw('GET','/api/health');
 ck('nosniff header',r.h['x-content-type-options']==='nosniff',r.h);ck('framing blocked',r.h['x-frame-options']==='SAMEORIGIN');ck('referrer policy',r.h['referrer-policy']==='no-referrer');ck('permissions policy',/camera=\(self\)/.test(r.h['permissions-policy']||''));
 r=await raw('GET','/api/health',{headers:{'X-Forwarded-Proto':'https'}});ck('HSTS only over https',!!r.h['strict-transport-security']);
 r=await raw('GET','/api/health');ck('no HSTS over plain http',!r.h['strict-transport-security']);
 // 2 CORS
 r=await raw('GET','/api/health',{headers:{Origin:'https://evil.example'}});ck('foreign origin not allowed',r.h['access-control-allow-origin']===undefined,r.h['access-control-allow-origin']);
 r=await raw('GET','/api/health',{headers:{Origin:'https://geams.example.gov.gh'}});ck('listed origin allowed',r.h['access-control-allow-origin']==='https://geams.example.gov.gh');
 // 3 no token
 for(const k of ['lcr:'+H+':incidents','lcr:'+H+':officers','lcr:'+H+':intel','chat:INC-1','evidence:INC-1','registry:officers','registry:civilians','hq:smsInbox','backup:x']){r=await raw('GET',K(k));ck('anonymous cannot read '+k,r.s===401||r.s===403,r.s);}
 for(const k of ['lcr:'+H+':incidents','public:alerts','registry:stations','hq:lockdown']){r=await raw('PUT',K(k),{body:{value:{}}});ck('anonymous cannot write '+k,r.s===401||r.s===403,r.s);}
 r=await raw('DELETE',K('lcr:'+H+':incidents'));ck('anonymous cannot delete',r.s===401||r.s===403,r.s);
 // 4 server-only keys even for HQ
 for(const k of ['registry:stationAuth','registry:unitAuth','registry:faces','registry:faceAudit','registry:civRecovery','registry:commanderAuth','registry:authEpoch','registry:consents','registry:feedback','registry:retentionLog','registry:pushSubs']){r=await raw('GET',K(k),{t:hq});ck('HQ cannot read raw '+k,r.s===403,r.s);r=await raw('PUT',K(k),{t:hq,body:{value:{x:1}}});ck('HQ cannot overwrite raw '+k,r.s===403,r.s);}
 // 5 tokens
 const civ=(await J('POST','/api/civilian/session',{body:{secret:'sec'+'x'.repeat(20)}})).j.token;
 const parts=hq.split('.');const pl=JSON.parse(Buffer.from(parts[1],'base64url').toString());
 const forged=(o,sig)=>parts[0]+'.'+Buffer.from(JSON.stringify(o)).toString('base64url')+'.'+(sig||parts[2]);
 r=await raw('GET','/api/hq/users',{t:forged({...pl,hr:'admin',u:'other'})});ck('edited token payload refused',r.s===401||r.s===403,r.s);
 r=await raw('GET',K('hq:smsInbox'),{t:forged({...pl,r:'hq'},'AAAA')});ck('bad signature refused',r.s===401,r.s);
 const cp=civ.split('.'),cpl=JSON.parse(Buffer.from(cp[1],'base64url').toString());
 r=await raw('GET',K('hq:smsInbox'),{t:cp[0]+'.'+Buffer.from(JSON.stringify({...cpl,r:'hq'})).toString('base64url')+'.'+cp[2]});ck('civilian cannot promote own token to HQ',r.s===401,r.s);
 r=await raw('GET',K('hq:smsInbox'),{t:forged({...pl,exp:1})});ck('expired token refused',r.s===401,r.s);
 r=await raw('GET',K('hq:smsInbox'),{t:'v1.e30.e30'});ck('junk token refused',r.s===401);
 r=await raw('GET',K('hq:smsInbox'),{t:'Bearer'});ck('garbage header refused',r.s===401);
 // 6 civilian cannot do staff things
 for(const [m,p,b] of [['POST','/api/hq/rotate-tokens',{}],['POST','/api/hq/lockdown',{on:true}],['GET','/api/security/check'],['POST','/api/retention/run',{confirm:true}],['GET','/api/retention/preview'],['GET','/api/feedback'],['GET','/api/face/audit'],['POST','/api/face/search',{incId:'x',descriptor:[]}],['GET','/api/analytics/response'],['GET','/api/export/incidents'],['POST','/api/lcr/approve',{}],['GET','/api/lcr/pending']]){r=await raw(m,p,{t:civ,body:b});ck('civilian refused: '+m+' '+p,r.s===401||r.s===403||r.s===405,r.s);}
 // 7 file exposure and traversal
 for(const p of ['/geams-server.js','/geams-persist.js','/geams-data.json','/d.json','/geams-secret.key','/geams-vapid.json','/geams-hq-users.json','/u.json','/../geams-server.js','/%2e%2e/geams-server.js','/..%2fgeams-server.js','/vendor/../geams-server.js','/geams-backups/','/geams-blobs/','/.env','/node_modules/','/tests/../geams-server.js','/%00','/api/blob/..%2f..%2fd.json/x','/api/blob/../../d.json']){r=await raw('GET',p,{t:hq});ck('not served: '+p,!/GEAMS_HQ_ADMIN|createHmac|"registry:/.test(r.t)&&r.s!==200||r.s===200&&/<html/i.test(r.t)&&!/createHmac/.test(r.t),[r.s,r.t.slice(0,60)]);}
 r=await raw('GET','/vendor/');ck('no directory listing',!/<a href|Index of/i.test(r.t),r.t.slice(0,100));
 // 8 bad input
 r=await raw('POST','/api/hq/login',{body:'{not json'});ck('malformed JSON is a clean 4xx',r.s>=400&&r.s<500&&!/at .*\.js|node:|Error:/.test(r.t),[r.s,r.t.slice(0,100)]);
 r=await raw('PUT',K('lcr:'+H+':incidents'),{t:hq,body:Buffer.alloc(3*1024*1024,'a')});ck('oversized body refused',r.s===0||r.s>=400,r.s);
 r=await raw('GET','/api/health');ck('server still alive after oversized body',r.s===200);
 for(const k of ['__proto__','constructor','prototype','a/../b','x'.repeat(400)]){r=await raw('PUT',K(k),{t:hq,body:{value:{polluted:true}}});ck('odd key handled: '+k.slice(0,12),r.s<500,r.s);}
 r=await raw('GET','/api/health');ck('no prototype pollution',r.s===200&&({}).polluted===undefined&&!JSON.stringify(Object.getPrototypeOf({})).includes('polluted'));
 const pol=await J('GET',K('nonexistent-key-zzz'),{t:hq});ck('fresh key is not inheriting a polluted value',!(pol.j.value&&pol.j.value.polluted),pol.j);
 r=await raw('PUT',K('lcr:'+H+':incidents'),{t:hq,body:{value:'a string'}});ck('wrong data type refused',r.s>=400&&r.s<500,r.s);
 r=await raw('PUT',K('lcr:'+H+':incidents'),{t:hq,body:{value:{X:{id:'X',type:'<img src=x onerror=alert(1)>',status:'new'}}}});ck('script text accepted as plain data (the apps escape on display)',r.s===200,r.s);
 // 9 brute force
 let got429=false;for(let i=0;i<25;i++){const x=await raw('POST','/api/hq/login',{body:{username:'hqadmin',password:'wrong'+i}});if(x.s===429){got429=true;break;}}ck('repeated wrong HQ passwords get rate limited',got429);
 got429=false;for(let i=0;i<25;i++){const x=await raw('POST','/api/lcr/login',{body:{stationId:H,passphrase:'wrong'+i}});if(x.s===429){got429=true;break;}}ck('repeated wrong station passphrases get rate limited',got429);
 // alert flooding from one phone
 {const fl=(await J('POST','/api/civilian/session',{body:{secret:'flood'+'y'.repeat(20)}})).j.token;let blocked=0,okc=0;for(let i=0;i<14;i++){const q=await raw('PUT',K('lcr:'+H+':incidents'),{t:fl,body:{value:{['FL'+i]:{id:'FL'+i,type:'medical',priority:'high',status:'new',location:'x',lat:7.15,lng:0.47,civilianName:'F',createdAt:new Date().toISOString(),source:'civilian-app'}}}});if(q.s===200)okc++;else blocked++;}ck('one phone cannot flood alerts (10 per hour)',okc===10&&blocked===4,[okc,blocked]);}
 // 10 live event stream carries no data
 const ev=await new Promise(res=>{const got=[];const q=http.get(B+'/api/events',rs=>{rs.on('data',c=>got.push(String(c)));setTimeout(async()=>{const w=await raw('PUT',K('backup:probe'),{t:hq,body:{value:{secret:'SHOULD-NOT-LEAK-12345'}}});got.push('[put '+w.s+' '+w.t.slice(0,80)+']');setTimeout(()=>{q.destroy();res(got.join(''))},800)},400)});q.on('error',()=>res(''))});
 ck('event stream announces key and version only',/backup:probe/.test(ev)&&!/SHOULD-NOT-LEAK/.test(ev),ev.slice(0,200));
 // 11 uploads
 r=await raw('PUT','/api/blob/INC-1/..%2f..%2fevil.txt',{t:hq,body:'x',headers:{'Content-Type':'text/plain'}});ck('upload cannot escape its folder',!fs.existsSync(R+'/evil.txt')&&!fs.existsSync('/tmp/evil.txt'),r.s);
 r=await raw('GET','/api/blob/INC-1/nothing.bin');ck('evidence needs sign-in',r.s===401||r.s===403,r.s);
 // 12 logs do not hold secrets
 ck('server log has no passwords or tokens',!/Test-Owner-Pass-1|v1\.ey/.test(log),log.slice(0,200));
 srv.kill();
 console.log(`\nsecurity probes: ${pass} passed, ${fail} failed`);process.exit(fail?1:0);
})().catch(e=>{console.log('ERR',e.stack);process.exit(2)});
