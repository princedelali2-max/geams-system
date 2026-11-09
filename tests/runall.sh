cd /home/claude/geams
for t in t_recovery t_recovery_ui t_regress t_privacy t_privacy_ui t_final t_sweep t_sweep2 t_sweep3 t_storage_real t_mutualaid t_retention t_retention_ui t_consent t_consent_ui t_feedback t_drill t_outbox t_security t_lang t_diag t_stafflog t_dup t_abuse t_phonerestore t_hqscreens t_csp t_vendor t_a11y t_crew t_crew_ui t_stafflang t_guide t_load t_escal t_escal_ui t_civsend t_restore t_crash t_bulk t_report t_e112 t_demooff; do
  for p in /proc/[0-9]*; do grep -qa "PORT=8[01][0-9][0-9]" $p/environ 2>/dev/null && kill ${p#/proc/} 2>/dev/null; done
  echo "== $t $(DURATION=30 timeout 400 node $t.js 2>&1 | grep 'FAIL\|passed\|ERR\|PASS within' | cut -c1-200 | tr '\n' ' ')"
done
echo ALLDONE
