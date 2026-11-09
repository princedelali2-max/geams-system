const fs=require('fs'),{spawn}=require('child_process');
const PORT=8082,B='http://localhost:'+PORT,sleep=ms=>new Promise(r=>setTimeout(r,ms));let pass=0,fail=0;
const ck=(n,c,x)=>{c?pass++:(fail++,console.log('  FAIL',n,x===undefined?'':JSON.stringify(x)))};
const J=async(m,p,t,b)=>{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});let j={};try{j=await r.json()}catch(e){}return{s:r.status,j}};
(async()=>{
 const R='/tmp/gret';fs.rmSync(R,{recursive:true,force:true});fs.mkdirSync(R,{recursive:true});
 const env={...process.env,PORT:''+PORT,GEAMS_DATA:R+'/d.json',GEAMS_HQ_USERS:R+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:'Test-Owner-Pass-1',GEAMS_SEED_DEFAULT_STATIONS:'1',GEAMS_BACKUP_DIR:R+'/bk',GEAMS_BACKUP_HOURS:'0',GEAMS_ANON_INCIDENT_DAYS:'30',GEAMS_RETAIN_INCIDENT_DAYS:'90',GEAMS_RETAIN_FACEAUDIT_DAYS:'60'};
 const S='GH-VR-HOH-001-P3Q7',key='lcr:'+S+':incidents',day=86400000,now=Date.now();
 const mk=(id,ageD,st,extra)=>({id,status:st,type:'medical',lat:7.15234,lng:0.47891,location:'12 Ho Road',civilianName:'Ama K',civilianPhone:'0200000001',civilianId:'CIV-1',notes:'allergic',createdAt:new Date(now-ageD*day).toISOString(),srv:{received:now-ageD*day},resolvedAt:st==='resolved'?now-ageD*day:undefined,...extra});
 const inc={A:mk('A',10,'resolved'),B:mk('B',45,'resolved'),C:mk('C',120,'resolved'),D:mk('D',200,'new'),E:mk('E',300,'resolved',{legalHold:{by:'x'}}),F:mk('F',150,'resolved')};
 fs.writeFileSync(R+'/d.json',JSON.stringify({[key]:{value:inc,v:1,ts:now},'registry:faceAudit':{value:[{at:now-100*day,what:'verify'},{at:now-5*day,what:'search'}],v:1,ts:now}}));
 const srv=spawn('node',['geams-server.js'],{env});let log='';srv.stdout.on('data',d=>log+=d);srv.stderr.on('data',d=>log+=d);await sleep(2500);
 const hq=(await J('POST','/api/hq/login',null,{username:'hqadmin',password:'Test-Owner-Pass-1'})).j.token;

 await J('PUT','/api/kv/'+encodeURIComponent('chat:C'),hq,{value:[{t:'hello'}]});
 // evidence file for C and F
 for(const id of['C','F']){await fetch(B+'/api/blob/'+id+'/photo.jpg',{method:'PUT',headers:{Authorization:'Bearer '+hq,'Content-Type':'image/jpeg'},body:Buffer.from('JPEGDATA'+id)});}
 const bd=R+'/geams-blobs';ck('evidence files exist',fs.existsSync(bd+'/C/photo.jpg'),fs.existsSync(bd)?fs.readdirSync(bd):'no dir');
 // access control
 const civ=(await J('POST','/api/civilian/session',null,{secret:'retention'+'x'.repeat(20)})).j.token;
 ck('civilian cannot preview',(await J('GET','/api/retention/preview',civ)).s===403);
 ck('civilian cannot run',(await J('POST','/api/retention/run',civ,{confirm:true})).s===403);
 ck('no token cannot hold',(await J('POST','/api/retention/hold',null,{id:'A',on:true})).s===403);
 ck('read keys private',(await J('GET','/api/kv/'+encodeURIComponent('registry:retentionLog'),hq)).s===403);
 // preview changes nothing
 const pv=await J('GET','/api/retention/preview',hq);ck('preview ok',pv.s===200,pv.j);
 ck('preview counts',pv.j.willPurge===2&&pv.j.willAnonymise===1&&pv.j.onLegalHold===1&&pv.j.faceChecksToRemove===1&&pv.j.openIncidentsSkipped===1,pv.j);
 const after=(await J('GET','/api/kv/'+encodeURIComponent(key),hq)).j.value;ck('preview changed nothing',Object.keys(after).length===6&&after.A.civilianName==='Ama K');
 // run needs confirm
 ck('run needs confirm',(await J('POST','/api/retention/run',hq,{})).s===400);
 // hold on F then run
 ck('hold F',(await J('POST','/api/retention/hold',hq,{id:'F',on:true,reason:'court case'})).s===200);
 const pv2=await J('GET','/api/retention/preview',hq);ck('F now held',pv2.j.willPurge===1&&pv2.j.onLegalHold===2,pv2.j);
 const run=await J('POST','/api/retention/run',hq,{confirm:true});ck('run ok',run.s===200&&run.j.ok,run.j);
 ck('made a backup first',!!run.j.backup,run.j);
 ck('result numbers',run.j.result&&run.j.result.purged===1&&run.j.result.anonymised===1&&run.j.result.faceAuditRemoved===1,run.j);
 const m=(await J('GET','/api/kv/'+encodeURIComponent(key),hq)).j.value;
 ck('A (10d) untouched',m.A&&m.A.civilianName==='Ama K');
 ck('B anonymised',m.B&&!m.B.civilianName&&!m.B.civilianPhone&&!m.B.civilianId&&m.B.lat===7.15&&m.B.location==='Location removed'&&m.B.anonymisedAt&&m.B.type==='medical',m.B);
 ck('C purged',!m.C);
 ck('D open kept in full',m.D&&m.D.civilianName==='Ama K');
 ck('E held kept in full',m.E&&m.E.civilianName==='Ama K'&&m.E.legalHold);
 ck('F held kept',m.F&&m.F.civilianName==='Ama K');
 ck('C evidence removed',!fs.existsSync(bd+'/C'));
 ck('F evidence kept',fs.existsSync(bd+'/F/photo.jpg'));
 ck('chat for C cleared',!(await J('GET','/api/kv/'+encodeURIComponent('chat:C'),hq)).j.value||!Array.isArray((await J('GET','/api/kv/'+encodeURIComponent('chat:C'),hq)).j.value));
 const p3=await J('GET','/api/retention/preview',hq);ck('log has the run',p3.j.log.length===1&&p3.j.log[0].result.purged===1,p3.j.log);
 ck('nothing more due',p3.j.willPurge===0&&p3.j.willAnonymise===0,p3.j);
 ck('log has no personal data',!JSON.stringify(p3.j.log).includes('Ama'));
 // release hold -> purge next time
 await J('POST','/api/retention/hold',hq,{id:'F',on:false});const p4=await J('GET','/api/retention/preview',hq);ck('released F is due',p4.j.willPurge===1,p4.j);
 // restart: purged stays purged
 srv.kill();await sleep(800);
 const srv2=spawn('node',['geams-server.js'],{env});await sleep(2500);
 const hq2=(await J('POST','/api/hq/login',null,{username:'hqadmin',password:'Test-Owner-Pass-1'})).j.token;
 const m2=(await J('GET','/api/kv/'+encodeURIComponent(key),hq2)).j.value;ck('after restart C still gone and B still anonymised',m2&&!m2.C&&!m2.B.civilianName,m2&&Object.keys(m2));
 // default policy = keep forever
 srv2.kill();await sleep(800);
 const env3={...env,PORT:'8081',GEAMS_ANON_INCIDENT_DAYS:'',GEAMS_RETAIN_INCIDENT_DAYS:'',GEAMS_RETAIN_FACEAUDIT_DAYS:''};
 const srv3=spawn('node',['geams-server.js'],{env:env3});await sleep(2500);
 const r3=await fetch('http://localhost:8081/api/hq/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'hqadmin',password:'Test-Owner-Pass-1'})});const t3=(await r3.json()).token;
 const pv3=await (await fetch('http://localhost:8081/api/retention/preview',{headers:{Authorization:'Bearer '+t3}})).json();
 ck('default keeps forever',pv3.willPurge===0&&pv3.willAnonymise===0,pv3);
 srv3.kill();
 // ── with a database: purged data must not come back from it at the next start ──
 {
  const R2='/tmp/gret2';fs.rmSync(R2,{recursive:true,force:true});fs.mkdirSync(R2,{recursive:true});
  const e2={...env,PORT:'8081',GEAMS_DATA:R2+'/d.json',GEAMS_HQ_USERS:R2+'/u.json',GEAMS_BACKUP_DIR:R2+'/bk',GEAMS_DATABASE_URL:'sqlite:'+R2+'/g.db',GEAMS_BLOBS:R2+'/blobs'};
  fs.writeFileSync(R2+'/d.json',fs.readFileSync(R+'/d.json'));
  const b2='http://localhost:8081',J2=async(m,p,t,b)=>{const r=await fetch(b2+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});let j={};try{j=await r.json()}catch(e){}return{s:r.status,j}};
  // start from the pristine seeded file (C and B still intact)
  const seed={[key]:{value:inc,v:1,ts:now}};fs.writeFileSync(R2+'/d.json',JSON.stringify(seed));
  let sv=spawn('node',['geams-server.js'],{env:e2});await sleep(3000);
  let t=(await J2('POST','/api/hq/login',null,{username:'hqadmin',password:'Test-Owner-Pass-1'})).j.token;
  await fetch(b2+'/api/blob/C/photo.jpg',{method:'PUT',headers:{Authorization:'Bearer '+t,'Content-Type':'image/jpeg'},body:Buffer.from('JPEGDATAC')});
  await sleep(2500); // let it reach the database
  const rr=await J2('POST','/api/retention/run',t,{confirm:true});ck('db mode run ok',rr.s===200&&rr.j.result.purged===2,rr.j);
  await sleep(2500);sv.kill();await sleep(1500);
  // simulate a restart AND a stale local file by restoring the old one: the database must not undo the purge
  const sv2=spawn('node',['geams-server.js'],{env:e2});await sleep(3500);
  t=(await J2('POST','/api/hq/login',null,{username:'hqadmin',password:'Test-Owner-Pass-1'})).j.token;
  const mm=(await J2('GET','/api/kv/'+encodeURIComponent(key),t)).j.value||{};
  ck('db mode: purged stay gone after restart',!mm.C&&!mm.B.civilianName,Object.keys(mm));
  const f=R2+'/blobs/C/photo.jpg';let txt='';try{txt=fs.readFileSync(f,'utf8')}catch(e){}
  ck('db mode: evidence not restored from database',!txt.includes('JPEGDATA'),txt.slice(0,40));
  sv2.kill();
 }
 console.log(`\nretention: ${pass} passed, ${fail} failed`);process.exit(fail?1:0);
})().catch(e=>{console.log('ERR',e.stack);process.exit(2)});
