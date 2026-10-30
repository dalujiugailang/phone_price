import fs from 'node:fs';const file=process.argv[2];let s=fs.readFileSync(file,'utf8');function replace(a,b){if(!s.includes(a))throw Error('Source changed: '+a.slice(0,90));s=s.replace(a,b);}
replace("import { DatabaseSync } from 'node:sqlite';","import { DatabaseSync } from 'node:sqlite';\nimport {initializeFormalPublications,commitFormalPublication,carryFormalPrices} from './formal-price-publications.mjs';");
replace('  const tx = (fn)', '  initializeFormalPublications(db,beijingDate(clock()));\n  const tx = (fn)');
replace('    const published = latestRevision(id,date);',`    const published = db.prepare('SELECT r.* FROM revisions r JOIN formal_price_publications p ON p.date=r.date AND r.rowid<=p.revision_rowid WHERE r.sku_id=? AND r.date=? ORDER BY r.rowid DESC LIMIT 1').get(id,date);`);
replace("['discontinued','out_of_stock','not_launched'].includes(published?.availability)","['discontinued','out_of_stock','not_launched'].includes(row.availability)");
replace('    if (automatic && row.issues.length) return null;',`    if (automatic) {
      if(!row.issues.length)db.prepare("UPDATE daily SET review_state='api_passed' WHERE sku_id=? AND date=?").run(id,date);
      return null;
    }`);
replace("      audit(actor,'PUSH_WAREHOUSE',date,null,summary);outbox();return summary;","      commitFormalPublication(db,date,actor.id,now());\n      audit(actor,'PUSH_WAREHOUSE',date,null,summary);outbox();return summary;");
replace("    const dates=new Set(legacyDates);",`    const cutoff=db.prepare('SELECT value FROM meta WHERE key=?').get('formal_publication_policy')?.value;
    const isoLabel=d=>d.includes('-')?d:\`2026-\${d.split('.')[0].padStart(2,'0')}-\${d.split('.')[1]}\`;
    const dates=new Set(legacyDates.filter(d=>!cutoff || isoLabel(d)<cutoff));`);
replace("SELECT DISTINCT date FROM daily ORDER BY date","SELECT date FROM formal_price_publications ORDER BY date");
replace("SELECT * FROM revisions ORDER BY rowid","SELECT r.* FROM revisions r JOIN formal_price_publications p ON p.date=r.date AND r.rowid<=p.revision_rowid ORDER BY r.rowid");
replace("    return {dates:[...dates].sort((a,b)=>dateSort(a).localeCompare(dateSort(b))),rows,savedAt:","    const orderedDates=[...dates].sort((a,b)=>dateSort(a).localeCompare(dateSort(b)));\n    carryFormalPrices(rows,orderedDates);\n    return {dates:orderedDates,rows,savedAt:");
fs.writeFileSync(file,s);console.log('Patched formal publication boundary');
