"""Read-only SKU import preflight; never writes production data."""
import collections
import hashlib
import json
import pathlib
import re
import subprocess
import unicodedata
import zipfile
import xml.etree.ElementTree as ET

SOURCE = pathlib.Path('/Users/dudu_1/Documents/Codex/2026-09-14/diy')
WORKBOOK = SOURCE / 'outputs/1027-jd-brand-append/安卓手机_N及N-1代_SKU完整明细_20261027_附品牌自营查价.xlsx'
RESULTS = SOURCE / 'work/maishou-1027-brand/results.json'

def normalize(value):
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', value)).casefold()

def storage_key(value):
    text = normalize(value)
    match = re.fullmatch(r'(\d+)(?:gb|g)?\+(\d+)(tb|t|gb|g)(.*)', text)
    if not match:
        return 'unparsed:' + text
    ram, disk, unit, edition = match.groups()
    disk = int(disk) * (1024 if unit in ('t', 'tb') else 1)
    return int(ram), disk, edition

def key(row):
    return normalize(row['model']), storage_key(row['storage'])

def main():
    incoming = json.loads(RESULTS.read_text())
    remote_code = '''import sqlite3,json
c=sqlite3.connect("file:/www/wwwroot/gtm-price-monitor/data/raw-editor-draft.sqlite?mode=ro",uri=True)
r=c.execute("select rows_json,dates_json from raw_editor_drafts where id=1").fetchone()
print(json.dumps({"rows":[{k:v for k,v in x.items() if k!="snapshots"} for x in json.loads(r[0])],"dates":json.loads(r[1])},ensure_ascii=False))'''
    remote = subprocess.run([
        'ssh', '-i', '/private/tmp/gtm-admin-ssh-key.pem', '-o', 'IdentitiesOnly=yes',
        '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o',
        'UserKnownHostsFile=/private/tmp/gtm-ssh-known-hosts-8.162.25.246',
        'root@8.162.25.246', "python3 - <<'PY'\n" + remote_code + '\nPY',
    ], capture_output=True, text=True, check=True)
    current = json.loads(remote.stdout)
    existing = current['rows']
    old_keys, new_keys = {key(r) for r in existing}, {key(r) for r in incoming}
    additions = [r for r in incoming if key(r) not in old_keys]
    overlapping = [r for r in incoming if key(r) in old_keys]
    old_models = {normalize(r['model']) for r in existing}
    price_counts = lambda rows: {
        'total': len(rows),
        'matched': sum(bool(r.get('selected')) for r in rows),
        'unmatched': sum(not r.get('selected') for r in rows),
        'price_mismatch': sum(bool(r.get('selected')) and abs(r['selected']['listing'] - r['selected']['coupon'] - r['selected']['actual']) > 0.010000001 for r in rows),
    }
    ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    with zipfile.ZipFile(WORKBOOK) as z:
        strings = [''.join(s.itertext()) for s in ET.fromstring(z.read('xl/sharedStrings.xml'))] if 'xl/sharedStrings.xml' in z.namelist() else []
        def cell_value(cell):
            value = cell.find('m:v', ns)
            if cell.attrib.get('t') == 's':
                return strings[int(value.text)]
            if cell.attrib.get('t') == 'inlineStr':
                return ''.join(cell.find('m:is', ns).itertext())
            return value.text if value is not None else None
        sheets = ET.fromstring(z.read('xl/workbook.xml')).find('m:sheets', ns)
        sheet_names = [s.attrib['name'] for s in sheets]
        sheet_rows = ET.fromstring(z.read('xl/worksheets/sheet2.xml')).findall('m:sheetData/m:row', ns)
        workbook_price_rows = sum(int(r.attrib['r']) >= 7 for r in sheet_rows)
        differences = []
        for row in sheet_rows:
            number = int(row.attrib['r'])
            if number < 7:
                continue
            actual = {re.sub(r'\d+', '', c.attrib['r']): cell_value(c) for c in row.findall('m:c', ns)}
            expected = incoming[number - 7]
            quote = expected.get('selected') or {}
            for col, value in [('C', expected['model']), ('D', expected['storage']), ('E', quote.get('listing')), ('F', quote.get('coupon')), ('G', quote.get('actual'))]:
                got = actual.get(col)
                same = got == value if isinstance(value, str) else got in (None, '') if value is None else got is not None and abs(float(got) - value) < 0.000001
                if not same:
                    differences.append({'cell': col + str(number), 'workbook': got, 'json': value})
    summary = {
        'source_workbook': str(WORKBOOK),
        'source_sha256': hashlib.sha256(WORKBOOK.read_bytes()).hexdigest(),
        'source_sheets': sheet_names,
        'workbook_price_rows': workbook_price_rows,
        'workbook_json_field_differences': differences,
        'current_skus': len(existing),
        'current_models': len(old_models),
        'current_dates': len(current['dates']),
        'incoming': price_counts(incoming),
        'existing_overlap': price_counts(overlapping),
        'proposed_additions': price_counts(additions),
        'incoming_duplicates': len(incoming) - len(new_keys),
        'existing_duplicates': len(existing) - len(old_keys),
        'projected_total_skus': len(old_keys | new_keys),
        'new_models': len({normalize(r['model']) for r in additions} - old_models),
        'new_specs_for_existing_models': sum(normalize(r['model']) in old_models for r in additions),
        'unparsed_storage': [r['storage'] for r in existing + incoming if isinstance(storage_key(r['storage']), str)],
        'additions_by_brand': dict(collections.Counter(r['brand'] for r in additions)),
        'new_model_names': list(dict.fromkeys(r['model'] for r in additions if normalize(r['model']) not in old_models)),
        'normalization': 'NFKC + ignore whitespace/case; storage G=GB and T=TB, 1TB=1024GB; keep special edition suffixes; no fuzzy or brand alias merge',
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
