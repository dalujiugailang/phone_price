export interface NewMachinePpvMapping {
  model: string;
  storage: string;
  position: string;
  ppv: string;
}

export const NEW_MACHINE_PPV_MAPPINGS: NewMachinePpvMapping[] = [
  { model: 'REDMI Turbo 5 Max', storage: '12G+256G', position: '低端', ppv: 'SREDMI Turbo 5 Max 大陆国行 全网通 12G+256G 暗影黑' },
  { model: 'REDMI Turbo 5 Max', storage: '12G+512G', position: '低端', ppv: 'SREDMI Turbo 5 Max 大陆国行 全网通 12G+512G 暗影黑' },
  { model: 'REDMI Turbo 5 Max', storage: '16G+256G', position: '低端', ppv: 'SREDMI Turbo 5 Max 大陆国行 全网通 16G+256G 暗影黑' },
  { model: 'REDMI Turbo 5 Max', storage: '16G+512G', position: '低端', ppv: 'SREDMI Turbo 5 Max 大陆国行 全网通 16G+512G 暗影黑' },
  { model: 'REDMI Turbo 5 Max', storage: '16G+1T', position: '低端', ppv: 'SREDMI Turbo 5 Max 大陆国行 全网通 暗影黑 16G+1T' },
  { model: 'iQOO Z11 Turbo', storage: '12G+256G', position: '低端', ppv: 'SiQOO Z11 Turbo 大陆国行 全网通 12G+256G 极夜黑' },
  { model: 'iQOO Z11 Turbo', storage: '16G+256G', position: '低端', ppv: 'SiQOO Z11 Turbo 大陆国行 全网通 16G+256G 极夜黑' },
  { model: 'iQOO Z11 Turbo', storage: '12G+512G', position: '低端', ppv: 'SiQOO Z11 Turbo 大陆国行 全网通 12G+512G 极夜黑' },
  { model: 'iQOO Z11 Turbo', storage: '16G+512G', position: '低端', ppv: 'SiQOO Z11 Turbo 大陆国行 全网通 16G+512G 极夜黑' },
  { model: 'iQOO Z11 Turbo', storage: '16G+1T', position: '低端', ppv: 'SiQOO Z11 Turbo 大陆国行 全网通 极夜黑 16G+1T' },
  { model: '荣耀 Power 2', storage: '12G+256G', position: '低端', ppv: 'S荣耀 Power 2 大陆国行 全网通 12G+256G 幻夜黑' },
  { model: '荣耀 Power 2', storage: '12G+512G', position: '低端', ppv: 'S荣耀 Power 2 大陆国行 全网通 12G+512G 幻夜黑' },
  { model: 'vivo S50', storage: '12G+256G', position: '中端', ppv: 'Svivo S50 大陆国行 全网通 12G+256G 深空黑' },
  { model: 'vivo S50', storage: '16G+256G', position: '中端', ppv: 'Svivo S50 大陆国行 全网通 16G+256G 深空黑' },
  { model: 'vivo S50', storage: '12G+512G', position: '中端', ppv: 'Svivo S50 大陆国行 全网通 12G+512G 深空黑' },
  { model: 'vivo S50', storage: '16G+512G', position: '中端', ppv: 'Svivo S50 大陆国行 全网通 16G+512G 深空黑' },
  { model: '华为 Mate 80', storage: '12G+256G', position: '旗舰', ppv: 'S华为 Mate 80 大陆国行 全网通 12G+256G 曜石黑 保修时长≥30天' },
  { model: '华为 Mate 80', storage: '12G+512G', position: '旗舰', ppv: 'S华为 Mate 80 大陆国行 全网通 12G+512G 曜石黑 保修时长≥30天' },
  { model: '华为 Mate 80', storage: '16G+512G', position: '旗舰', ppv: 'S华为 Mate 80 大陆国行 全网通 16G+512G 曜石黑 保修时长≥30天' },
  { model: '华为 Mate 80 Pro', storage: '12G+256G', position: '旗舰', ppv: 'S华为 Mate 80 Pro 大陆国行 全网通 12G+256G 曜石黑 保修时长≥30天' },
  { model: '华为 Mate 80 Pro', storage: '12G+512G', position: '旗舰', ppv: 'S华为 Mate 80 Pro 大陆国行 全网通 12G+512G 曜石黑 保修时长≥30天' },
  { model: '华为 Mate 80 Pro', storage: '16G+512G', position: '旗舰', ppv: 'S华为 Mate 80 Pro 大陆国行 全网通 16G+512G 曜石黑 保修时长≥30天' },
  { model: '华为 Mate 80 Pro', storage: '16G+1T', position: '旗舰', ppv: 'S华为 Mate 80 Pro 大陆国行 全网通 曜石黑 保修时长≥30天 16G+1T' },
  { model: '华为 Mate X7', storage: '12G+256G', position: '折叠', ppv: 'S华为 Mate X7 大陆国行 全网通 12G+256G 曜石黑 保修时长≥30天' },
  { model: '华为 Mate X7', storage: '12G+512G', position: '折叠', ppv: 'S华为 Mate X7 大陆国行 全网通 12G+512G 曜石黑 保修时长≥30天' },
  { model: '华为 Mate X7 典藏版', storage: '16G+512G', position: '折叠', ppv: 'S华为 Mate X7 典藏版 大陆国行 全网通 16G+512G 保修时长≥30天 云锦白' },
  { model: '华为 Mate X7 典藏版', storage: '16G+1T', position: '折叠', ppv: 'S华为 Mate X7 典藏版 大陆国行 全网通 保修时长≥30天 16G+1T 云锦白' },
  { model: '华为 Mate X7 典藏版', storage: '20G+1T', position: '折叠', ppv: 'S华为 Mate X7 典藏版 大陆国行 全网通 保修时长≥30天 云锦白 20G+1T' },
  { model: '荣耀 500', storage: '12G+256G', position: '中端', ppv: 'S荣耀 500 大陆国行 全网通 12G+256G 曜石黑 保修时长≥30天' },
  { model: '荣耀 500', storage: '12G+512G', position: '中端', ppv: 'S荣耀 500 大陆国行 全网通 12G+512G 曜石黑 保修时长≥30天' },
  { model: '荣耀 500', storage: '16G+512G', position: '中端', ppv: 'S荣耀 500 大陆国行 全网通 16G+512G 曜石黑 保修时长≥30天' },
  { model: 'OPPO Reno15', storage: '12G+256G', position: '中端', ppv: 'SOPPO Reno15 大陆国行 全网通 12G+256G 星光蝴蝶结' },
  { model: 'OPPO Reno15', storage: '12G+512G', position: '中端', ppv: 'SOPPO Reno15 大陆国行 全网通 12G+512G 星光蝴蝶结' },
  { model: 'OPPO Reno15', storage: '16G+256G', position: '中端', ppv: 'SOPPO Reno15 大陆国行 全网通 16G+256G 星光蝴蝶结' },
  { model: 'OPPO Reno15', storage: '16G+512G', position: '中端', ppv: 'SOPPO Reno15 大陆国行 全网通 16G+512G 星光蝴蝶结' },
  { model: 'OPPO Reno15', storage: '16G+1T', position: '中端', ppv: 'SOPPO Reno15 大陆国行 全网通 16G+1T 星光蝴蝶结' },
  { model: 'iQOO Neo11', storage: '12G+256G', position: '低端', ppv: 'SiQOO Neo11 大陆国行 全网通 12G+256G 驰光白' },
  { model: 'iQOO Neo11', storage: '16G+256G', position: '低端', ppv: 'SiQOO Neo11 大陆国行 全网通 16G+256G 驰光白' },
  { model: 'iQOO Neo11', storage: '12G+512G', position: '低端', ppv: 'SiQOO Neo11 大陆国行 全网通 12G+512G 驰光白' },
  { model: 'iQOO Neo11', storage: '16G+512G', position: '低端', ppv: 'SiQOO Neo11 大陆国行 全网通 16G+512G 驰光白' },
  { model: 'iQOO Neo11', storage: '16G+1T', position: '低端', ppv: 'SiQOO Neo11 大陆国行 全网通 16G+1T 驰光白' },
  { model: '一加 15', storage: '12G+256G', position: '旗舰', ppv: 'S一加 15 大陆国行 全网通 12G+256G 原色沙丘' },
  { model: '一加 15', storage: '12G+512G', position: '旗舰', ppv: 'S一加 15 大陆国行 全网通 12G+512G 原色沙丘' },
  { model: '一加 15', storage: '16G+256G', position: '旗舰', ppv: 'S一加 15 大陆国行 全网通 16G+256G 原色沙丘' },
  { model: '一加 15', storage: '16G+512G', position: '旗舰', ppv: 'S一加 15 大陆国行 全网通 16G+512G 原色沙丘' },
  { model: '一加 15', storage: '16G+1T', position: '旗舰', ppv: 'S一加 15 大陆国行 全网通 16G+1T 原色沙丘' },
  { model: 'REDMI K90', storage: '16G+256G', position: '中端', ppv: 'SREDMI K90 大陆国行 白色 全网通 16G+256G' },
  { model: 'REDMI K90', storage: '12G+256G', position: '中端', ppv: 'SREDMI K90 大陆国行 白色 全网通 12G+256G' },
  { model: 'REDMI K90', storage: '12G+512G', position: '中端', ppv: 'SREDMI K90 大陆国行 白色 全网通 12G+512G' },
  { model: 'REDMI K90', storage: '16G+512G', position: '中端', ppv: 'SREDMI K90 大陆国行 白色 全网通 16G+512G' },
  { model: 'REDMI K90', storage: '16G+1T', position: '中端', ppv: 'SREDMI K90 大陆国行 白色 全网通 16G+1T' },
  { model: 'OPPO Find X9', storage: '12G+256G', position: '旗舰', ppv: 'SOPPO Find X9 大陆国行 全网通 12G+256G 霜白' },
  { model: 'OPPO Find X9', storage: '16G+256G', position: '旗舰', ppv: 'SOPPO Find X9 大陆国行 全网通 16G+256G 霜白' },
  { model: 'OPPO Find X9', storage: '12G+512G', position: '旗舰', ppv: 'SOPPO Find X9 大陆国行 全网通 12G+512G 霜白' },
  { model: 'OPPO Find X9', storage: '16G+512G', position: '旗舰', ppv: 'SOPPO Find X9 大陆国行 全网通 16G+512G 霜白' },
  { model: 'OPPO Find X9', storage: '16G+1T', position: '旗舰', ppv: 'SOPPO Find X9 大陆国行 全网通 16G+1T 霜白' },
  { model: 'OPPO Find X9 Pro', storage: '12G+256G', position: '旗舰', ppv: 'SOPPO Find X9 Pro 大陆国行 全网通 12G+256G 霜白' },
  { model: 'OPPO Find X9 Pro', storage: '12G+512G', position: '旗舰', ppv: 'SOPPO Find X9 Pro 大陆国行 全网通 12G+512G 霜白' },
  { model: 'OPPO Find X9 Pro', storage: '16G+512G', position: '旗舰', ppv: 'SOPPO Find X9 Pro 大陆国行 全网通 16G+512G 霜白' },
  { model: 'OPPO Find X9 Pro', storage: '16G+1T', position: '旗舰', ppv: 'SOPPO Find X9 Pro 大陆国行 全网通 16G+1T 霜白' },
  { model: '荣耀 Magic8', storage: '12G+256G', position: '旗舰', ppv: 'S荣耀 Magic8 大陆国行 全网通 12G+256G 保修时长≥30天 雪域白' },
  { model: '荣耀 Magic8', storage: '12G+512G', position: '旗舰', ppv: 'S荣耀 Magic8 大陆国行 全网通 12G+512G 保修时长≥30天 雪域白' },
  { model: '荣耀 Magic8', storage: '16G+512G', position: '旗舰', ppv: 'S荣耀 Magic8 大陆国行 全网通 16G+512G 保修时长≥30天 雪域白' },
  { model: '荣耀 Magic8', storage: '16G+1T', position: '旗舰', ppv: 'S荣耀 Magic8 大陆国行 全网通 保修时长≥30天 雪域白 16G+1T' },
  { model: 'iQOO 15', storage: '12G+256G', position: '旗舰', ppv: 'SiQOO 15 大陆国行 全网通 12G+256G 传奇版' },
  { model: 'iQOO 15', storage: '16G+256G', position: '旗舰', ppv: 'SiQOO 15 大陆国行 全网通 16G+256G 传奇版' },
  { model: 'iQOO 15', storage: '12G+512G', position: '旗舰', ppv: 'SiQOO 15 大陆国行 全网通 12G+512G 传奇版' },
  { model: 'iQOO 15', storage: '16G+512G', position: '旗舰', ppv: 'SiQOO 15 大陆国行 全网通 16G+512G 传奇版' },
  { model: 'iQOO 15', storage: '16G+1T', position: '旗舰', ppv: 'SiQOO 15 大陆国行 全网通 传奇版 16G+1T' },
  { model: 'vivo X300', storage: '12G+256G', position: '旗舰', ppv: 'Svivo X300 大陆国行 全网通 12G+256G 纯粹黑' },
  { model: 'vivo X300', storage: '16G+256G', position: '旗舰', ppv: 'Svivo X300 大陆国行 全网通 16G+256G 纯粹黑' },
  { model: 'vivo X300', storage: '12G+512G', position: '旗舰', ppv: 'Svivo X300 大陆国行 全网通 12G+512G 纯粹黑' },
  { model: 'vivo X300', storage: '16G+512G', position: '旗舰', ppv: 'Svivo X300 大陆国行 全网通 16G+512G 纯粹黑' },
  { model: 'vivo X300', storage: '16G+1T', position: '旗舰', ppv: 'Svivo X300 大陆国行 全网通 16G+1T 纯粹黑' },
  { model: 'vivo X300 Pro', storage: '12G+256G', position: '旗舰', ppv: 'Svivo X300 Pro 大陆国行 全网通 12G+256G 简单白' },
  { model: 'vivo X300 Pro', storage: '16G+512G', position: '旗舰', ppv: 'Svivo X300 Pro 大陆国行 全网通 16G+512G 简单白' },
  { model: 'vivo X300 Pro', storage: '16G+1T', position: '旗舰', ppv: 'Svivo X300 Pro 大陆国行 全网通 16G+1T 简单白' },
  { model: '小米 17', storage: '12G+256G', position: '旗舰', ppv: 'S小米 17 大陆国行 白色 全网通 12G+256G 保修时长≥30天' },
  { model: '小米 17', storage: '12G+512G', position: '旗舰', ppv: 'S小米 17 大陆国行 白色 全网通 12G+512G 保修时长≥30天' },
  { model: '小米 17', storage: '16G+512G', position: '旗舰', ppv: 'S小米 17 大陆国行 白色 全网通 16G+512G 保修时长≥30天' },
  { model: '小米 17', storage: '16G+1T', position: '旗舰', ppv: 'S小米 17 大陆国行 白色 全网通 保修时长≥30天 16G+1T' },
  { model: 'vivo X Fold 5', storage: '12G+256G', position: '折叠', ppv: 'Svivo X Fold 5 大陆国行 全网通 12G+256G 钛度' },
  { model: 'vivo X Fold 5', storage: '12G+512G', position: '折叠', ppv: 'Svivo X Fold 5 大陆国行 全网通 12G+512G 钛度' },
  { model: 'vivo X Fold 5', storage: '16G+512G', position: '折叠', ppv: 'Svivo X Fold 5 大陆国行 全网通 16G+512G 钛度' },
  { model: 'vivo X Fold 5', storage: '16G+1T', position: '折叠', ppv: 'Svivo X Fold 5 大陆国行 全网通 16G+1T 钛度' },
];

export function normalizePpvStorage(value: string) {
  return value
    .replace(/\s+/g, '')
    .replace(/GB/gi, 'G')
    .replace(/TB/gi, 'T')
    .replace(/^(\d+)\+/, '$1G+')
    .toUpperCase();
}

export function getNewMachinePpvMapping(model: string, storage: string) {
  const normalizedModel = model.trim();
  const normalizedStorage = normalizePpvStorage(storage);

  const directMatch = NEW_MACHINE_PPV_MAPPINGS.find(
    (item) => item.model === normalizedModel && normalizePpvStorage(item.storage) === normalizedStorage,
  );

  if (directMatch) {
    return directMatch;
  }

  if (normalizedModel === '华为 Mate X7') {
    return NEW_MACHINE_PPV_MAPPINGS.find(
      (item) => item.model === '华为 Mate X7 典藏版' && normalizePpvStorage(item.storage) === normalizedStorage,
    );
  }

  return undefined;
}
