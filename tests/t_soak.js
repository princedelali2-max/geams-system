// Soak: steady mixed load for DURATION_MIN minutes (default 4) with a hard kill + restart every RESTART_MIN (default 1).
// Reports memory trend, latency, errors and data loss. For a real 24 h soak run:  DURATION_MIN=1440 node t_soak.js
const fs=require('fs'),{spawn}=require('child_process');const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const DUR=parseFloat(process.env.DURATION_MIN||'4')*60000,RST=parseFloat(process.env.RESTART_MIN||'1')*60000,PORT=8223,B='http://localhost:'+PORT,R='/tmp/gsoak';
const H='GH-VR-HOH-001-P3Q7',K='lcr:'+H+':incidents',PW='Test-Owner-Pass-1';
fs.rmSync(R,{recursive:true,force:true});fs.mkdirSync(R,{recursive:true});
const env={...process.env,PORT:String(PORT),GEAMS_DATA:R+'/d.json',GEAMS_HQ_USERS:R+'/u.json',GEAMS_BLOBS:R+'/blobs',GEAMS_BACKUP_DIR:R+'/bk',GEAMS_HQ_ADMIN_PASSWORD:PW,GEAMS_SEED_DEFAULT_STATIONS:'1',GEAMS_BACKUP_HOURS:'0',GEAMS_ESCALATE_SECS:'120'};
let srv,pid=0;const start=async()=>{srv=spawn('node',['geams-server.js'],{env,stdio:'ignore'});pid=srv.pid;for(let i=0;i<60;i++){await sleep(250);try{if((await fetch(B+'/api/health')).ok)return}catch(x){}}};
const rss=()=>{try{return parseInt(fs.readFileSync('/proc/'+pid+'/status','utf8').match(/VmRSS:\s+(\d+)/)[1])/1024}catch(e){return 0}};
let lat=[],errs=0,reqs=0,down=false;
const J=async(m,p,t,b)=>{const t0=Date.now();try{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});let j={};try{j=await r.json()}catch(e){}reqs++;if(!down)lat.push(Date.now()-t0);if(r.status>=500)errs++;return{s:r.status,j}}catch(e){if(!down)errs++;return{s:0,j:{}}}};
const rec=(id)=>({id,type:'medical',priority:'high',status:'new',location:'Market '+id,lat:7.15,lng:0.47,civilianName:'X',createdAt:new Date().toISOString(),source:'walk-in'});
(async()=>{
 await start();const lg=async()=>(await J('POST','/api/lcr/login',null,{stationId:H,passphrase:'hohoe2024'})).j.token;let lcr=await lg();
 const acked=new Set();let n=0,stop=false;
 const worker=async()=>{while(!stop){if(down){await sleep(200);continue}
   const cur=(await J('GET','/api/kv/'+encodeURIComponent(K),lcr)).j.value||{};
   if(Math.random()<.3){const id='S'+(++n)+'_'+Math.random().toString(36).slice(2,6);const r=await J('PUT','/api/kv/'+encodeURIComponent(K),lcr,{value:{...cur,[id]:rec(id)}});if(r.s===200)acked.add(id)}
   await J('GET','/api/health');await sleep(150+Math.random()*250)}};
 const ws=[...Array(8)].map(worker);
 const t0=Date.now(),samples=[],cycleAt=[];let nextR=t0+RST,restarts=0,lostTotal=0;
 while(Date.now()-t0<DUR){await sleep(5000);samples.push([Math.round((Date.now()-t0)/1000),Math.round(rss())]);
  if(Date.now()>=nextR){nextR+=RST;down=true;const before=Object.keys((await J('GET','/api/kv/'+encodeURIComponent(K),lcr)).j.value||{}).length;await sleep(1200);// let the save delay pass
   srv.kill('SIGKILL');await sleep(500);await start();lcr=await lg();restarts++;down=false;
   const after=Object.keys((await J('GET','/api/kv/'+encodeURIComponent(K),lcr)).j.value||{}).length;const lost=Math.max(0,before-after);lostTotal+=lost;console.log('restart',restarts,'records before',before,'after',after,'lost',lost);}}
 stop=true;await Promise.all(ws);
 lat.sort((a,b)=>a-b);const p=q=>lat[Math.floor(lat.length*q)]||0;
 const half=samples.slice(Math.floor(samples.length/2)),first=half[0][1],last=half[half.length-1][1];
 const size=fs.statSync(R+'/d.json').size;
 console.log(JSON.stringify({minutes:DUR/60000,requests:reqs,errors5xx_or_network:errs,p50ms:p(.5),p95ms:p(.95),p99ms:p(.99),restarts,recordsLostAfterKill:lostTotal,rssMB_samples:samples.filter((x,i)=>i%Math.ceil(samples.length/10)===0).map(x=>x[1]),rss_second_half_growthMB:last-first,dataFileKB:Math.round(size/1024)}));
 const ok=errs===0&&lostTotal===0&&p(.95)<1500&&(last-first)<60;console.log(ok?'SOAK OK':'SOAK PROBLEM');srv.kill('SIGTERM');process.exit(ok?0:1);
})().catch(e=>{console.log('ERR',e);process.exit(2)});
