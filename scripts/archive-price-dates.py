#!/usr/bin/env python3
"""Archive selected price dates (defaults: 2026-10-26/27); optionally import cloud 29th.
Run only with the owning application stopped. Full SQLite backups stay in .archive.
"""
import argparse, datetime, hashlib, json, os, sqlite3, subprocess
from pathlib import Path

REMOVE = ('2026-10-26', '2026-10-27')
LABELS = ('10.26', '10.27', *REMOVE)
IMPORT = '2026-10-29'

def connect(path):
    db = sqlite3.connect(str(path), timeout=30)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA foreign_keys=ON')
    return db

def rows(db, sql, args=()):
    return [dict(row) for row in db.execute(sql, args)]

def digest(db, sql, args=()):
    return hashlib.sha256(json.dumps(rows(db, sql, args), sort_keys=True, ensure_ascii=False).encode()).hexdigest()

def backup(path, destination):
    source = connect(path)
    if hasattr(source, 'backup'):
        dest = sqlite3.connect(str(destination))
        source.backup(dest)
        dest.close(); source.close()
    else:
        source.close()
        subprocess.check_call(['sqlite3', str(path), ".backup '" + str(destination).replace("'", "''") + "'"])
    os.chmod(destination, 0o600)

def copy_rows(db, table, condition, args=(), preserve_rowid=False):
    names = [row['name'] for row in db.execute(f'PRAGMA cloud.table_info({table})')]
    columns = ','.join('"'+name+'"' for name in names)
    if preserve_rowid: columns = 'rowid,' + columns
    db.execute(f'INSERT INTO main.{table} ({columns}) SELECT {columns} FROM cloud.{table} WHERE {condition}', args)

def main():
    global REMOVE, LABELS
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', required=True)
    parser.add_argument('--cloud-snapshot')
    parser.add_argument('--stamp', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--remove-date', action='append', help='ISO business date; may be repeated')
    opts = parser.parse_args()
    if opts.remove_date:
        REMOVE = tuple(dict.fromkeys(opts.remove_date))
        for date in REMOVE:
            if datetime.datetime.strptime(date, '%Y-%m-%d').strftime('%Y-%m-%d') != date:
                raise ValueError('Expected ISO date')
        LABELS = tuple(label for date in REMOVE for label in (f"{int(date[5:7])}.{date[8:]}", date))
    placeholders = ','.join('?' for _ in REMOVE)
    data = Path(opts.data_dir).resolve()
    path = data/'price-workbench.sqlite'
    db = connect(path)
    if db.execute("SELECT count(*) FROM runs WHERE state IN ('queued','running')").fetchone()[0]:
        raise RuntimeError('Active collection job; do not modify data')
    summary = {'dataDir': str(data), 'remove': REMOVE, 'before': {t: rows(db, f'SELECT date,count(*) n FROM {t} GROUP BY date') for t in ['daily','observations','revisions','formal_price_publications']}}
    preserve29 = {t: digest(db, f'SELECT * FROM {t} WHERE date=? ORDER BY rowid', ('2026-10-29',)) for t in ['daily','observations','revisions','runs','quote_reviews','formal_price_publications']}
    preserve30 = {t: digest(db, f'SELECT * FROM {t} WHERE date=? ORDER BY rowid', ('2026-10-30',)) for t in ['daily','observations','revisions','runs']}
    if opts.cloud_snapshot:
        db.execute('ATTACH DATABASE ? AS cloud', (str(Path(opts.cloud_snapshot).resolve()),))
        if not db.execute('SELECT 1 FROM cloud.formal_price_publications WHERE date=?',(IMPORT,)).fetchone():
            raise RuntimeError('Cloud 29th is not formally published')
        if db.execute('SELECT 1 FROM main.daily WHERE date=?',(IMPORT,)).fetchone():
            raise RuntimeError('Local 29th already exists: compare rather than overwrite')
        conflicts = db.execute('SELECT count(*) FROM main.revisions a JOIN cloud.revisions b ON a.rowid=b.rowid WHERE b.date=?',(IMPORT,)).fetchone()[0]
        if conflicts: raise RuntimeError('Revision rowid collision; preserve publication cutoff semantics')
        summary['import'] = {t: db.execute(f'SELECT count(*) FROM cloud.{t} WHERE date=?',(IMPORT,)).fetchone()[0] for t in ['daily','observations','revisions','runs']}
    if not opts.apply:
        print(json.dumps(summary,ensure_ascii=False)); return
    archive = data/'.archive'/opts.stamp
    archive.mkdir(parents=True, exist_ok=False, mode=0o700)
    os.chmod(archive,0o700)
    db.close()
    files = [path] + [data/name for name in ['published-price-draft.sqlite','raw-editor-draft.sqlite'] if (data/name).exists()]
    for file in files: backup(file, archive/(file.name+'.before.sqlite'))
    db = connect(path)
    if opts.cloud_snapshot: db.execute('ATTACH DATABASE ? AS cloud',(str(Path(opts.cloud_snapshot).resolve()),))
    try:
        db.execute('BEGIN IMMEDIATE')
        # All original records remain recoverable in the consistent before.sqlite backup.
        for table in ['daily','quote_reviews','revisions']:
            db.execute(f'DELETE FROM {table} WHERE date IN (?,?)'.replace('?,?', placeholders), REMOVE)
        # A later day's daily record can legitimately retain a historical observation.
        protected = db.execute('SELECT count(*) FROM observations o WHERE date IN (?,?) AND EXISTS(SELECT 1 FROM daily d WHERE d.observation_id=o.id)'.replace('?,?', placeholders), REMOVE).fetchone()[0]
        db.execute('DELETE FROM observations WHERE date IN (?,?) AND NOT EXISTS(SELECT 1 FROM daily d WHERE d.observation_id=observations.id)'.replace('?,?', placeholders), REMOVE)
        db.execute('DELETE FROM run_items WHERE run_id IN (SELECT id FROM runs WHERE date IN (?,?))'.replace('?,?', placeholders), REMOVE)
        db.execute('DELETE FROM runs WHERE date IN (?,?)'.replace('?,?', placeholders), REMOVE)
        db.execute('DELETE FROM formal_price_publications WHERE date IN (?,?)'.replace('?,?', placeholders), REMOVE)
        for row in db.execute('SELECT id,legacy_json FROM skus').fetchall():
            snapshots = json.loads(row['legacy_json'])
            if any(label in snapshots for label in LABELS):
                for label in LABELS: snapshots.pop(label,None)
                db.execute('UPDATE skus SET legacy_json=? WHERE id=?',(json.dumps(snapshots,ensure_ascii=False),row['id']))
        legacy = db.execute("SELECT value FROM meta WHERE key='legacy_dates'").fetchone()
        if legacy: db.execute("UPDATE meta SET value=? WHERE key='legacy_dates'",(json.dumps([d for d in json.loads(legacy[0]) if d not in LABELS]),))
        if opts.cloud_snapshot:
            # Insert missing catalogue keys only: no unrelated local dimension edits overwritten.
            db.execute('INSERT INTO main.models SELECT * FROM cloud.models WHERE id NOT IN (SELECT id FROM main.models)')
            db.execute('INSERT INTO main.skus SELECT * FROM cloud.skus WHERE id NOT IN (SELECT id FROM main.skus)')
            copy_rows(db,'runs','date=?',(IMPORT,))
            copy_rows(db,'observations','date=?',(IMPORT,))
            copy_rows(db,'daily','date=?',(IMPORT,))
            copy_rows(db,'revisions','date=?',(IMPORT,),True)
            copy_rows(db,'quote_reviews','date=?',(IMPORT,))
            copy_rows(db,'run_items','run_id IN (SELECT id FROM cloud.runs WHERE date=?)',(IMPORT,))
            copy_rows(db,'formal_price_publications','date=?',(IMPORT,))
            db.execute("INSERT INTO main.meta SELECT * FROM cloud.meta WHERE key LIKE 'product_link:%' ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            # Any newly inserted legacy catalogue records must not reintroduce removed dates.
            for row in db.execute('SELECT id,legacy_json FROM skus').fetchall():
                snapshots=json.loads(row['legacy_json'])
                if any(label in snapshots for label in LABELS):
                    for label in LABELS:snapshots.pop(label,None)
                    db.execute('UPDATE skus SET legacy_json=? WHERE id=?',(json.dumps(snapshots,ensure_ascii=False),row['id']))
            for table in ['daily','observations','revisions','runs','quote_reviews','formal_price_publications']:
                if digest(db,f'SELECT * FROM main.{table} WHERE date=? ORDER BY rowid',(IMPORT,)) != digest(db,f'SELECT * FROM cloud.{table} WHERE date=? ORDER BY rowid',(IMPORT,)):
                    raise RuntimeError('Cloud import differs: '+table)
        stamp=datetime.datetime.now(datetime.timezone.utc).isoformat()
        db.execute('INSERT INTO outbox(id,pending,updated_at,error) VALUES(1,1,?,NULL) ON CONFLICT(id) DO UPDATE SET pending=1,updated_at=excluded.updated_at,error=NULL',(stamp,))
        if not opts.cloud_snapshot and '2026-10-29' not in REMOVE:
            for table, before in preserve29.items():
                if digest(db, f'SELECT * FROM {table} WHERE date=? ORDER BY rowid', ('2026-10-29',)) != before:
                    raise RuntimeError('Unrelated 29th records changed')
        for table, before in preserve30.items():
            if digest(db,f'SELECT * FROM {table} WHERE date=? ORDER BY rowid',('2026-10-30',)) != before:
                raise RuntimeError('Unrelated 30th records changed')
        if db.execute('PRAGMA foreign_key_check').fetchall(): raise RuntimeError('Foreign key check failed')
        db.commit()
    except Exception:
        db.rollback(); raise
    summary['protectedHistoricalObservations']=protected
    summary['after']={t:rows(db,f'SELECT date,count(*) n FROM {t} GROUP BY date') for t in ['daily','observations','revisions','formal_price_publications']}
    summary['cloud29Matched'] = bool(opts.cloud_snapshot)
    summary['preserved30'] = True
    db.close()
    # Clean persistent projections/backstops as well as the owning workbench database.
    for file in files[1:]:
        c=connect(file)
        for row in c.execute('SELECT * FROM raw_editor_drafts').fetchall():
            dates=[d for d in json.loads(row['dates_json']) if d not in LABELS]
            records=json.loads(row['rows_json'])
            for record in records:
                for label in LABELS: record.get('snapshots',{}).pop(label,None)
                if 'strictDates' in record: record['strictDates']=[d for d in record['strictDates'] if d not in LABELS]
            c.execute('UPDATE raw_editor_drafts SET dates_json=?,rows_json=?,updated_at=? WHERE id=?',(json.dumps(dates),json.dumps(records,ensure_ascii=False),stamp,row['id']))
        c.commit(); c.close()
    summary['archive']=str(archive)
    (archive/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
    os.chmod(archive/'summary.json',0o600)
    # A portable post-maintenance snapshot for exact downstream syncing.
    backup(path,archive/'price-workbench.after.sqlite')
    print(json.dumps(summary,ensure_ascii=False))

if __name__=='__main__': main()
