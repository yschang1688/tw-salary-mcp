// Query layer over the MOPS salary disclosures.
//
// Port of salary_mcp/dataset.py. The design rule is unchanged from the Python
// original: every entry point takes narrow, validated arguments. There is no
// generic query function, because handing a model the full expressive power of
// a query language also hands it to anything that can inject into the model.
//
// Units throughout: 萬元 (NT$10,000) per year, non-managerial full-time staff.

import current from "@/data/current.json";
import trendData from "@/data/trend.json";

export interface Company {
  rank: number;
  code: string;
  name: string;
  market: string;
  industry: string | null;  // MOPS 有少數未標產業的列——null 是資料事實，不是缺陷
  medianNonMgr: number;
  avgNonMgr: number;
  employees: number | null;
}

export class InvalidArgument extends Error {}

const COMPANIES = current.companies as Company[];
const TREND = trendData as Record<string, Record<string, number>>;
const YEARS = Object.keys(TREND).sort();

export const DATASET_YEAR = current.year as number;
export const UNIT_NOTE =
  "Figures are NT$10k (萬元) per year, non-managerial full-time employees.";

/** Same contract as FIT_STAMP, for the census-grade family. */
export const SALARY_STAMP =
  `— Source: MOPS statutory disclosures (TWSE/TPEx listed companies), 2019-${DATASET_YEAR} vintage. Census-grade.`;

const CODE_RE = /^\d{4,6}$/;

/** Server-side validation and clamping. Rejects before any lookup runs. */
function requireQuery(raw: unknown, field: string, maxLen = 40): string {
  if (typeof raw !== "string") throw new InvalidArgument(`${field} must be a string`);
  const q = raw.trim();
  if (!q) throw new InvalidArgument(`${field} must not be empty`);
  if (q.length > maxLen) throw new InvalidArgument(`${field} must be at most ${maxLen} characters`);
  return q;
}

export function medianOverAvg(c: Company): number | null {
  if (!c.avgNonMgr) return null;
  return Math.round((c.medianNonMgr / c.avgNonMgr) * 100) / 100;
}

export function formatCompany(c: Company): string {
  const parts = [
    `${c.name} (${c.code}, ${c.market})`,
    `industry: ${c.industry ?? "(not classified)"}`,
    `median: ${c.medianNonMgr} 萬/yr`,
    `mean: ${c.avgNonMgr} 萬/yr`,
    `overall rank: ${c.rank}`,
  ];
  if (c.employees != null) parts.push(`employees: ${c.employees}`);
  const ratio = medianOverAvg(c);
  if (ratio != null) {
    const skew = ratio < 0.85 ? " (right-skewed — quote the median)" : "";
    parts.push(`median/mean: ${ratio}${skew}`);
  }
  return parts.join(" | ");
}

/** Exact code match when the query looks like a stock code; else name substring. */
export function findCompanies(rawQuery: unknown): Company[] {
  const q = requireQuery(rawQuery, "query");
  if (CODE_RE.test(q)) return COMPANIES.filter((c) => c.code === q);
  return COMPANIES.filter((c) => c.name.includes(q));
}

export function industryStats(rawIndustry: unknown) {
  const q = requireQuery(rawIndustry, "industry");
  // industry can be null (unclassified in MOPS) — a null row must be skipped,
  // not thrown on. This exact line took production down for every industry query in 1.0.0.
  const hits = COMPANIES.filter((c) => c.industry?.includes(q));
  if (!hits.length) return null;

  const medians = hits.map((c) => c.medianNonMgr).sort((a, b) => a - b);
  const at = (p: number) =>
    medians[Math.min(medians.length - 1, Math.floor(p * (medians.length - 1)))];

  return {
    industry: hits[0].industry,
    year: DATASET_YEAR,
    companyCount: hits.length,
    medianOfMedians: at(0.5),
    p25: at(0.25),
    p75: at(0.75),
    min: medians[0],
    max: medians[medians.length - 1],
    companies: [...hits].sort((a, b) => b.medianNonMgr - a.medianNonMgr),
  };
}

export function topByMedian(opts: {
  industry?: unknown;
  minMedian?: unknown;
  limit?: unknown;
}): Company[] {
  let hits = COMPANIES;

  if (opts.industry != null && opts.industry !== "") {
    const q = requireQuery(opts.industry, "industry");
    hits = hits.filter((c) => c.industry?.includes(q));
  }

  if (opts.minMedian != null && opts.minMedian !== 0 && opts.minMedian !== "") {
    const floor = Number(opts.minMedian);
    if (!Number.isFinite(floor) || floor < 0) {
      throw new InvalidArgument("min_median must be a non-negative number");
    }
    hits = hits.filter((c) => c.medianNonMgr >= floor);
  }

  // Clamp rather than reject: an out-of-range limit is a model slip, not an attack.
  let limit = opts.limit == null ? 10 : Number(opts.limit);
  if (!Number.isFinite(limit)) throw new InvalidArgument("limit must be a number");
  limit = Math.max(1, Math.min(50, Math.trunc(limit)));

  return [...hits].sort((a, b) => b.medianNonMgr - a.medianNonMgr).slice(0, limit);
}

export function companyTrend(rawCode: unknown) {
  const code = requireQuery(rawCode, "code", 6);
  if (!CODE_RE.test(code)) {
    throw new InvalidArgument("code must be a 4-6 digit TWSE/TPEx stock code");
  }

  const series: Record<string, number | null> = {};
  const missing: string[] = [];
  for (const y of YEARS) {
    const v = TREND[y][code];
    series[y] = v ?? null;
    if (v == null) missing.push(y);
  }

  const present = YEARS.filter((y) => series[y] != null);
  if (!present.length) return null;

  const first = present[0];
  const last = present[present.length - 1];
  const a = series[first]!;
  const b = series[last]!;
  const changePct = first === last ? null : Math.round(((b - a) / a) * 1000) / 10;

  return {
    code,
    name: COMPANIES.find((c) => c.code === code)?.name ?? code,
    series,
    firstYear: first,
    lastYear: last,
    changePct,
    missingYears: missing,
  };
}

export const SCHEMA_TEXT = [
  "MOPS non-managerial full-time salary disclosures for TWSE/TPEx listed companies, 2019-2025.",
  "Source: TWSE and TPEx open-data endpoints (t187ap46). Public, company-level aggregates only — no personal data.",
  "",
  "Fields: code, name, market (上市/上櫃), industry, rank (overall by median), medianNonMgr, avgNonMgr, employees.",
  "Units: 萬元 (NT$10,000) per year.",
  "",
  "Reading guidance: median/mean below ~0.85 means the distribution is right-skewed and the mean is",
  "pulled up by a few high earners — quote the median. A company absent in a given year was below the",
  "disclosure threshold or not yet listed; it is reported as null, never as zero.",
].join("\n");
