import path from 'node:path';
import fs from 'node:fs';
import {DuckDBInstance} from '@duckdb/node-api';

const dataDir=path.resolve(process.env.PREVIEW_DATA_DIR || 'data/preview-20261027');
const snapshot=path.join(dataDir,'cloud-used-s-prices.json');
if(!fs.existsSync(snapshot))throw new Error('缺少只读云端 BI 快照');
const instance=await DuckDBInstance.create(path.join(dataDir,'warehouse/gtm_warehouse.duckdb'));
const c=await instance.connect();
try{
  const count=(await c.runAndReadAll('SELECT COUNT(*) FROM fact_used_s_grade_price_daily')).getRows()[0][0];
  if(Number(count)>0)console.log(JSON.stringify({skipped:true,existingRows:Number(count)}));
  else{
    await c.run(`INSERT INTO fact_used_s_grade_price_daily BY NAME SELECT * FROM read_json_auto('${snapshot.replace(/'/g,"''")}')`);
    console.log(JSON.stringify({seededRows:Number((await c.runAndReadAll('SELECT COUNT(*) FROM fact_used_s_grade_price_daily')).getRows()[0][0])}));
  }
}finally{c.closeSync();instance.closeSync();}
