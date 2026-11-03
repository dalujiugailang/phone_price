"""Stream the large history into the Artifact Tool-authored workbook.

All layout, tables, styles, and previews are authored by Artifact Tool. This step
avoids materializing 4.2 million historical cells in its in-memory worksheet.
"""
from pathlib import Path
import json
import re
from datetime import date
import zipfile
from xml.sax.saxutils import escape
import xml.etree.ElementTree as ET

here=Path(__file__).resolve().parent
root=here.parent.parent
rows=json.loads((root/'data/android-e2e/browser-verified-20261102/daily.json').read_text())
fields=['date','brand','model','inventory','daily_sales_3d','daily_sales_7d',
 'purchase_sales_ratio_3d','purchase_sales_ratio_7d','submit_self','submit_other_bd',
 'submit_jd_recycle','submit_jd_tradein','deal_self','deal_other_bd','deal_jd_recycle',
 'deal_jd_tradein','sales_toc','sales_tob','sales_unknown','backlog_estimated',
 'delivery_days_sum','delivered_count']
ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
output=here/'安卓端到端看板数据_20261101.xlsx'
if output.exists():
 archive=here/'.archive';archive.mkdir(exist_ok=True)
 import time
 output.rename(archive/(str(time.time_ns())+'-partial.xlsx'))
with zipfile.ZipFile(here/'workbook-base.xlsx') as src, zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as dst:
 for item in src.infolist():
  if item.filename=='xl/worksheets/sheet6.xml':
   xml=src.read(item).decode()
   tree=ET.fromstring(xml)
   styles={re.sub(r'\d+','',c.attrib['r']):c.attrib.get('s')
           for c in tree.findall('m:sheetData/m:row',ns) if c.attrib['r']=='6'
           for c in c}
   match=re.search(r'<x:sheetData\b[^>]*>(.*?)</x:sheetData>',xml,re.S)
   assert match,'sheetData missing'
   header=''.join(m.group(0) for m in re.finditer(r'<x:row\b[^>]*\br="[1-5]"[^>]*>.*?</x:row>',match.group(1),re.S))
   prefix=xml[:match.start()]+'<x:sheetData>'+header
   prefix=re.sub(r'(<dimension\b[^>]*\bref=")[^"]+',r'\g<1>A1:V'+str(len(rows)+5),prefix)
   with dst.open(item.filename,'w',force_zip64=True) as stream:
    stream.write(prefix.encode())
    for number,row in enumerate(rows,6):
     cells=[]
     for ci,key in enumerate(fields):
      col=chr(65+ci); value=row.get(key)
      if value is None:continue
      ref=f'{col}{number}';style=f' s="{styles[col]}"' if styles.get(col) else ''
      if key=='date':value=(date.fromisoformat(value)-date(1899,12,30)).days
      if isinstance(value,str):
       value=re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]','',value)
       cells.append(f'<x:c r="{ref}"{style} t="inlineStr"><x:is><x:t xml:space="preserve">{escape(value)}</x:t></x:is></x:c>')
      else:cells.append(f'<x:c r="{ref}"{style}><x:v>{value}</x:v></x:c>')
     stream.write((f'<x:row r="{number}">'+''.join(cells)+'</x:row>').encode())
    stream.write(('</x:sheetData>'+xml[match.end():]).encode())
  elif item.filename=='xl/tables/table6.xml':
   xml=src.read(item).decode()
   xml=re.sub(r'\bref="A5:V\d+"',f'ref="A5:V{len(rows)+5}"',xml)
   dst.writestr(item,xml)
  else:dst.writestr(item,src.read(item))
with zipfile.ZipFile(output) as z:
 assert z.testzip() is None
 count=0;sample={}
 with z.open('xl/worksheets/sheet6.xml') as f:
  for event,e in ET.iterparse(f,events=['end']):
   if e.tag.endswith('}row'):
    ri=int(e.attrib['r'])
    if ri>=6:
     count+=1
     if ri in (6,len(rows)//2+6,len(rows)+5):
      values={re.sub(r'\d+','',c.attrib['r']):(c.find('m:v',ns).text if c.find('m:v',ns) is not None else ''.join(c.itertext())) for c in e}
      expected=rows[ri-6]
      assert values['C']==expected['model']
      if expected['inventory'] is not None:assert float(values['D'])==expected['inventory']
      sample[ri]=values['C']
    e.clear()
 assert count==len(rows),(count,len(rows))
 checks=json.loads((here/'export-checks.json').read_text())
 checks.update(output=str(output),historical_rows_verified=count,history_samples=sample,bytes=output.stat().st_size)
 (here/'export-checks.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2))
print(json.dumps({'output':str(output),'historical_rows':count,'bytes':output.stat().st_size},ensure_ascii=False))
