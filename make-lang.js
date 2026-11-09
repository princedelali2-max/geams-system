/* Turns a filled-in translation sheet (CSV) into the word-list files the apps read.
 *   node make-lang.js docs/translation-sheet.csv           -> vendor/lang/tw.json, ha.json, ee.json, gaa.json, dag.json   (civilian app)
 *   node make-lang.js docs/translation-sheet-staff.csv staff-  -> vendor/lang/staff-tw.json ...                          (staff apps)
 * Empty cells are skipped. A language with no filled cells gets no file and shows as "not available yet".
 * Add --checked to drop the "unchecked draft" label once a native speaker has verified that language's column. */
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2).filter(a => !a.startsWith('--')), checked = process.argv.includes('--checked');
const sheet = args[0], prefix = args[1] || '';
if (!sheet) { console.log('Usage: node make-lang.js <sheet.csv> [staff-] [--checked]'); process.exit(1); }
function parse(t) { const rows = []; let r = [], c = '', q = false; t = t.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) { const ch = t[i]; if (q) { if (ch === '"') { if (t[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; } else if (ch === '"') q = true; else if (ch === ',') { r.push(c); c = ''; } else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; r.push(c); c = ''; if (r.some(x => x)) rows.push(r); r = []; } else c += ch; }
  if (c || r.length) { r.push(c); rows.push(r); } return rows; }
const rows = parse(fs.readFileSync(sheet, 'utf8')), head = rows.shift();
const COLS = { tw: 1, ha: 2, ee: 3, gaa: 4, dag: 5 }, dir = path.join(__dirname, 'vendor', 'lang');
for (const [code, col] of Object.entries(COLS)) {
  const o = {}; rows.forEach(r => { const en = (r[0] || '').trim(), t = (r[col] || '').trim(); if (en && t && t !== en) o[en] = t; });
  const file = path.join(dir, prefix + code + '.json'), n = Object.keys(o).length;
  if (!n) { if (fs.existsSync(file)) { fs.unlinkSync(file); console.log(prefix + code + ': no phrases, file removed'); } continue; }
  fs.writeFileSync(file, JSON.stringify(checked ? o : Object.assign({ __note: 'Unchecked draft: a native speaker must verify before use.' }, o), null, 1) + '\n');
  console.log(prefix + code + ': ' + n + ' phrases');
}
