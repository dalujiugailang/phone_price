import {resolveVerifiedRomOnlySpec} from './verified-rom-matching.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {canonical, cents, STORES, validateQuote} from './price-workbench.mjs';

const PREFIX=/^(?:小米|xiaomi|redmi|红米|荣耀|honor|华为|huawei|三星|samsung|galaxy|努比亚|nubia|红魔|redmagic|oppo|vivo|iqoo|一加|oneplus|真我|realme|摩托罗拉|motorola|moto)/i;
const EDITIONS=['特别版','冠军版','典藏版','焕新版','元气版','超级版','超能版','高定版','风驰版','徕卡版','非凡大师','保时捷设计'];
const withoutEditions=(s)=>EDITIONS.reduce((text,tag)=>text.replaceAll(tag,''),s);
const normalizeTitle=(s)=>String(s).normalize('NFKC').replaceAll('高定款','高定版').replace(/\b(pro|s\d{2,})\s*plus\b/gi,'$1+');
// goodsId carries changing request encryption. jdGoodsIdB is stable across observed searches.
// Keep title/shop/prices in the key so a different variant or changed offer is never collapsed.
const candidateIdentity=(g)=>g.jdGoodsIdB?JSON.stringify([g.jdGoodsIdB,canonical(g.title),g.shopName,g.originalPrice ?? null,g.couponPrice ?? null,g.actualPrice ?? null]):String(g.goodsId);
const BRAND_STORES=[[/^(?:小米|redmi|红米|xiaomi)/i,['小米京东自营旗舰店']],[/^(?:华为|huawei)/i,['华为京东自营旗舰店']],[/^(?:荣耀|honor)/i,['荣耀京东自营旗舰店']],[/^(?:oppo)/i,['OPPO京东自营旗舰店']],[/^(?:一加|oneplus)/i,['一加手机京东自营旗舰店']],[/^(?:真我|realme)/i,['真我realme京东自营旗舰店']],[/^(?:vivo)/i,['vivo京东自营旗舰店']],[/^(?:iqoo)/i,['iQOO京东自营旗舰店']],[/^(?:三星|samsung)/i,['三星京东自营官方旗舰店']],[/^(?:努比亚|nubia|红魔|redmagic)/i,['努比亚京东自营旗舰店','红魔京东自营旗舰店']],[/^(?:摩托罗拉|motorola|moto|联想)/i,['联想moto手机京东自营旗舰店']],[/^(?:魅族|meizu)/i,['魅族京东自营旗舰店']],[/^(?:中兴|zte)/i,['中兴京东自营旗舰店']]];
function allowedShop(sku,shop){
  if(!STORES.includes(shop))return false;
  const rule=BRAND_STORES.find(([pattern])=>pattern.test(sku.brand || '')) || BRAND_STORES.find(([pattern])=>pattern.test(sku.model));
  return !rule || rule[1].includes(shop);
}
function modelToken(value) {
  let s=canonical(value);
  while(PREFIX.test(s))s=s.replace(PREFIX,'');
  return s;
}
export function matchesProduct(sku,title,catalog=[]) {
  title=normalizeTitle(title);
  const verifiedRomOnlySpec=resolveVerifiedRomOnlySpec(sku,title,catalog);
  const original=canonical(title),text=withoutEditions(original),token=withoutEditions(modelToken(normalizeTitle(sku.model)));
  if(/pro\s*[/／]\s*(?:pro|max)/i.test(title))return false;
  for(const tag of EDITIONS)if(canonical(sku.model+sku.storage).includes(tag)!==original.includes(tag))return false;
  if(!token || !text.includes(token))return false;
  const suffix=text.slice(text.indexOf(token)+token.length);
  if(/^(?:pro|max|ultra|mini|air|edge|plus|turbo|rsr|rs|rt|至尊|典藏|风驰|非凡|高定|焕新|特别|冠军|元气|超级|超能|\+|(?:se|[set])(?=[^a-z]|$))/.test(suffix))return false;
  // Removing whitespace joins "Pro 16GB+512GB" into "pro16gb+512gb".
  // A real RAM+ROM pair is not another model-number suffix.
  if(/^\d/.test(suffix) && !verifiedRomOnlySpec && !/^\d+(?:gb|g)?\+\d/.test(suffix) && !(/^\d+(?:tb|t|gb|g)$/.test(canonical(sku.storage)) && /^\d+(?:tb|t|gb|g)/.test(suffix)))return false;
  const brandRule=(name)=>BRAND_STORES.find(([pattern])=>pattern.test(name))?.[1]?.[0];
  const ownBrand=brandRule(sku.brand || '') || brandRule(sku.model),modelIndex=text.indexOf(token);
  for(const item of catalog){
    const name=typeof item==='string'?item:item.model || item.name || '';
    const other=withoutEditions(modelToken(normalizeTitle(name))),otherIndex=text.indexOf(other);
    if(!other || other===token || otherIndex<0)continue;
    if(other.length>token.length && other.includes(token) && otherIndex<=modelIndex)return false;
    // A previous-generation name in promotional copy must not override the first model in the title.
    if(ownBrand && brandRule(name)===ownBrand && otherIndex<modelIndex)return false;
  }
  const storage=canonical(sku.storage).match(/^(\d+)(?:gb|g)?\+(\d+)(tb|t|gb|g)/);
  const romOnly=canonical(sku.storage).match(/^(\d+)(tb|t|gb|g)$/);
  if(!storage && !romOnly)return false;
  const ram=storage?Number(storage[1]):null,rom=storage?Number(storage[2])*(/^t/.test(storage[3])?1024:1):Number(romOnly[1])*(/^t/.test(romOnly[2])?1024:1);
  const glassVariants=catalog.some(c=>typeof c==='object' && canonical(c.model || c.name)===canonical(sku.model) && /昆仑玻璃|玄武钢化/.test(c.storage || ''));
  for(const tag of ['昆仑玻璃','玄武钢化']){
    const required=canonical(sku.storage).includes(tag),present=original.includes(tag) || Boolean(verifiedRomOnlySpec?.glass.includes(tag));
    if(required && !present || glassVariants && required!==present)return false;
  }
  // Separate the model number from RAM after whitespace normalization (15 16GB -> 1516GB).
  const modelPattern=[...token].map(c=>c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('\\s*');
  // Preserve spaces between capacity and network labels: "16+512 5G" is not "16+5125G".
  const specText=withoutEditions(title.toLowerCase()).replace(new RegExp(modelPattern,'i'),' ').replace(/\s*\+\s*/g,'+');
  const pairs=[...specText.matchAll(/(\d+)\s*(?:gb|g)?\+(\d+)\s*(tb|t|gb|g)?/g)];
  if(ram===null){
    if(pairs.length)return new Set(pairs.map(m=>Number(m[2])*(/^t/.test(m[3] || '')?1024:1))).size===1 && pairs.every(m=>Number(m[2])*(/^t/.test(m[3] || '')?1024:1)===rom);
    const capacities=[...specText.matchAll(/(\d+)(tb|t|gb|g)(?![a-z])/g)].map(m=>Number(m[1])*(/^t/.test(m[2])?1024:1)).filter(n=>[64,128,256,512,1024,2048].includes(n));
    return capacities.length>0 && capacities.every(n=>n===rom);
  }
  if(!pairs.length && verifiedRomOnlySpec)return true;
  if(new Set(pairs.map(m=>`${Number(m[1])}:${Number(m[2])*(/^t/.test(m[3] || '')?1024:1)}`)).size!==1)return false;
  return pairs.some(m=>Number(m[1])===ram && Number(m[2])*(/^t/.test(m[3] || '')?1024:1)===rom);
}
export function buildSearchPlan(sku){
  const model=String(sku.model).normalize('NFKC').trim().replace(/\s+/g,' ');
  const compact=model.replace(/\s+/g,'');let stripped=compact;
  while(PREFIX.test(stripped))stripped=stripped.replace(PREFIX,'');
  const base=withoutEditions(stripped),family=base.match(/^.*?\d+/)?.[0];
  const memory=canonical(sku.storage).match(/^(\d+)(?:gb|g)?\+(\d+)(tb|t|gb|g)/);
  const short=memory?`${memory[1]}+${memory[2]}${/^t/.test(memory[3])?'T':''}`:sku.storage;
  const full=memory?`${memory[1]}GB+${memory[2]}${/^t/.test(memory[3])?'TB':'GB'}`:sku.storage;
  const variants=[model,compact];
  const aliases=[[/^小米/i,'Xiaomi '],[/^REDMI/i,'红米 '],[/^华为/i,'HUAWEI '],[/^荣耀/i,'HONOR '],[/^一加/i,'OnePlus '],[/^真我/i,'realme '],[/^三星\s*Galaxy/i,'三星'],[/^三星/i,'Samsung '],[/^努比亚\s*红魔/i,'红魔']];
  for(const [pattern,prefix] of aliases)if(pattern.test(model))variants.push(model.replace(pattern,prefix).replace(/\s+/g,' ').trim());
  const plans=[],seen=new Set();
  const add=(keyword,page)=>{if(!keyword || /^\d+$/.test(keyword))return;const key=`${keyword}/${page}`;if(!seen.has(key)){seen.add(key);plans.push({keyword,page});}};
  add(`${model} ${full}`,1);add(`${model} ${short}`,1);
  if(memory)add(`${model} ${memory[2]}${/^t/.test(memory[3])?'TB':'GB'}`,1);
  for(const keyword of variants)add(keyword,1);
  if(!/^\d+$/.test(base)){add(stripped,1);add(base,1);add(`${base} ${short}`,1);add(family,1);}
  // Keep the brand in paginated fallbacks, especially numeric models such as 一加15/iQOO15.
  const paged=new Set([`${model} ${short}`,model,compact,...variants.slice(2),...(!/^\d+$/.test(base)?[stripped,base,family]:[])]);
  for(const page of [2,3,4,5])for(const keyword of paged)add(keyword,page);
  return plans;
}
export function normalizeDetail(detail,link,sku,date,catalog=[]) {
  const title=detail.title || '';
  const rejected=[];
  if(String(detail.sourceType)!=='2' || String(detail.shopType)!=='1' || !detail.tagList?.includes('自营'))rejected.push('缺少京东自营依据');
  if(!allowedShop(sku,detail.shopName))rejected.push('店铺不属于该品牌指定自营店');
  if(/二手|成新|拆封|租赁|合约|保护壳|手机壳|贴膜|定金|套装|礼盒|服务包|赠话费|企业|教育优惠|防爆|套餐|分身|补贴版|移动补贴|联通补贴|电信补贴/.test(title))rejected.push('商品类型不合格');
  if(!matchesProduct(sku,title,catalog))rejected.push('型号、容量或特殊版本不符');
  if(!/^https?:\/\//i.test(link || ''))rejected.push('缺少可打开的商品链接');
  const amount=(value)=>{try{return cents(value);}catch{return null;}};
  const list=amount(detail.originalPrice),coupon=amount(detail.couponPrice),actual=amount(detail.actualPrice),threshold=amount(detail.couponConditions);
  // Identity/source matching is separate from price validation: keep known cells when one field is missing.
  // validateQuote gates publication; unknown amounts stay null, never inferred from actualPrice.
  return {rejected,quote:{matched:rejected.length===0,date,list,coupon,actual,threshold,title,shop:detail.shopName || '',link:link || '',goodsId:detail.goodsId || '',start:detail.couponStartTime || '',end:detail.couponEndTime || '',tags:detail.tagList || [],matchEvidence:`sourceType=${detail.sourceType}; shopType=${detail.shopType}; 自营标签${resolveVerifiedRomOnlySpec(sku,title,catalog) ? "; 官方规格唯一对应="+resolveVerifiedRomOnlySpec(sku,title,catalog).source : ""}`,keyword:`${sku.model} ${sku.storage}`}};
}
export function createMaishouProvider({dataDir,fetchImpl=fetch}={}) {
  const file=path.join(dataDir,'maishou-provider.json');
  const config=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
  const inviteCode=process.env.MAISHOU_INVITE_CODE || config.inviteCode;
  const openid=process.env.MAISHOU_OPENID || config.openid;
  const headers={Accept:'application/json',Referer:'https://hnbc018.kuaizhan.com/',...(config.headers || {}),...JSON.parse(process.env.MAISHOU_HEADERS_JSON || '{}')};
  async function request(url,body,form=false) {
    const response=await fetchImpl(url,{method:'POST',headers:{...headers,'Content-Type':form?'application/x-www-form-urlencoded':'application/json'},body:form?new URLSearchParams(body):JSON.stringify(body),signal:AbortSignal.timeout(25000)});
    if(!response.ok)throw new Error(`采价接口 HTTP ${response.status}`);
    const text=(await response.text()).replace(/^\uFEFF/,'');
    try{return JSON.parse(text);}catch{throw new Error('采价接口返回非 JSON 数据');}
  }
  const searchCache=new Map(),detailCache=new Map();
  function cachedDetail(key,load){if(!detailCache.has(key)){const promise=load().then(value=>({value,fetchedAt:new Date().toISOString()}));detailCache.set(key,promise);promise.catch(()=>detailCache.delete(key));}return detailCache.get(key);}
  return {configured:Boolean(inviteCode && openid),beginRun(){searchCache.clear();detailCache.clear();},async collect(sku,date,catalog=[],onTrace=()=>{}) {
    const raw={algorithmVersion:'20261029-verified-rom-v1',searches:[],details:[],detailErrors:[],rejections:[],steps:[],summary:null},seen=new Set(),good=[];
    const maxDetails=24;
    const trace=(step)=>{const event={...step,at:new Date().toISOString()};raw.steps.push(event);onTrace(event);};
    async function inspectCandidate(g,keyword,page,identity,direct=false){
      const params={goodsId:String(g.goodsId),sourceType:'2',inviteCode,supplierCode:'',activityId:'',isShare:'1',token:''};
      const detailCacheHit=!direct && detailCache.has(`detail/${identity}`);
      const getDetail=()=>request('https://appapi.maishou88.com/api/v3/goods/detail',{...params,keyword:'',usageScene:5});
      const responseEntry=direct?{value:await getDetail(),fetchedAt:new Date().toISOString()}:await cachedDetail(`detail/${identity}`,getDetail);
      const response=responseEntry.value;
      if(response.code!=null && !['0','200'].includes(String(response.code)))throw new Error(`商品详情接口业务错误：${String(response.code)}`);
      const getLink=()=>request('https://msapi.maishou88.com/api/v1/share/getTargetUrl',{...params,isDirectDetail:0});
      const target=direct?await getLink():(await cachedDetail(`link/${identity}`,getLink)).value;
      raw.details.push({keyword,page,direct,goodsId:g.goodsId,detail:response,target});
      if(!response.data || typeof response.data!=='object' || Array.isArray(response.data))throw new Error('商品详情缺失或接口结构变化');
      const detail={...response.data,goodsId:g.goodsId};
      const normalized=normalizeDetail(detail,target.data?.appUrl || target.data?.schemaUrl,sku,date,catalog);
      normalized.quote.keyword=keyword;normalized.quote.page=page;normalized.quote.fetchedAt=responseEntry.fetchedAt;
      trace({stage:'detail_result',keyword,page,goodsId:g.goodsId,title:detail.title,shop:detail.shopName,cacheHit:detailCacheHit,fetchedAt:responseEntry.fetchedAt,direct,accepted:!normalized.rejected.length,reasons:normalized.rejected});
      if(normalized.rejected.length)raw.rejections.push({stage:'detail',keyword,page,goodsId:g.goodsId,reasons:normalized.rejected});else good.push(normalized.quote);
      return normalized;
    }
    try{
      if(sku.manualProductLink){
        try{
          trace({stage:'manual_link_started',link:sku.manualProductLink});
          const response=await request('https://appapi.maishou88.com/api/v1/homepage/searchList',{isCoupon:'0',keyword:sku.manualProductLink,openid,order:'desc',page:'1',pddListId:'',sort:'',sourceType:'2',user_id:''},true);
          if(response.code!=null && !['0','200'].includes(String(response.code)))throw new Error(`链接查询接口错误：${response.code}`);
          const candidates=Array.isArray(response.data)?response.data:[];
          raw.searches.push({keyword:sku.manualProductLink,page:1,response});
          for(const g of candidates.slice(0,8)){
            const result=await inspectCandidate(g,'人工补充商品链接',1,candidateIdentity(g),true);
            if(!result.rejected.length){
              result.quote.submittedLink=sku.manualProductLink;
              raw.summary={manualLink:true,searches:1,details:raw.details.length,accepted:1,rejected:raw.rejections.length};
              return {quote:result.quote,raw};
            }
          }
          throw new Error('链接未返回符合该型号、存储版本及指定京东自营店铺的商品');
        }catch(e){trace({stage:'manual_link_failed',message:String(e.message)});if(sku.manualLinkOnly)throw e;}
      }
      const previous=sku.previousQuote;
      if(previous?.matched && previous.goodsId){
        trace({stage:'previous_link_started',goodsId:previous.goodsId,link:previous.link,previousFetchedAt:previous.fetchedAt || null});
        try{
          const result=await inspectCandidate({goodsId:previous.goodsId},'上次匹配商品',0,`previous/${previous.goodsId}`,true);
          const issues=result.rejected.length?result.rejected:validateQuote(result.quote).map(i=>i.message);
          trace({stage:'previous_link_result',goodsId:previous.goodsId,accepted:issues.length===0,reasons:issues});
          if(!issues.length){raw.summary={fastPath:true,searches:0,details:1,detailErrors:0,accepted:1,rejected:0,keywords:[]};return {quote:result.quote,raw};}
        }catch(e){
          raw.previousLinkError=String(e.message);
          trace({stage:'previous_link_result',goodsId:previous.goodsId,accepted:false,reasons:[String(e.message)]});
        }
      }
      for(const {keyword,page} of buildSearchPlan(sku)){
        const key=`${keyword}/${page}`,cached=searchCache.get(key),cacheHit=Boolean(cached && cached.expires>Date.now());
        trace({stage:'search_started',keyword,page,cacheHit});
        if(!cacheHit){
          const promise=request('https://appapi.maishou88.com/api/v1/homepage/searchList',{isCoupon:'0',keyword,openid,order:'desc',page:String(page),pddListId:'',sort:'',sourceType:'2',user_id:''},true);
          searchCache.set(key,{promise,expires:Date.now()+120000});
          promise.catch(()=>searchCache.delete(key));
        }
        const result=await searchCache.get(key).promise;
        raw.searches.push({keyword,page,cacheHit,result});
        if(result.code!=null && !['0','200'].includes(String(result.code))){searchCache.delete(key);throw new Error(`搜索接口业务错误：${String(result.code)}`);}
        if(result.data!==undefined && !Array.isArray(result.data))throw new Error('搜索响应结构变化，暂停该 SKU 自动处理');
        if(!result.data && result.message && !/暂无|没有|无结果|未找到|成功|success|no\s*(?:result|data)/i.test(result.message))throw new Error(`搜索接口：${String(result.message).slice(0,120)}`);
        const candidates=[];let storeRejected=0,specRejected=0;
        for(const g of result.data || []){
          const reasons=[];
          if(!allowedShop(sku,g.shopName)){reasons.push('店铺不属于该品牌指定自营店');storeRejected++;}
          if(!matchesProduct(sku,g.title || '',catalog)){reasons.push('型号、容量或特殊版本不符');specRejected++;}
          if(!g.goodsId)reasons.push('缺少商品 ID');
          if(reasons.length)raw.rejections.push({stage:'search',keyword,page,goodsId:g.goodsId,title:g.title,shop:g.shopName,reasons});
          else if(!seen.has(candidateIdentity(g)) && !candidates.some(c=>candidateIdentity(c)===candidateIdentity(g)))candidates.push(g);
        }
        trace({stage:'search_result',keyword,page,returned:result.data?.length || 0,eligible:candidates.length,storeRejected,specRejected,cacheHit});
        candidates.sort((a,b)=>Number(a.actualPrice ?? Infinity)-Number(b.actualPrice ?? Infinity));
        for(const g of candidates.slice(0,Math.min(8,maxDetails-seen.size))){
          const identity=candidateIdentity(g);seen.add(identity);
          try {
          await inspectCandidate(g,keyword,page,identity);
          } catch(e) {
            const error={stage:'detail_error',keyword,page,goodsId:g.goodsId,message:String(e.message)};
            raw.detailErrors.push(error);trace(error);
          }
        }
        if(good.some(q=>validateQuote(q).length===0) || seen.size>=maxDetails)break;
      }
      const quality=(q)=>(q.list>0 && q.coupon!==null && q.actual>0?0:100)+validateQuote(q).length;
      good.sort((a,b)=>quality(a)-quality(b) || (a.list-a.coupon)-(b.list-b.coupon) || a.actual-b.actual);
      const rejectionCounts={};for(const r of raw.rejections)for(const reason of r.reasons)rejectionCounts[reason]=(rejectionCounts[reason] || 0)+1;
      raw.summary={searches:raw.searches.length,details:raw.details.length,detailErrors:raw.detailErrors.length,accepted:good.length,rejected:raw.rejections.length,rejectionCounts,detailLimitReached:!good.length && seen.size>=maxDetails,keywords:raw.searches.map(r=>`${r.keyword} [第${r.page}页]`)};
      if(!good.length && raw.detailErrors.length)throw new Error(`部分候选详情请求失败，尚不能确认无合格报价：${raw.detailErrors[0].message}`);
      const why=Object.entries(rejectionCounts).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([reason])=>reason).join('、');
      return {quote:good[0] || {matched:false,date,list:null,coupon:null,actual:null,keyword:`${sku.model} ${sku.storage}`,reason:`已检索 ${raw.searches.length} 次、核对 ${raw.details.length} 个详情；${raw.summary.detailLimitReached?'达到详情查询上限':why || '接口未返回候选商品'}。本次未取得合格同规格报价，不代表停售`},raw};
    }catch(e){e.collectionTrace=raw;throw e;}
  }};
}
