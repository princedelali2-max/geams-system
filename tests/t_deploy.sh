#!/usr/bin/env bash
# Checks the deployment kit without needing root: env template boots the server, binds privately, files are well-formed.
cd "$(dirname "$0")"; fail=0; ok(){ echo "PASS $1"; }; bad(){ echo "FAIL $1"; fail=1; }
bash -n deploy/install.sh && ok "install.sh is valid shell" || bad "install.sh syntax"
D=/tmp/gdeploy; rm -rf $D; mkdir -p $D
sed "s|/var/lib/geams|$D|g; s|^PORT=.*|PORT=8230|; s|^GEAMS_HQ_ADMIN_PASSWORD=.*|GEAMS_HQ_ADMIN_PASSWORD=Deploy-Test-Pass-123|; s|^GEAMS_BACKUP_HOURS=.*|GEAMS_BACKUP_HOURS=0|" deploy/geams.env.example > $D/geams.env
grep -q "CHANGE-ME" deploy/geams.env.example && ok "template has CHANGE-ME placeholders (install.sh replaces them with random ones)" || bad "placeholders"
( set -a; . $D/geams.env; set +a; exec node geams-server.js >$D/log 2>&1 ) & SP=$!
for i in $(seq 40); do sleep .25; curl -fs http://127.0.0.1:8230/api/health >/dev/null && break; done
curl -fs http://127.0.0.1:8230/api/health | grep -q '"saving":true' && ok "server starts from the env template and saves" || bad "server start"
IP=$(hostname -I | awk '{print $1}'); [ -n "$IP" ] && { curl -fs --max-time 3 http://$IP:8230/api/health >/dev/null && bad "reachable on the public interface (GEAMS_BIND ignored)" || ok "not reachable except from this machine (GEAMS_BIND=127.0.0.1)"; }
T=$(curl -s -X POST http://127.0.0.1:8230/api/hq/login -H 'Content-Type: application/json' -d '{"username":"hqadmin","password":"Deploy-Test-Pass-123"}'); echo "$T" | grep -q token && ok "HQ owner password from the env file works" || bad "hq login"
curl -s http://127.0.0.1:8230/geams-data.json -o /dev/null -w '%{http_code}' | grep -q 403 && ok "data file is not downloadable" || bad "data file served"
kill $SP 2>/dev/null; wait $SP 2>/dev/null
command -v systemd-analyze >/dev/null && { systemd-analyze verify deploy/geams.service 2>&1 | grep -qi "error\|unknown" && bad "service file" || ok "systemd unit verified"; } || echo "SKIP systemd-analyze not available here"
command -v caddy >/dev/null && { caddy validate --config deploy/Caddyfile >/dev/null 2>&1 && ok "Caddyfile validates" || bad "Caddyfile"; } || echo "SKIP caddy not installed here (Caddyfile not machine-checked)"
command -v nginx >/dev/null && echo "SKIP nginx needs certificates (not machine-checked)" || echo "SKIP nginx not installed here (nginx-geams.conf not machine-checked)"
[ $fail = 0 ] && echo "passed all deploy checks" || echo "DEPLOY CHECK FAILED"
exit $fail
