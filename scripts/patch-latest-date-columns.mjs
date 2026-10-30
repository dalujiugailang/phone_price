import fs from 'node:fs';
const file=process.argv[2];let s=fs.readFileSync(file,'utf8');
const anchor="  const latestDate = dates.at(-1) ?? '--';";
if(!s.includes(anchor))throw Error('Latest date anchor changed');
const columns=(s.match(/\{dates\.map\(\(date\) =>/g)||[]).length;
if(columns!==7)throw Error('Expected seven table header/body renderers, found '+columns);
s=s.replace(anchor,"  const displayDates = useMemo(() => [...dates].reverse(), [dates]);\n"+anchor);
s=s.replaceAll('{dates.map((date) =>','{displayDates.map((date) =>');
fs.writeFileSync(file,s);console.log('Reversed date columns in both summary tables and SKU detail; analysis dates unchanged');
