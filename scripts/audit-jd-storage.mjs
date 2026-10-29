// Read-only model-first API discovery. Search absence never deactivates a SKU.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {extractStorageVariants,isKnownStorage,isAllowedJdOffer} from './lib/jd-storage.mjs';
const args=process.argv.slice(2);
const arg=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
const source=arg('--source',process.cwd());
const config=JSON.parse(fs.readFileSync(arg('--config',path.join(source,'data/maishou-provider.json'))));
const db=new DatabaseSync(arg('--db',path.join(source,'data/price-workbench.sqlite')),{readOnly:true});
const catalog=db.prepare('SELECT s.id,m.name model,m.brand,s.storage FROM skus s JOIN models m ON m.id=s.model_id WHERE s.active=1 ORDER BY m.name').all();
db.close();
const models=[...new Set(catalog.map(row=>row.model))];
const out=arg('--out','data/catalog-audit');
fs.mkdirSync(out,{recursive:true});
const headers={Accept:'application/json',Referer:'https://hnbc018.kuaizhan.com/',...config.headers,'Content-Type':'application/x-www-form-urlencoded'};
async function search(keyword,page){
  for(let attempt=0;;attempt++){
    try{
      const response=await fetch('https://appapi.maishou88.com/api/v1/homepage/searchList',{
        method:'POST',headers,
        body:new URLSearchParams({isCoupon:'0',keyword,openid:config.openid,order:'desc',page:String(page),pddListId:'',sort:'',sourceType:'2',user_id:''}),
        signal:AbortSignal.timeout(25000),
      });
      if(!response.ok)throw Error(`HTTP ${response.status}`);
      const result=JSON.parse((await response.text()).replace(/^\uFEFF/,''));
      if(result.code!=null&&!['0','200'].includes(String(result.code)))throw Error(`API ${result.code}`);
      if(!Array.isArray(result.data))throw Error('Unexpected search response; absence is unverified');
      return result;
    }catch(error){if(attempt>=2)throw error;}
  }
}
let cursor=0;
async function worker(){
  while(cursor<models.length){
    const index=cursor++,model=models[index];
    const file=path.join(out,`${String(index).padStart(3,'0')}.json`);
    if(fs.existsSync(file)){
      const old=JSON.parse(fs.readFileSync(file));
      if(old.model!==model)throw Error('Output directory belongs to another catalog; use a new --out');
      continue;
    }
    const rows=catalog.filter(row=>row.model===model),variants=[],searches=[],errors=[];
    const keywords=[...new Set([model,model.replace(/\s/g,''),model.replace(/^三星\s*Galaxy\s*/,'三星 ').replace(/^努比亚\s*红魔\s*/,'红魔 ')])];
    for(const keyword of keywords){
      for(let page=1;page<=3;page++){
        try{
          const result=await search(keyword,page);
          searches.push({keyword,page,result});
          for(const offer of result.data){
            if(!isAllowedJdOffer(model,rows[0].brand,offer))continue;
            for(const storage of extractStorageVariants(model,offer.title)){
              let variant=variants.find(v=>isKnownStorage(storage,[v.storage]));
              if(!variant){variant={storage,evidence:[]};variants.push(variant);}
              if(!variant.evidence.some(e=>e.title===offer.title&&e.shop===offer.shopName)){
                variant.evidence.push({title:offer.title,shop:offer.shopName,goodsId:offer.goodsId,stableId:offer.jdGoodsIdB,sourceType:offer.sourceType,shopType:offer.shopType});
              }
            }
          }
          if(result.data.length===0)break;
        }catch(error){errors.push({keyword,page,error:error.message});break;}
      }
    }
    const existing=rows.map(row=>({id:row.id,storage:row.storage}));
    const report={model,brand:rows[0].brand,checkedAt:new Date().toISOString(),existing,found:variants,
      missing:existing.filter(row=>!variants.some(v=>isKnownStorage(v.storage,[row.storage]))),
      added:variants.filter(v=>!isKnownStorage(v.storage,existing.map(row=>row.storage))),searches,errors};
    fs.writeFileSync(file,JSON.stringify(report,null,2));
    console.log(JSON.stringify({index,model,found:variants.map(v=>v.storage),added:report.added.map(v=>v.storage),unverified:report.missing.length,errors:errors.length}));
  }
}
await Promise.all(Array.from({length:4},worker));
