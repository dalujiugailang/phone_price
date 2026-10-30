import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildSearchPlan,matchesProduct,normalizeDetail,createMaishouProvider} from './maishou-provider.mjs';

const sku={model:'华为 Mate 90 Pro',storage:'12GB+256GB',brand:'华为'};
const shop='华为京东自营旗舰店';
const detail=(extra={})=>({title:'HUAWEI Mate 90 Pro 12GB+256GB 曜石黑',shopName:shop,sourceType:2,shopType:1,tagList:['自营'],originalPrice:'6999',couponPrice:'100',actualPrice:'6999',couponConditions:'1000',couponStartTime:'2026-10-01',couponEndTime:'2026-12-31',...extra});
const response=(data)=>new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
function configDir(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gtm-maishou-test-'));fs.writeFileSync(path.join(dir,'maishou-provider.json'),JSON.stringify({inviteCode:'test-only',openid:'test-only'}));return dir;}

test('Mate 90 Pro 型号紧接 RAM 不当作型号后缀；不混入 Pro Max、其他容量或多规格标题',()=>{
  assert.equal(matchesProduct(sku,'HUAWEI Mate 90 Pro 12GB+256GB 曜石黑'),true);
  assert.equal(matchesProduct(sku,'HUAWEI Mate90Pro12GB+256GB 曜石黑'),true);
  assert.equal(matchesProduct(sku,'HUAWEI Mate 90 Pro Max 12GB+256GB'),false);
  assert.equal(matchesProduct(sku,'HUAWEI Mate 90 Pro 12GB+512GB'),false);
  assert.equal(matchesProduct(sku,'HUAWEI Mate 90 Pro 12GB+256GB / 16GB+512GB'),false);
  assert.equal(matchesProduct(sku,'HUAWEI Mate 90 Pro / Pro Max 12GB+256GB'),false);
});
test('非凡大师等版本标记可在标题前部，普通版和典藏版仍严格区分',()=>{
  assert.equal(matchesProduct({model:'华为 Mate 90 RS 非凡大师',storage:'16GB+1TB'},'华为非凡大师 HUAWEI Mate 90 RS16GB+1TB 玄黑'),true);
  assert.equal(matchesProduct({model:'华为 Mate 90 Pro Max',storage:'16GB+1TB'},'HUAWEI Mate 90 Pro Max 典藏版 16GB+1TB'),false);
  assert.equal(matchesProduct({model:'华为 Mate 90 Pro Max 典藏版',storage:'16GB+1TB'},'HUAWEI Mate 90 Pro Max 典藏版 16GB+1TB'),true);
});
test('纯数字型号与内存相邻时不合并为 RAM，仍排除错误容量和 T 版本',()=>{
  const s={model:'一加 15',storage:'16G+512G',brand:'一加'};
  assert.equal(matchesProduct(s,'一加 15 16GB+512GB 原色沙丘 oppo 第五代骁龙8至尊版'),true);
  assert.equal(matchesProduct(s,'一加15 16GB+512GB 绝对黑'),true);
  assert.equal(matchesProduct(s,'一加15 12GB+512GB 绝对黑'),false);
  assert.equal(matchesProduct(s,'一加15T 16GB+512GB 绝对黑'),false);
  assert.equal(matchesProduct(s,'一加15 16GB+512GB / 16GB+1TB'),false);
});
test('查询计划保留空格差异、紧凑词、去品牌、系列和分页兜底',()=>{
  const plan=buildSearchPlan(sku);
  assert.ok(plan.some(p=>p.keyword==='华为 Mate 90 Pro'));
  assert.ok(plan.some(p=>p.keyword==='Mate90Pro' && p.page===1));
  assert.ok(plan.some(p=>p.keyword==='Mate90Pro' && p.page===2));
  assert.ok(plan.some(p=>p.keyword==='Mate90' && p.page===3));
  assert.equal(new Set(plan.map(p=>`${p.keyword}/${p.page}`)).size,plan.length);
});
test('数字型号的品牌分页、规范容量和中英文别名兜底',()=>{
  const plan=buildSearchPlan({model:'一加 15',storage:'16G+512G'});
  assert.ok(plan.some(p=>p.keyword==='一加 15 16GB+512GB'));
  assert.ok(plan.some(p=>p.keyword==='一加 15 16+512'));
  assert.ok(plan.some(p=>p.keyword==='一加 15' && p.page===5));
  assert.ok(plan.some(p=>p.keyword==='OnePlus 15'));
  assert.ok(!plan.some(p=>p.keyword==='15'));
});
test('徕卡营销词不混同型号后缀；只标 ROM 的 SKU 可精确匹配容量',()=>{
  assert.equal(matchesProduct({model:'小米 17T',storage:'12GB+256GB'},'小米 17T 徕卡动态照片 7000mAh 幻彩白 12+256GB'),true);
  assert.equal(matchesProduct({model:'小米 17T',storage:'12GB+256GB'},'小米 17T Pro 徕卡动态照片 12+256GB'),false);
  const s={model:'华为 畅享90 Plus',storage:'128GB'};
  assert.equal(matchesProduct(s,'华为畅享 90 Plus 128GB星空黑 麒麟8系芯片'),true);
  assert.equal(matchesProduct(s,'华为畅享90 Plus 256GB星空黑'),false);
  assert.equal(matchesProduct({model:'华为 nova 15 Pro',storage:'12GB+256GB'},'华为 nova 15 Pro 256GB 幻夜黑'),false);
  assert.equal(matchesProduct({model:'华为 nova 15 Pro',storage:'12GB+256GB'},'华为 nova 15 Pro 12GB+256GB 昆仑玻璃',[{model:'华为 nova 15 Pro',storage:'12GB+256GB 昆仑玻璃版'}]),false);
  assert.equal(matchesProduct({model:'华为 nova 15 Pro',storage:'12GB+256GB 昆仑玻璃版'},'华为 nova 15 Pro 12GB+256GB 昆仑玻璃'),true);
  assert.equal(matchesProduct({model:'华为 Mate 90 Pro Max',storage:'12GB+512GB'},'HUAWEI Mate 90 Pro Max 12GB+512GB 曜石黑 全昆仑玄武架构'),true);
  assert.equal(matchesProduct({model:'三星 Galaxy S25',storage:'12GB+512GB'},'三星 Galaxy S25 Edge 12GB+512GB'),false);
});
test('容量与 5G 网络标记不连读，高定款与高定版为同一版本',()=>{
  assert.equal(matchesProduct({model:'小米 17 Ultra 徕卡版',storage:'16GB+512GB'},'小米 17 Ultra 徕卡版 黑银色 16+512 5G手机'),true);
  assert.equal(matchesProduct({model:'小米 17 Ultra 徕卡版',storage:'16GB+512GB'},'小米 17 Ultra 徕卡版 黑银色 16+256 5G手机'),false);
  const s={model:'荣耀 Magic V Flip2',storage:'16GB+1TB 高定版'};
  assert.equal(matchesProduct(s,'荣耀Magic V Flip2 高定款 小折叠屏 16+1T织梦蓝 5G手机'),true);
  assert.equal(matchesProduct({...s,storage:'16GB+1TB'},'荣耀Magic V Flip2 高定款 16+1T织梦蓝'),false);
  assert.equal(matchesProduct({model:'三星 Galaxy S26+',storage:'12GB+512GB'},'三星 Galaxy S26 Plus 12GB+512GB'),true);
});
test('型号名兜底仍排除另一系列和广告文案中的旧机型',()=>{
  assert.equal(matchesProduct({model:'小米 17',brand:'小米',storage:'12GB+256GB'},'小米 REDMI Note17 12GB+256GB',['小米 17','REDMI Note 17']),false);
  assert.equal(matchesProduct({model:'REDMI Note 15 Pro',brand:'小米',storage:'12GB+256GB'},'小米 REDMI Note17 Pro 12+256 黑 红米note15pro新款',['REDMI Note 17 Pro','REDMI Note 15 Pro']),false);
  assert.equal(matchesProduct({model:'小米 17',brand:'小米',storage:'12GB+256GB'},'小米17 12GB+256GB 白色',['小米 17','REDMI Note 17']),true);
});
test('同规格优先选价券校验通过的颜色，不让更低但矛盾的接口价优先',async()=>{
  const provider=createMaishouProvider({dataDir:configDir(),fetchImpl:async(url,options)=>{
    if(url.includes('searchList'))return response({code:200,data:[{goodsId:'bad',title:detail().title,shopName:shop,actualPrice:'6000'},{goodsId:'good',title:detail().title,shopName:shop,actualPrice:'6999'}]});
    const id=JSON.parse(options.body).goodsId;
    return response({data:url.includes('getTargetUrl')?{appUrl:`https://item.jd.com/${id}.html`}:detail({actualPrice:id==='bad'?'6000':'6999',originalPrice:'6999',couponPrice:'0'})});
  }});
  const r=await provider.collect(sku,'2026-10-27');assert.equal(r.quote.goodsId,'good');
  assert.equal(r.raw.details.length,2);
});
test('放宽查询词时仍按品牌店铺过滤，不把同编号的其他品牌报价混入',()=>{
  const normalized=normalizeDetail(detail({title:'Xiaomi 17 Pro 12GB+256GB'}),'https://item.jd.com/1.html',{model:'小米 17 Pro',storage:'12GB+256GB',brand:'小米'},'2026-10-27');
  assert.equal(normalized.quote.matched,false);assert.ok(normalized.rejected.includes('店铺不属于该品牌指定自营店'));
});
test('商品规格已确认但券额缺失时保留挂牌，未知字段不补零、不反推券额',()=>{
  const r=normalizeDetail(detail({couponPrice:'',actualPrice:'6000'}),'https://item.jd.com/1.html',sku,'2026-10-28');
  assert.equal(r.quote.matched,true);assert.equal(r.quote.list,699900);assert.equal(r.quote.coupon,null);
  const invalid=normalizeDetail(detail({originalPrice:'错误',couponPrice:'100'}),'https://item.jd.com/1.html',sku,'2026-10-28');
  assert.equal(invalid.quote.list,null);assert.equal(invalid.quote.coupon,10000);
});
test('第一页无结果时继续兜底到第二页，保留搜索与排除轨迹，批次缓存不会跨任务复用',async()=>{
  let searchCalls=0;
  const fetchImpl=async(url,options)=>{
    if(url.includes('searchList')){
      searchCalls++;const params=new URLSearchParams(options.body);
      const items=params.get('keyword')==='Mate90Pro' && params.get('page')==='2'?[{goodsId:'good',title:detail().title,shopName:shop,actualPrice:'6999'},{goodsId:'third-party',title:detail().title,shopName:'其他店铺',actualPrice:'6000'}]:[];
      return response({code:200,data:items});
    }
    return response({data:url.includes('getTargetUrl')?{appUrl:'https://item.jd.com/1.html'}:detail()});
  };
  const provider=createMaishouProvider({dataDir:configDir(),fetchImpl}),events=[];
  const result=await provider.collect(sku,'2026-10-27',[],e=>events.push(e));
  assert.equal(result.quote.matched,true);assert.equal(result.quote.keyword,'Mate90Pro');assert.equal(result.quote.page,2);
  assert.ok(events.some(e=>e.stage==='search_result' && e.page===2));
  assert.ok(result.raw.rejections.some(r=>r.goodsId==='third-party' && r.stage==='search'));
  const calls=searchCalls,reused=await provider.collect(sku,'2026-10-27');assert.equal(searchCalls,calls);
  assert.equal(reused.quote.fetchedAt,result.quote.fetchedAt);assert.ok(reused.raw.steps.some(e=>e.stage==='detail_result' && e.cacheHit));
  provider.beginRun();await provider.collect(sku,'2026-10-27');assert.equal(searchCalls,2*calls);
});
test('搜索有候选但详情被否决时不会提前终止其他查询词',async()=>{
  const provider=createMaishouProvider({dataDir:configDir(),fetchImpl:async(url,options)=>{
    if(url.includes('searchList')){
      const keyword=new URLSearchParams(options.body).get('keyword');
      return response({code:200,data:[{goodsId:keyword===sku.model?'good':'bad',title:detail().title,shopName:shop,actualPrice:'6999'}]});
    }
    const id=JSON.parse(options.body).goodsId;
    return response({data:url.includes('getTargetUrl')?{appUrl:`https://item.jd.com/${id}.html`}:detail({shopType:id==='bad'?0:1})});
  }});
  const result=await provider.collect(sku,'2026-10-27');assert.equal(result.quote.matched,true);assert.equal(result.quote.goodsId,'good');
  assert.ok(result.raw.rejections.some(r=>r.stage==='detail' && r.goodsId==='bad'));
  assert.ok(result.raw.searches.length>1);
});
test('接口异常带回此前搜索轨迹，不能伪装成无货或空搜索结果',async()=>{
  const provider=createMaishouProvider({dataDir:configDir(),fetchImpl:async()=>new Response('limit',{status:429})});
  await assert.rejects(()=>provider.collect(sku,'2026-10-27'),e=>e.collectionTrace.steps[0].keyword===`${sku.model} ${sku.storage}` && /429/.test(e.message));
});
test('一个详情失败不阻断其他候选，全部详情失败仍作为接口失败重试',async()=>{
  const make=(allFail)=>createMaishouProvider({dataDir:configDir(),fetchImpl:async(url,options)=>{
    if(url.includes('searchList'))return response({code:200,data:[{goodsId:'bad',title:detail().title,shopName:shop,actualPrice:'6000'},{goodsId:'good',title:detail().title,shopName:shop,actualPrice:'6999'}]});
    const id=JSON.parse(options.body).goodsId;
    if(allFail || id==='bad')return new Response('temporary',{status:503});
    return response({data:url.includes('getTargetUrl')?{appUrl:'https://item.jd.com/good.html'}:detail({couponPrice:'0',actualPrice:'6999'})});
  }});
  const r=await make(false).collect(sku,'2026-10-28');
  assert.equal(r.quote.goodsId,'good');assert.equal(r.raw.detailErrors.length,1);
  await assert.rejects(()=>make(true).collect(sku,'2026-10-28'),e=>/详情请求失败/.test(e.message) && e.collectionTrace.detailErrors.length===2);
});
test('动态加密 ID 不重复占用详情名额，稳定 ID 相同但价格不同仍继续核对',async()=>{
  let searches=0,details=0;
  const p=createMaishouProvider({dataDir:configDir(),fetchImpl:async(url,options)=>{
    if(url.includes('searchList')){
      searches++;const keyword=new URLSearchParams(options.body).get('keyword');
      const bad={goodsId:`bad-${searches}`,jdGoodsIdB:'stable-product',title:detail().title,shopName:shop,actualPrice:'6000'};
      return response({code:200,data:keyword===sku.model?[bad,{...bad,goodsId:'good',actualPrice:'6999'}]:[bad]});
    }
    const id=JSON.parse(options.body).goodsId;
    if(url.includes('getTargetUrl'))return response({data:{appUrl:`https://item.jd.com/${id}.html`}});
    details++;return response({data:detail({couponPrice:'0',actualPrice:id==='good'?'6999':'6000'})});
  }});
  const r=await p.collect(sku,'2026-10-28');assert.equal(r.quote.goodsId,'good');assert.equal(details,2);assert.ok(searches>=3);
});

test('优先复用历史商品 ID，每次重取价格，有效时完全跳过 search',async()=>{
  let searches=0,details=0;
  const p=createMaishouProvider({dataDir:configDir(),fetchImpl:async(url)=>{
    if(url.includes('searchList')){searches++;return response({data:[]});}
    if(url.includes('getTargetUrl'))return response({data:{appUrl:'https://item.jd.com/saved.html'}});
    details++;return response({data:detail({originalPrice:String(6999+details),couponPrice:'0',actualPrice:String(6999+details),isOnline:0})});
  }});
  const saved={...sku,previousQuote:{matched:true,goodsId:'saved',link:'https://item.jd.com/old.html',list:1,coupon:0,actual:1}};
  const first=await p.collect(saved,'2026-10-28'),second=await p.collect(saved,'2026-10-28');
  assert.equal(searches,0);assert.equal(details,2);assert.equal(first.quote.list,700000);assert.equal(second.quote.list,700100);
  assert.equal(first.raw.summary.fastPath,true);assert.equal(first.raw.summary.searches,0);
  assert.ok(first.raw.steps.some(e=>e.stage==='previous_link_result' && e.accepted));
});
test('旧 ID 失效、下架、规格/店铺变化、链接失败或价券异常时自动重新 search',async()=>{
  for(const mode of ['expired','offline','spec','shop','link','price']){
    let searches=0;
    const p=createMaishouProvider({dataDir:configDir(),fetchImpl:async(url,options)=>{
      if(url.includes('searchList')){searches++;return response({data:[{goodsId:'new',title:detail().title,shopName:shop,actualPrice:'6999'}]});}
      const old=JSON.parse(options.body).goodsId==='saved';
      if(old && mode==='expired')return new Response('expired',{status:404});
      if(url.includes('getTargetUrl'))return response({data:old && mode==='link'?{}:{appUrl:'https://item.jd.com/new.html'}});
      return response({data:detail({couponPrice:'0',actualPrice:'6999',...(old?{title:mode==='spec'?'HUAWEI Mate 90 Pro 16GB+512GB':detail().title,shopName:mode==='shop'?'其他店铺':shop,couponPrice:mode==='price'?'100':'0',...(mode==='offline'?{originalPrice:'',couponPrice:'',actualPrice:''}:{})}:{})})});
    }});
    const r=await p.collect({...sku,previousQuote:{matched:true,goodsId:'saved',link:'https://item.jd.com/old.html'}},'2026-10-28');
    assert.ok(searches>0,mode);assert.equal(r.quote.goodsId,'new',mode);assert.equal(r.quote.matched,true,mode);
    assert.ok(r.raw.steps.some(e=>e.stage==='previous_link_result' && !e.accepted),mode);
  }
});

test('人工链接只查该链接并严格校验规格，价差保留待核验且不搜索其他商品',async()=>{
  const calls=[];const provider=createMaishouProvider({dataDir:configDir(),fetchImpl:async(url,options)=>{
    calls.push({url,body:options.body});
    if(url.includes('searchList'))return response({code:200,data:[{goodsId:'linked-id'}]});
    if(url.includes('goods/detail'))return response({code:200,data:detail()});
    return response({code:200,data:{appUrl:'https://item.jd.com/123.html'}});
  }});
  const result=await provider.collect({...sku,manualProductLink:'https://item.jd.com/123.html',manualLinkOnly:true},'2026-10-28');
  assert.equal(result.quote.matched,true);assert.equal(result.quote.keyword,'人工补充商品链接');assert.equal(result.quote.list,699900);
  assert.equal(calls.filter(c=>c.url.includes('searchList')).length,1);
  assert.ok(String(calls[0].body).includes(encodeURIComponent('https://item.jd.com/123.html')));
});

test('错误容量的人工链接不采纳，不回退成其他商品的成功结果',async()=>{
  const provider=createMaishouProvider({dataDir:configDir(),fetchImpl:async(url)=>{
    if(url.includes('searchList'))return response({code:200,data:[{goodsId:'wrong'}]});
    if(url.includes('goods/detail'))return response({code:200,data:detail({title:'华为 Mate 90 Pro 16GB+512GB'})});
    return response({code:200,data:{appUrl:'https://item.jd.com/999.html'}});
  }});
  await assert.rejects(provider.collect({...sku,manualProductLink:'https://item.jd.com/999.html',manualLinkOnly:true},'2026-10-28'),/链接未返回符合/);
});
