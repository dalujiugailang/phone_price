"""Apply reviewed model positions and exact source S-grade PPVs, without price edits."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import sqlite3
import uuid


def read_json(path):
    return json.loads(path.read_text())


def price_signature(db):
    digest = hashlib.sha256()
    for table in ('daily', 'revisions', 'formal_price_publications'):
        digest.update(table.encode())
        if not db.execute('SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name=?', (table,)).fetchone():
            digest.update(b'absent')
            continue
        for row in db.execute(f'SELECT * FROM {table} ORDER BY rowid'):
            digest.update(json.dumps(tuple(row), ensure_ascii=False).encode())
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--plan-dir', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    positions = read_json(args.plan_dir / 'position-plan.json')
    ppvs = read_json(args.plan_dir / 'ppv-plan.json')
    source = {r['ppv'] for r in read_json(args.plan_dir / 's-source.json')}
    assert all(r['newPpv'] in source and r['source']['grade'] == 'S' for r in ppvs)
    assert all('大陆国行' in r['newPpv'] and '展示机' not in r['newPpv'] for r in ppvs)
    db_path = args.data_dir / 'price-workbench.sqlite'
    mode = 'rw' if args.apply else 'ro'
    db = sqlite3.connect(f'file:{db_path}?mode={mode}', uri=True, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA busy_timeout=15000')
    model_changes, sku_changes = [], []
    for r in positions:
        old = db.execute('SELECT * FROM models WHERE id=?', (r['id'],)).fetchone()
        assert old is not None and old['name'] == r['model']
        if old['position'] == r['position']:
            continue
        assert old['position'] == r['oldPosition'] == '', f"Model changed: {r['model']}"
        model_changes.append((dict(old), r))
    for r in ppvs:
        old = db.execute('SELECT * FROM skus WHERE id=? AND active=1', (r['id'],)).fetchone()
        assert old is not None and old['storage'] == r['storage'] and old['model_id'] == r['model_id']
        if old['ppv'] == r['newPpv']:
            continue
        assert old['ppv'] == r['ppv'] and (not old['ppv'] or r.get('correction') is True), f"PPV changed: {r['id']}"
        sku_changes.append((dict(old), r))
    report = {'dataDir': str(args.data_dir.resolve()), 'apply': args.apply,
              'modelChanges': len(model_changes), 'ppvChanges': len(sku_changes)}
    if args.apply and (model_changes or sku_changes):
        at = datetime.datetime.now(datetime.timezone.utc).isoformat()
        request_id = str(uuid.uuid4())
        archive = args.data_dir / '.archive' / f'metadata-{request_id}'
        archive.mkdir(parents=True)
        # Only these metadata rows change; retain their full preimages for rollback.
        (archive / 'before.json').write_text(json.dumps({
            'models': [old for old, _ in model_changes],
            'skus': [old for old, _ in sku_changes],
            'outbox': [dict(r) for r in db.execute('SELECT * FROM outbox')],
        }, ensure_ascii=False, indent=2))
        db.execute('BEGIN IMMEDIATE')
        try:
            before = price_signature(db)
            for old, r in model_changes:
                cursor = db.execute('UPDATE models SET position=?,version=version+1 WHERE id=? AND position=? AND version=?',
                                    (r['position'], r['id'], old['position'], old['version']))
                assert cursor.rowcount == 1, 'Concurrent model edit'
                db.execute('INSERT INTO audit(actor,action,entity,before_json,after_json,request_id,created_at,business_date) VALUES(?,?,?,?,?,?,?,?)',
                           ('metadata-import', 'BACKFILL_POSITION', r['id'], json.dumps(old, ensure_ascii=False),
                            json.dumps(r, ensure_ascii=False), request_id, at, '2026-10-30'))
            for old, r in sku_changes:
                cursor = db.execute('UPDATE skus SET ppv=? WHERE id=? AND ppv=?', (r['newPpv'], r['id'], old['ppv']))
                assert cursor.rowcount == 1, 'Concurrent SKU edit'
                db.execute('INSERT INTO audit(actor,action,entity,before_json,after_json,request_id,created_at,sku_id,business_date) VALUES(?,?,?,?,?,?,?,?,?)',
                           ('metadata-import', 'BACKFILL_S_PPV', r['id'], json.dumps(old, ensure_ascii=False),
                            json.dumps({'ppv': r['newPpv'], 'source': r['source'], 'file': 'C2B_high_level_price_analyze_20261028.xlsx'}, ensure_ascii=False),
                            request_id, at, r['id'], '2026-10-30'))
            after = price_signature(db)
            assert before == after, 'Price data changed'
            updated = db.execute('UPDATE outbox SET pending=1,updated_at=?,error=NULL WHERE id=1', (at,))
            if updated.rowcount == 0:
                db.execute('INSERT INTO outbox(id,pending,updated_at,error) VALUES(1,1,?,NULL)', (at,))
            db.commit()
            report.update(archive=str(archive), priceDataUnchanged=True, requestId=request_id)
        except BaseException:
            db.rollback()
            raise
    report['missingPositions'] = db.execute("SELECT count(*) FROM models WHERE position='' AND id IN (SELECT model_id FROM skus WHERE active=1)").fetchone()[0]
    report['missingPpvs'] = [dict(r) for r in db.execute("SELECT m.name model,s.storage FROM skus s JOIN models m ON m.id=s.model_id WHERE s.active=1 AND s.ppv=''")]
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.apply:
        (args.plan_dir / ('applied-' + hashlib.sha256(str(args.data_dir.resolve()).encode()).hexdigest()[:8] + '.json')).write_text(json.dumps(report, ensure_ascii=False, indent=2))
    db.close()


if __name__ == '__main__':
    main()
