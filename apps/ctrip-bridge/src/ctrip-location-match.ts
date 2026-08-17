const CTRIP_LOCATION_ADMIN_PREFIXES = Object.freeze([
  "云南",
  "贵州",
  "新疆",
  "西藏",
  "广西",
  "内蒙古",
  "宁夏",
  "青海",
  "四川",
  "甘肃",
  "陕西",
  "山西",
  "河北",
  "河南",
  "山东",
  "安徽",
  "江苏",
  "浙江",
  "福建",
  "江西",
  "湖北",
  "湖南",
  "广东",
  "海南",
  "吉林",
  "辽宁",
  "黑龙江",
  "北京",
  "上海",
  "天津",
  "重庆",
  "香港",
  "澳门",
  "台湾",
]);

export const CTRIP_LOCATION_KEYWORD_COVERAGE_THRESHOLD = 0.7;

function canonicalLocationText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function splitAdministrativeKeyword(value: string): readonly string[] {
  for (const prefix of CTRIP_LOCATION_ADMIN_PREFIXES) {
    if (!value.startsWith(prefix) || value === prefix) continue;
    const remainder = value.slice(prefix.length).replace(/^(?:省|市|自治区|特别行政区)+/u, "");
    return remainder.length === 0 ? [prefix] : [prefix, remainder];
  }
  return [value];
}

function locationKeywords(query: string): readonly string[] {
  const normalized = query.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const tokens = normalized
    .split(/[^\p{Letter}\p{Number}]+/gu)
    .filter((token) => token.length > 0)
    .flatMap(splitAdministrativeKeyword)
    .map(canonicalLocationText)
    .filter((token) => token.length > 0);
  return [...new Set(tokens)];
}

export function ctripLocationKeywordCoverage(observed: string, query: string): number {
  const observedCanonical = canonicalLocationText(observed);
  const queryCanonical = canonicalLocationText(query);
  if (observedCanonical.length === 0 || queryCanonical.length === 0) return 0;
  if (observedCanonical.includes(queryCanonical)) return 1;

  const keywords = locationKeywords(query);
  if (keywords.length === 0) return 0;
  const weights = keywords.map((keyword) => Array.from(keyword).length);
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  const matchedWeight = keywords.reduce(
    (total, keyword, index) =>
      total + (observedCanonical.includes(keyword) ? (weights[index] ?? 0) : 0),
    0,
  );
  return totalWeight === 0 ? 0 : matchedWeight / totalWeight;
}

export function matchesCtripLocationQuery(observed: string, query: string): boolean {
  return ctripLocationKeywordCoverage(observed, query) >= CTRIP_LOCATION_KEYWORD_COVERAGE_THRESHOLD;
}
