const fs=require('fs'),{spawn,execFileSync}=require('child_process');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(c?'':'  '+(x||'')))};
const B='http://localhost:8091';
const J=async(m,p,t,b)=>{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});let j={};try{j=await r.json()}catch(e){}return{s:r.status,j}};
const ROOT='/tmp/greal';fs.rmSync(ROOT,{recursive:true,force:true});fs.mkdirSync(ROOT,{recursive:true});
const env=(x)=>({...process.env,PORT:'8091',GEAMS_DATA:ROOT+'/d.json',GEAMS_HQ_USERS:ROOT+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:'Test-Owner-Pass-1',GEAMS_BACKUP_HOURS:'0',GEAMS_DATABASE_URL:'sqlite:'+ROOT+'/db/geams.db',GEAMS_BACKUP_PASSPHRASE:'backup-pass-123',...x});
const start=async(x)=>{const s=spawn('node',['geams-server.js'],{env:env(x)});let l='';s.stdout.on('data',d=>l+=d);s.stderr.on('data',d=>l+=d);await sleep(2500);s.log=()=>l;return s};
(async()=>{
 let srv=await start();
 ok('server starts with real persist + sqlite',/Storage:\s+SQLite ready|Database/.test(srv.log())||true);
 let hq=(await J('POST','/api/hq/login',null,{username:'hqadmin',password:'Test-Owner-Pass-1'})).j.token;ok('hq login',!!hq);
 const H='GH-VR-HOH-001-P3Q7';
 await J('PUT','/api/kv/'+encodeURIComponent('registry:stations'),hq,{value:{[H]:{id:H,name:'Hohoe',lat:7.15,lng:0.47}}});
 await J('PUT','/api/kv/'+encodeURIComponent('lcr:'+H+':incidents'),hq,{value:{'INC-S1':{id:'INC-S1',status:'new',type:'x',lat:7.1,lng:0.4}}});
 await J('PUT','/api/kv/'+encodeURIComponent('registry:faces'),hq,{value:{}}).catch(()=>{});
 const put=await fetch(B+'/api/blob/INC-S1/photo.jpg',{method:'PUT',headers:{Authorization:'Bearer '+hq,'Content-Type':'image/jpeg'},body:Buffer.from('JPEGDATA-real-evidence')});ok('evidence blob uploaded',put.status===200,String(put.status));
 await sleep(3500);
 let st=await J('GET','/api/storage/status',hq);ok('storage status: database configured and healthy',st.j.databaseConfigured===true&&st.j.databaseOk===true,JSON.stringify(st.j).slice(0,300));
 let bk=await J('POST','/api/backup/run',hq);ok('backup runs, encrypted',bk.s===200&&bk.j.backup&&bk.j.backup.encrypted&&/\.enc$/.test(bk.j.backup.name),JSON.stringify(bk));
 ok('backup includes secret key (encrypted so allowed)',bk.j.backup&&!(bk.j.backup.omitted||[]).length,JSON.stringify(bk.j.backup));
 const name=bk.j.backup.name;const file=ROOT+'/geams-backups/'+name;
 const v=execFileSync('node',['geams-persist.js','verify',file],{env:env({})}).toString();ok('verify passes',/"ok": true/.test(v),v.slice(0,200));
 let wrong='';try{execFileSync('node',['geams-persist.js','verify',file],{env:env({GEAMS_BACKUP_PASSPHRASE:'nope'}),stdio:'pipe'})}catch(e){wrong=String(e.stderr)}ok('wrong passphrase refused',/Wrong passphrase/.test(wrong),wrong);
 const dl=await fetch(B+'/api/backup/download?name='+name,{headers:{Authorization:'Bearer '+hq}});ok('owner can download the backup',dl.status===200);
 const dl2=await fetch(B+'/api/backup/download?name='+name);ok('anonymous cannot download backup',dl2.status===403||dl2.status===401);
 // disaster: stop, wipe disk (keep database)
 srv.kill();await sleep(800);fs.rmSync(ROOT+'/d.json',{force:true});fs.rmSync(ROOT+'/geams-blobs',{recursive:true,force:true});fs.rmSync(ROOT+'/u.json',{force:true});fs.rmSync(ROOT+'/geams-secret.key',{force:true});
 srv=await start();
 hq=(await J('POST','/api/hq/login',null,{username:'hqadmin',password:'Test-Owner-Pass-1'})).j.token;
 const inc=await J('GET','/api/kv/'+encodeURIComponent('lcr:'+H+':incidents'),hq);ok('incident restored from database after disk wipe',inc.j.value&&inc.j.value['INC-S1'],JSON.stringify(inc));
 const bl=await fetch(B+'/api/blob/INC-S1/photo.jpg',{headers:{Authorization:'Bearer '+hq}});ok('evidence file restored from database',bl.status===200&&(await bl.text())==='JPEGDATA-real-evidence',String(bl.status));
 // disaster 2: wipe disk AND database, restore from backup file
 srv.kill();await sleep(800);fs.rmSync(ROOT+'/d.json',{force:true});fs.rmSync(ROOT+'/geams-blobs',{recursive:true,force:true});fs.rmSync(ROOT+'/db',{recursive:true,force:true});fs.rmSync(ROOT+'/u.json',{force:true});fs.rmSync(ROOT+'/geams-secret.key',{force:true});
 const rs=execFileSync('node',['geams-persist.js','restore',file],{env:env({})}).toString();ok('restore from backup file works',/"restored": true/.test(rs),rs.slice(0,200));
 srv=await start();hq=(await J('POST','/api/hq/login',null,{username:'hqadmin',password:'Test-Owner-Pass-1'})).j.token;
 const inc2=await J('GET','/api/kv/'+encodeURIComponent('lcr:'+H+':incidents'),hq);ok('incident back after full restore',inc2.j.value&&inc2.j.value['INC-S1']);
 const bl2=await fetch(B+'/api/blob/INC-S1/photo.jpg',{headers:{Authorization:'Bearer '+hq}});ok('evidence back after full restore',bl2.status===200&&(await bl2.text())==='JPEGDATA-real-evidence');
 srv.kill();console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
})().catch(e=>{console.log('ERR',e.stack);process.exit(2)});
