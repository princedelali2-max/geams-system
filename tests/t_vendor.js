// Checks the bundled third-party files are exactly what was reviewed (nothing swapped or corrupted), and their stated versions.
const fs=require('fs'),crypto=require('crypto'),path=require('path');let pass=0,fail=0;const ck=(n,c,x)=>{c?pass++:(fail++,console.log('  FAIL',n,x||''))};
const dir=path.join(__dirname,fs.existsSync(path.join(__dirname,'vendor'))?'':'..','vendor');
const lines=fs.readFileSync(path.join(dir,'CHECKSUMS.txt'),'utf8').trim().split('\n');
for(const l of lines){const [h,f]=l.split(/\s+/);const fp=path.join(dir,f);const ok=fs.existsSync(fp)&&crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex')===h;ck('unchanged: '+f,ok);}
ck('Leaflet is 1.9.4',/Leaflet 1\.9\.4/.test(fs.readFileSync(path.join(dir,'leaflet/leaflet.js'),'utf8').slice(0,300)));
ck('face library present with its models',fs.existsSync(path.join(dir,'face/face-api.min.js'))&&fs.readdirSync(path.join(dir,'face/model')).length>=6);
console.log(`\nvendor files: ${pass} passed, ${fail} failed`);process.exit(fail?1:0);
