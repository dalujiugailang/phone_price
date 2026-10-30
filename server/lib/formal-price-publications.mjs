// Formal snapshots are frozen only by an administrator's warehouse push.
export function initializeFormalPublications(db,today){
  db.exec('CREATE TABLE IF NOT EXISTS formal_price_publications(date TEXT PRIMARY KEY,revision_rowid INTEGER NOT NULL,pushed_at TEXT NOT NULL,actor TEXT NOT NULL)');
  if(db.prepare('SELECT value FROM meta WHERE key=?').get('formal_publication_policy'))return;
  db.exec('BEGIN IMMEDIATE');try{
    const dates=db.prepare('SELECT DISTINCT date FROM revisions').all();
    for(const {date} of dates){
      const push=db.prepare("SELECT created_at,actor FROM audit WHERE action='PUSH_WAREHOUSE' AND entity=? ORDER BY id DESC LIMIT 1").get(date);
      if(date>=today&&!push)continue;
      const max=db.prepare('SELECT MAX(rowid) n FROM revisions WHERE date=? AND created_at<=?').get(date,push?.created_at || '9999').n;
      if(max)db.prepare('INSERT INTO formal_price_publications VALUES(?,?,?,?)').run(date,max,push?.created_at||today,push?.actor||'historical-baseline');
    }
    db.prepare('INSERT INTO meta VALUES(?,?)').run('formal_publication_policy',today);
    db.prepare('INSERT INTO outbox(id,pending,updated_at,error) VALUES(1,1,?,NULL) ON CONFLICT(id) DO UPDATE SET pending=1,updated_at=excluded.updated_at,error=NULL').run(new Date().toISOString());
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
}
export function commitFormalPublication(db,date,actor,stamp){
  const max=db.prepare('SELECT COALESCE(MAX(rowid),0) n FROM revisions').get().n;
  db.prepare('INSERT INTO formal_price_publications VALUES(?,?,?,?) ON CONFLICT(date) DO UPDATE SET revision_rowid=excluded.revision_rowid,pushed_at=excluded.pushed_at,actor=excluded.actor').run(date,max,stamp,actor);
}
export function carryFormalPrices(rows,dates){
  for(const row of rows){let previous=null,sourceDate=null;for(const date of dates){const current=row.snapshots[date];if(Number(current?.finalPrice)>0){previous=current;sourceDate=date;}else if(previous){row.snapshots[date]={...previous,biPrice:current?.biPrice||previous.biPrice||'',carriedFrom:sourceDate};}}}
  return rows;
}
