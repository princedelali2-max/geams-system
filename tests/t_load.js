// Load and soak test. Many simulated devices against a real server.
// Usage: node t_load.js            (about 2 minutes)
//        CIV=1000 CREWS=200 STATIONS=8 HISTORY=500 DURATION=3600 node t_load.js   (soak: an hour)
const fs=require('fs'),{spawn}=require('child_process'),http=require('http');
const N={civ:+process.env.CIV||300,crew:+process.env.CREWS||60,stations:+process.env.STATIONS||5,history:+process.env.HISTORY||300,dur:+process.env.DURATION||120,rate:+process.env.RATE||3};
const PORT=+process.env.LOADPORT||8084,B='http://localhost:'+PORT,sleep=ms=>new Promise(r=>setTimeout(r,ms));
const agent=new http.Agent({keepAlive:true,maxSockets:2000});
const STN=['GH-VR-HOH-001-P3Q7','GH-GA-ACC-001-B9C1','GH-GA-ACC-007-F2A3','GH-AS-KUM-001-A4F2','GH-AS-KUM-002-C7D9','GH-WR-TAK-001-D2E8','GH-CR-CAP-001-X1Y2','GH-NR-TAM-001-Q9W8'].slice(0,N.stations);
const lat={get:[],put:[],health:[],prop:[]},cnt={get:0,put:0,err:0,e429:0,e5xx:0,sse:0,events:0};
const pct=(a,p)=>a.length?a.slice().sort((x,y)=>x-y)[Math.min(a.length-1,Math.floor(a.length*p))]:0;
function req(m,p,t,b){return new Promise(res=>{const t0=Date.now();const data=b?JSON.stringify(b):null;const r=http.request(B+p,{method:m,agent,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{}),...(data?{'Content-Length':Buffer.byteLength(data)}:{})}},rs=>{let n=0;rs.on('data',c=>n+=c.length);rs.on('end',()=>{const dt=Date.now()-t0;if(m==='GET'){lat.get.push(dt);cnt.get++}else if(m==='PUT'||m==='POST'){lat.put.push(dt);cnt.put++}if(rs.statusCode===429)cnt.e429++;else if(rs.statusCode>=500)cnt.e5xx++;else if(rs.statusCode>=400&&rs.statusCode!==409){cnt.err++;const k=m+' '+p.split('/')[3].slice(0,18)+' '+rs.statusCode;cnt.by=cnt.by||{};cnt.by[k]=(cnt.by[k]||0)+1}res({s:rs.statusCode,bytes:n,body:null})})});r.on('error',()=>{if(!globalThis.__stopped)cnt.err++;res({s:0})});r.setTimeout(20000,()=>{r.destroy();cnt.err++});if(data)r.write(data);r.end()})}
const J=async(m,p,t,b)=>new Promise(res=>{const data=b?JSON.stringify(b):null;const r=http.request(B+p,{method:m,agent,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{}),...(data?{'Content-Length':Buffer.byteLength(data)}:{})}},rs=>{let s='';rs.on('data',c=>s+=c);rs.on('end',()=>{let j={};try{j=JSON.parse(s)}catch(e){}res({s:rs.statusCode,j})})});r.on('error',()=>res({s:0,j:{}}));if(data)r.write(data);r.end()});
const rss=pid=>{try{return +fs.readFileSync('/proc/'+pid+'/status','utf8').match(/VmRSS:\s+(\d+)/)[1]/1024}catch(e){return 0}};
const cpu=pid=>{try{const f=fs.readFileSync('/proc/'+pid+'/stat','utf8').split(' ');return (+f[13]+ +f[14])/100}catch(e){return 0}};
(async()=>{
 const ROOT='/tmp/gload';fs.rmSync(ROOT,{recursive:true,force:true});fs.mkdirSync(ROOT,{recursive:true});
 const srv=spawn('node',['geams-server.js'],{env:{...process.env,PORT:''+PORT,GEAMS_DATA:ROOT+'/d.json',GEAMS_HQ_USERS:ROOT+'/u.json',GEAMS_HQ_ADMIN_PASSWORD:'Test-Owner-Pass-1',GEAMS_SEED_DEFAULT_STATIONS:'1',GEAMS_BACKUP_HOURS:'0',GEAMS_CIV_SESSION_LIMIT:'100000',GEAMS_CIV_ALERTS_PER_HOUR:'100000'}});let slog='';srv.stdout.on('data',d=>slog+=d);srv.stderr.on('data',d=>slog+=d);await sleep(2500);
 const hq=(await J('POST','/api/hq/login',null,{username:'hqadmin',password:'Test-Owner-Pass-1'})).j.token;
 const reg={};STN.forEach((s,i)=>reg[s]={id:s,name:s,region:'X',town:'x',lat:7.15+i*0.01,lng:0.47,jurisdictionRadiusM:3000});await J('PUT','/api/kv/'+encodeURIComponent('registry:stations'),hq,{value:reg});
 // history: old resolved incidents so the maps are realistic
 for(const s of STN){const m={};for(let i=0;i<N.history;i++){const id='INC-H'+s.slice(-4)+i;m[id]={id,status:'resolved',type:'medical',priority:'high',location:'Somewhere '+i,lat:7.15,lng:0.47,civilianName:'Person '+i,civilianPhone:'0200'+String(100000+i),createdAt:new Date(Date.now()-86400000*(i+1)).toISOString(),resolvedAt:Date.now()-86400000*i,notes:'x'.repeat(200),source:'civilian-app'}}
  await J('PUT','/api/kv/'+encodeURIComponent('lcr:'+s+':incidents'),hq,{value:m});}
 const mapBytes=(await req('GET','/api/kv/'+encodeURIComponent('lcr:'+STN[0]+':incidents'),hq)).bytes;
 console.log(`Setup: ${N.civ} civilians, ${N.crew} crew/station watchers, ${STN.length} stations, ${N.history} old incidents each (map ${(mapBytes/1024).toFixed(0)} KB). Running ${N.dur}s at ~${N.rate} new alerts/s.`);
 // civilians
 const civs=[];for(let i=0;i<N.civ;i++){const t=(await J('POST','/api/civilian/session',null,{secret:'load'+String(i).padStart(6,'0')+'x'.repeat(20)})).j.token;civs.push({t,i,st:STN[i%STN.length]});}
 const stop={v:false};const evAt=new Map();
 // SSE connections (a share of devices hold one open, like the apps do)
 const sseN=Math.min(N.civ+N.crew,+process.env.SSE||400);const sses=[];
 for(let i=0;i<sseN;i++){const r=http.get(B+'/api/events',{agent:new http.Agent({keepAlive:true})},rs=>{cnt.sse++;let buf='';rs.on('data',c=>{buf+=c;let k;while((k=buf.indexOf('\n\n'))>=0){const line=buf.slice(0,k);buf=buf.slice(k+2);const m=/^data: (.*)$/m.exec(line);if(m){cnt.events++;try{const o=JSON.parse(m[1]);const t0=evAt.get(o.key+'#'+o.v);if(t0)lat.prop.push(Date.now()-t0)}catch(e){}}}})});r.on('error',()=>{});sses.push(r)}
 // pollers (what GeamsSync.watch does: every 2 s fetch the key)
 const pollers=[];
 for(const c of civs)pollers.push((async()=>{await sleep(Math.random()*2000);while(!stop.v){await req('GET','/api/kv/'+encodeURIComponent('lcr:'+c.st+':incidents'),c.t);await sleep(2000)}})());
 for(let i=0;i<N.crew;i++){const s=STN[i%STN.length];pollers.push((async()=>{await sleep(Math.random()*2000);while(!stop.v){await req('GET','/api/kv/'+encodeURIComponent('lcr:'+s+':incidents'),hq);await req('GET','/api/kv/'+encodeURIComponent('lcr:'+s+':officers'),hq);await sleep(2000)}})())}
 // writers: new alerts from civilians + station updates
 let created=0;const live=[];
 const writer=(async()=>{while(!stop.v){const c=civs[Math.floor(Math.random()*civs.length)];const id='INC-L'+Date.now().toString(36)+Math.floor(Math.random()*1e4);
   const t0=Date.now();const r=await J('PUT','/api/kv/'+encodeURIComponent('lcr:'+c.st+':incidents'),c.t,{value:{[id]:{id,status:'new',type:'medical',priority:'critical',lat:7.158,lng:0.48,civilianId:'CIV-'+(10000+c.i),civilianName:'Load '+c.i,civilianPhone:'0200000000',location:'x'}}});
   lat.put.push(Date.now()-t0);cnt.put++;if(r.s===200){created++;live.push({id,st:c.st})}else if(r.s===429)cnt.e429++;else if(r.s>=500)cnt.e5xx++;else cnt.err++;
   if(live.length>5&&Math.random()<0.7){const x=live.shift();const cur=(await J('GET','/api/kv/'+encodeURIComponent('lcr:'+x.st+':incidents'),hq)).j;if(cur.value&&cur.value[x.id]){cur.value[x.id].status='resolved';cur.value[x.id].resolvedAt=Date.now();await req('PUT','/api/kv/'+encodeURIComponent('lcr:'+x.st+':incidents'),hq,{value:cur.value})}}
   await sleep(1000/N.rate)}})();
 // health probe = event-loop responsiveness
 const probe=(async()=>{while(!stop.v){const t0=Date.now();await J('GET','/api/health');lat.health.push(Date.now()-t0);await sleep(500)}})();
 const samples=[];const c0=cpu(srv.pid),w0=Date.now();
 const t0=Date.now();while(Date.now()-t0<N.dur*1000){await sleep(Math.min(10000,N.dur*1000/6));samples.push({t:Math.round((Date.now()-t0)/1000),rss:Math.round(rss(srv.pid)),get95:pct(lat.get.slice(-500),0.95),health95:pct(lat.health.slice(-20),0.95)});console.log('  t='+samples[samples.length-1].t+'s  server memory '+samples[samples.length-1].rss+' MB  recent GET p95 '+samples[samples.length-1].get95+' ms  health p95 '+samples[samples.length-1].health95+' ms')}
 stop.v=true;globalThis.__stopped=true;await Promise.all([writer,probe]);sses.forEach(r=>r.destroy());
 const cpuUsed=(cpu(srv.pid)-c0)/((Date.now()-w0)/1000)*100;
 const R={reqPerSec:+((cnt.get+cnt.put)/N.dur).toFixed(0),getP50:pct(lat.get,.5),getP95:pct(lat.get,.95),getP99:pct(lat.get,.99),putP50:pct(lat.put,.5),putP95:pct(lat.put,.95),putP99:pct(lat.put,.99),healthP95:pct(lat.health,.95),healthMax:Math.max(...lat.health,0),cpuPct:+cpuUsed.toFixed(0),rssStart:samples[0]?samples[0].rss:0,rssEnd:samples[samples.length-1]?samples[samples.length-1].rss:0,alertsCreated:created,errors:cnt.err,rateLimited:cnt.e429,server5xx:cnt.e5xx,sseOpen:cnt.sse,sseEvents:cnt.events};
 console.log('error breakdown',JSON.stringify(cnt.by||{}));console.log('\nRESULT '+JSON.stringify(R));
 const limits={getP95:+process.env.MAX_GET_P95||800,putP95:+process.env.MAX_PUT_P95||1500,healthP95:+process.env.MAX_HEALTH_P95||500};
 let bad=[];if(R.getP95>limits.getP95)bad.push('GET p95 '+R.getP95+' ms is over '+limits.getP95);if(R.putP95>limits.putP95)bad.push('write p95 '+R.putP95+' ms is over '+limits.putP95);if(R.healthP95>limits.healthP95)bad.push('server responsiveness p95 '+R.healthP95+' ms is over '+limits.healthP95);if(R.errors>0)bad.push(R.errors+' request errors');if(R.server5xx>0)bad.push(R.server5xx+' server errors');if(R.rssEnd>R.rssStart*1.6+50)bad.push('memory grew from '+R.rssStart+' to '+R.rssEnd+' MB');
 console.log(bad.length?'FAIL '+bad.join('; '):'PASS within limits');
 srv.kill();process.exit(bad.length?1:0);
})().catch(e=>{console.log('ERR',e.stack);process.exit(2)});
