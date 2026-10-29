// Narrow manufacturer-backed identity rules, never a general relaxation of RAM matching.
const canonical=value=>String(value??'').normalize('NFKC').replace(/\s+/g,'').toLowerCase();
const modelKey=value=>canonical(value).replace(/^(?:华为|huawei)/,'');
const capacities=new Set([64,128,256,512,1024,2048]);
function storageParts(value){
  const match=canonical(value).match(/^(\d+)(?:gb|g)?\+(\d+)(tb|t|gb|g)(.*)$/);
  return match?{ram:+match[1],rom:+match[2]*(/^t/.test(match[3])?1024:1),edition:match[4]}:null;
}
const rules=[
  {model:'nova15',ram:12,rom:256,glass:'',source:'https://consumer.huawei.com/cn/support/content/zh-cn16092083/'},
  {model:'nova15',ram:12,rom:512,glass:'',source:'https://consumer.huawei.com/cn/support/content/zh-cn16092083/'},
  {model:'nova15pro',ram:12,rom:512,glass:'昆仑玻璃',source:'https://consumer.huawei.com/cn/support/content/zh-cn16079405/'},
  {model:'nova15ultra',ram:12,rom:1024,glass:'玄武钢化昆仑玻璃',source:'https://consumer.huawei.com/cn/support/content/zh-cn16077638/',glassSource:'https://consumer.huawei.com/cn/phones/nova15-ultra/specs/'},
];
export function resolveVerifiedRomOnlySpec(sku,title,catalog=[]){
  const expected=storageParts(sku.storage);if(!expected)return null;
  const key=modelKey(sku.model),rule=rules.find(r=>r.model===key&&r.ram===expected.ram&&r.rom===expected.rom);
  if(!rule)return null;
  const text=canonical(title),at=text.indexOf(key);if(at<0)return null;
  const suffix=text.slice(at+key.length);
  if(/^(?:pro|max|ultra|mini|plus|air|[a-z])/.test(suffix))return null;
  const spec=text.slice(0,at)+text.slice(at+key.length);
  if(/\d+(?:gb|g)?\+\d/.test(spec))return null; // Explicit RAM must use normal exact-pair validation.
  const tokens=[...spec.matchAll(/(\d+)(tb|t|gb|g)(?![a-z])/g)];
  if(tokens.some(m=>+m[1]<64 && (m[2]==='gb' || m[2]==='g' && ![2,3,4,5,6].includes(+m[1]))))return null;
  const roms=tokens.map(m=>+m[1]*(/^t/.test(m[2])?1024:1)).filter(n=>capacities.has(n));
  if(!roms.length||roms.some(n=>n!==expected.rom))return null;
  if(/昆仑玻璃|玄武钢化/.test(expected.edition)&&!rule.glass)return null;
  if(rule.glass&&!expected.edition.includes('昆仑玻璃'))return null;
  if(!rule.glass&&/昆仑玻璃|玄武钢化/.test(text))return null;
  if(rule.glass&&text.includes('铝硅玻璃'))return null;
  if(!rule.glass.includes('玄武钢化')&&text.includes('玄武钢化'))return null;
  // Do not resolve a ROM-only title when the active catalog contains another RAM or edition.
  const siblings=catalog.filter(c=>typeof c==='object'&&modelKey(c.model??c.name)===key).map(c=>storageParts(c.storage)).filter(c=>c?.rom===expected.rom);
  if(!siblings.length||siblings.some(c=>c.ram!==expected.ram||c.edition!==expected.edition))return null;
  return {...rule,reason:'官方规格唯一对应；商品标题只标机身存储，保留型号、店铺、自营及价格校验'};
}
