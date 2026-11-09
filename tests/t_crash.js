// Crash & failure drill: kill mid-write, damaged data file, disk full, restart recovery.
const fs=require('fs'),{spawn}=require('child_process');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c?'':'  '+String(typeof x==='string'?x:JSON.stringify(x)).slice(0,300)))};
const H='GH-VR-HOH-001-P3Q7',K='lcr:'+H+':incidents',PW='Test-Owner-Pass-1',R='/tmp/gcrash',PORT=8222,B='http://localhost:'+PORT;
fs.rmSync(R,{recursive:true,force:true});fs.mkdirSync(R,{recursive:true});
const env={...process.env,PORT:String(PORT),GEAMS_DATA:R+'/d.json',GEAMS_HQ_USERS:R+'/u.json',GEAMS_BLOBS:R+'/blobs',GEAMS_BACKUP_DIR:R+'/bk',GEAMS_HQ_ADMIN_PASSWORD:PW,GEAMS_SEED_DEFAULT_STATIONS:'1',GEAMS_BACKUP_HOURS:'0',GEAMS_ESCALATE_SECS:'0'};
let srv,log='';const start=async(e)=>{log='';srv=spawn('node',['geams-server.js'],{env:{...env,...e},stdio:['ignore','pipe','pipe']});srv.stdout.on('data',d=>log+=d);srv.stderr.on('data',d=>log+=d);for(let i=0;i<40;i++){await sleep(250);try{if((await fetch(B+'/api/health')).ok)return}catch(x){}}};
const J=async(m,p,t,b)=>{try{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});let j={};try{j=await r.json()}catch(e){}return{s:r.status,j}}catch(e){return{s:0,j:{error:e.message}}}};
const rec=(id)=>({id,type:'medical',priority:'high',status:'new',location:'Market '+id,lat:7.15,lng:0.47,civilianName:'X',createdAt:new Date().toISOString(),source:'walk-in'});
const logins=async()=>({hq:(await J('POST','/api/hq/login',null,{username:'hqadmin',password:PW})).j.token,lcr:(await J('POST','/api/lcr/login',null,{stationId:H,passphrase:'hohoe2024'})).j.token});
const items=async(t)=>(await J('GET','/api/kv/'+encodeURIComponent(K),t)).j.value||{};
(async()=>{
 await start();let {hq,lcr}=await logins();
 // 1. kill -9 during a stream of writes; everything older than the save delay must survive
 let m={};for(let i=0;i<40;i++){m['A'+i]=rec('A'+i);}let r=await J('PUT','/api/kv/'+encodeURIComponent(K),lcr,{value:m});ok('40 alerts written',r.s===200,r);
 await sleep(1500); // let the periodic save happen
 let w=[];for(let i=0;i<30;i++){m=await items(lcr);m['B'+i]=rec('B'+i);w.push(J('PUT','/api/kv/'+encodeURIComponent(K),lcr,{value:m}));await sleep(30);if(i===20)srv.kill('SIGKILL')}
 await Promise.all(w);await sleep(500);
 ok('the data file is still complete JSON after a kill during writes',(()=>{try{JSON.parse(fs.readFileSync(R+'/d.json','utf8'));return true}catch(e){return false}})());
 await start();({hq,lcr}=await logins());let got=await items(lcr);
 ok('after restart all 40 earlier alerts are back',Object.keys(got).filter(k=>k[0]==='A').length===40,Object.keys(got).length);
 ok('no startup damage warning after a clean kill',!/was damaged|Starting EMPTY/i.test(log),log);
 // 2. damaged data file: kept, and the server does NOT silently start empty
 srv.kill('SIGTERM');await sleep(1200);
 fs.copyFileSync(R+'/d.json',R+'/good.json');fs.writeFileSync(R+'/d.json','{"lcr:x":{"value":{');// truncated
 fs.copyFileSync(R+'/good.json',R+'/d.json.tmp');// a complete save copy exists
 await start();({hq,lcr}=await logins());got=await items(lcr);
 ok('damaged file: recovered from the complete save copy',Object.keys(got).filter(k=>k[0]==='A').length===40,Object.keys(got).length);
 ok('damaged file is kept for inspection',fs.readdirSync(R).some(f=>/^d\.json\.corrupt-/.test(f)),fs.readdirSync(R));
 let st=await J('GET','/api/storage/status',hq);ok('HQ is told the file was damaged',!!(st.j.diskSave&&st.j.diskSave.startupNote),st.j);
 srv.kill('SIGTERM');await sleep(1200);
 fs.writeFileSync(R+'/d.json','not json at all');try{fs.unlinkSync(R+'/d.json.tmp')}catch(e){}
 await start();({hq,lcr}=await logins());got=await items(lcr);
 ok('unrecoverable file: starts empty but says so loudly and keeps the damaged file',/Starting EMPTY/.test(log)&&fs.readdirSync(R).filter(f=>/corrupt-/.test(f)).length>=2,log);
 st=await J('GET','/api/storage/status',hq);ok('HQ is told, with the restore command',/restore/.test((st.j.diskSave||{}).startupNote||''),st.j.diskSave);
 // 3. disk full: tmp path cannot be written
 srv.kill('SIGTERM');await sleep(1200);fs.copyFileSync(R+'/good.json',R+'/d.json');
 for(const f of fs.readdirSync(R))if(/corrupt-/.test(f))fs.unlinkSync(R+'/'+f);
 await start();({hq,lcr}=await logins());
 fs.mkdirSync(R+'/d.json.tmp'); // a directory where the temp file must go: every save fails, like a full disk
 r=await J('PUT','/api/kv/'+encodeURIComponent(K),lcr,{value:{...(await items(lcr)),C1:rec('C1')}});ok('the write is still accepted into memory',r.s===200,r);
 await sleep(1500);
 st=await J('GET','/api/storage/status',hq);ok('HQ is told saving is failing',st.j.diskSave&&st.j.diskSave.ok===false&&!!st.j.diskSave.lastError,st.j.diskSave);
 ok('the server logged it loudly',/SAVE FAILED/.test(log),log);
 ok('health says saving is not ok',(await J('GET','/api/health')).j.saving===false);
 ok('the server keeps answering while it cannot save',(await J('GET','/api/kv/'+encodeURIComponent(K),lcr)).s===200);
 fs.rmdirSync(R+'/d.json.tmp'); await sleep(6500);
 st=await J('GET','/api/storage/status',hq);ok('saving recovers by itself when space returns',st.j.diskSave&&st.j.diskSave.ok===true,st.j.diskSave);
 ok('and the alert written during the failure is now on disk',JSON.stringify(JSON.parse(fs.readFileSync(R+'/d.json','utf8'))).includes('"C1"'));
 // 4. clean stop writes everything
 await J('PUT','/api/kv/'+encodeURIComponent(K),lcr,{value:{...(await items(lcr)),D1:rec('D1')}});srv.kill('SIGTERM');await sleep(1500);
 ok('a normal stop saves the very last write',fs.readFileSync(R+'/d.json','utf8').includes('"D1"'));
 console.log(fail?'FAILED '+fail:'passed all '+pass);process.exit(fail?1:0);
})().catch(e=>{console.log('ERR',e);try{srv.kill('SIGKILL')}catch(x){}process.exit(2)});
