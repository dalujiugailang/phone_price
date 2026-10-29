import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export function patchMaishouRomMatching(source){
  if(source.includes("from './verified-rom-matching.mjs'"))throw Error('Provider is already patched');
  const replacements=[
    ["import fs from 'node:fs';","import {resolveVerifiedRomOnlySpec} from './verified-rom-matching.mjs';\nimport fs from 'node:fs';"],
    ["  title=normalizeTitle(title);","  title=normalizeTitle(title);\n  const verifiedRomOnlySpec=resolveVerifiedRomOnlySpec(sku,title,catalog);"],
    ["  if(/^\\d/.test(suffix) && !/^\\d+(?:gb|g)?\\+\\d/.test(suffix)","  if(/^\\d/.test(suffix) && !verifiedRomOnlySpec && !/^\\d+(?:gb|g)?\\+\\d/.test(suffix)"],
    ["present=original.includes(tag);","present=original.includes(tag) || Boolean(verifiedRomOnlySpec?.glass.includes(tag));"],
    ["  if(new Set(pairs.map(m=>", "  if(!pairs.length && verifiedRomOnlySpec)return true;\n  if(new Set(pairs.map(m=>"],
  ];
  for(const [before,after] of replacements){
    if(source.split(before).length!==2)throw Error('Unexpected provider version: '+before);
    source=source.replace(before,after);
  }
  const evidence='matchEvidence:`sourceType=${detail.sourceType}; shopType=${detail.shopType}; 自营标签`';
  if(source.split(evidence).length!==2)throw Error('Quote evidence marker changed');
  source=source.replace(evidence,'matchEvidence:`sourceType=${detail.sourceType}; shopType=${detail.shopType}; 自营标签${resolveVerifiedRomOnlySpec(sku,title,catalog) ? "; 官方规格唯一对应="+resolveVerifiedRomOnlySpec(sku,title,catalog).source : ""}`');
  if(source.includes("algorithmVersion:'20261028-search-v5'"))source=source.replace("algorithmVersion:'20261028-search-v5'","algorithmVersion:'20261029-verified-rom-v1'");
  return source;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [input,output]=process.argv.slice(2);if(!input||!output||path.resolve(input)===path.resolve(output))throw Error('Specify separate input and output files');
  fs.writeFileSync(output,patchMaishouRomMatching(fs.readFileSync(input,'utf8')));
}
