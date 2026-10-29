// Additional guards for storage discovery; a search hit is not a catalog fact.
export function isPhoneTitle(title) {
  return !/笔记本|游戏本|平板|电脑|保护壳|手机壳|贴膜|二手|成新|拆封|租赁|合约|定金|套装|礼盒|服务包|赠话费|企业|教育优惠|防爆|套餐|分身|补贴版|移动补贴|联通补贴|电信补贴/.test(title);
}
export function hasExactModelBoundary(model, title) {
  const normalize = s => String(s).normalize('NFKC').replaceAll('高定款', '高定版').replace(/非凡大师|典藏版|风驰版|昆仑玻璃版|高定版/g, '').replace(/\s+/g, '').toLowerCase();
  const strip = s => normalize(s).replace(/^(?:摩托罗拉|motorola|moto|联想)+/i, '').replace(/^(?:努比亚)?红魔|^(?:三星)?galaxy|^(?:小米|xiaomi|redmi|红米|荣耀|honor|华为|huawei|三星|samsung|努比亚|nubia|redmagic|oppo|vivo|iqoo|一加|oneplus|真我|realme)/i, '');
  const token = strip(model), text = normalize(title), at = text.indexOf(token);
  if (!token || at < 0) return false;
  const suffix = text.slice(at + token.length);
  // Compact titles join model and RAM; only a genuine RAM+ROM pair may follow digits.
  if (/^\d/.test(suffix)) return /^\d{1,2}(?:gb|g)?\+\d/.test(suffix) || /^\d+(?:tb|gb)/.test(suffix);
  return !/^(?:pro|max|ultra|mini|air|edge|plus|turbo|rsr|rs|rt|se|[xvcst](?:pro|plus|ultra)?(?=[^a-z]|$)|\+)/.test(suffix) && !/^(?:至尊|典藏|风驰|非凡|高定|焕新|特别|冠军|元气|超级|超能)/.test(suffix);
}
export function extractStorageVariants(model, title) {
  if (!isPhoneTitle(title) || !hasExactModelBoundary(model, title)) return [];
  const normalized = String(title).normalize('NFKC').replaceAll('高定款', '高定版').replace(/\s*\+\s*/g, '+');
  const pairs = [...normalized.matchAll(/(\d{1,2})\s*(?:GB|G)?\+(128|256|512|1024|2048|1|2)\s*(TB|T|GB|G)?(?=\s|[^0-9a-z]|$)/gi)];
  const storages = pairs.map(m => `${+m[1]}GB+${+m[2]}${/^t/i.test(m[3] || '') || +m[2] < 3 ? 'TB' : 'GB'}`);
  if (!storages.length) for (const m of normalized.matchAll(/(128|256|512|1|2)\s*(GB|TB)(?![a-z])/gi)) storages.push(`${+m[1]}${m[2].toUpperCase()}`);
  const unique = [...new Set(storages)];
  // Mixed offers cannot establish one exact SKU.
  if (unique.length !== 1) return [];
  const special = ['玄武钢化昆仑玻璃版', '昆仑玻璃版', '高定版'].find(tag => normalized.includes(tag));
  return unique.map(s => s + (special ? ` ${special}` : ''));
}
export function romSize(storage) {
  const match = storage.match(/(?:\+|^)(\d+)(TB|T|GB|G)(?:\s|$)/i);
  return match ? +match[1] * (/^t/i.test(match[2]) ? 1024 : 1) : null;
}
export function isKnownStorage(storage, existing) {
  // ROM-only listing titles do not prove that a known RAM+ROM SKU is different.
  const compact = s => s.toUpperCase().replace(/GB/g,'G').replace(/TB/g,'T').replace(/\s/g,'');
  const identity = s => { const m = compact(s).match(/^(\d+)G?\+(\d+)(T|G)(.*)$/); return m ? `${+m[1]}:${+m[2] * (m[3] === 'T' ? 1024 : 1)}:${m[4]}` : compact(s); };
  if (existing.some(s => identity(s) === identity(storage))) return true;
  return !storage.includes('+') && existing.some(s => romSize(s) === romSize(storage));
}
export function isAllowedJdOffer(model, brand, offer) {
  const rules = [
    [/^(小米|xiaomi|redmi|红米)/i,['小米京东自营旗舰店']],
    [/^(华为|huawei)/i,['华为京东自营旗舰店']],
    [/^(荣耀|honor)/i,['荣耀京东自营旗舰店']],
    [/^oppo/i,['OPPO京东自营旗舰店']],
    [/^(一加|oneplus)/i,['一加手机京东自营旗舰店']],
    [/^(真我|realme)/i,['真我realme京东自营旗舰店']],
    [/^vivo/i,['vivo京东自营旗舰店']],
    [/^iqoo/i,['iQOO京东自营旗舰店']],
    [/^(三星|samsung)/i,['三星京东自营官方旗舰店']],
    [/^(努比亚|nubia|红魔|redmagic)/i,['努比亚京东自营旗舰店','红魔京东自营旗舰店']],
    [/^(摩托罗拉|motorola|moto|联想)/i,['联想moto手机京东自营旗舰店']],
    [/^(魅族|meizu)/i,['魅族京东自营旗舰店']],
    [/^(中兴|zte)/i,['中兴京东自营旗舰店']],
  ];
  const rule = rules.find(([pattern]) => pattern.test(model)) || rules.find(([pattern]) => pattern.test(brand));
  if (!rule || !rule[1].includes(offer.shopName) || String(offer.sourceType)!=='2' || String(offer.shopType)!=='1') return false;
  const normalize = s => String(s).normalize('NFKC').replaceAll('高定款','高定版').replace(/\s/g,'');
  for (const edition of ['特别版','冠军版','典藏版','焕新版','元气版','超级版','超能版','高定版','风驰版','徕卡版','非凡大师','保时捷设计']) {
    if (normalize(model).includes(edition) !== normalize(offer.title).includes(edition)) return false;
  }
  return isPhoneTitle(offer.title) && hasExactModelBoundary(model,offer.title);
}
