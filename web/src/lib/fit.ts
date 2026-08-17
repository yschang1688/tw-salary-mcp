// JD fit analysis over a fixed skill-group dictionary.
//
// Same design rule as dataset.ts: narrow validated entry points, no generic
// query surface. The dictionary ships as data (group id + match keywords only);
// the caller supplies their own skills as plain strings — this server holds no
// personal skill profile of anyone.
//
// The demand statistics are aggregates over a private corpus of 1,086 job
// postings (counts and percentages only — no posting text, no company names).
// They describe that corpus, not the whole market: data/AI-adjacent roles at
// higher-paying Taiwanese listed companies, collected 2026-07/08.

import fitData from "@/data/fit-demand.json";
import { InvalidArgument } from "@/lib/dataset";

export interface FitGroup {
  id: string;
  kw: string[];
  demandCount: number;
  demandPct: number;
}

const GROUPS = fitData.groups as FitGroup[];
export const CORPUS_SIZE = fitData.corpusSize as number;
export const CORPUS_NOTE = String(fitData._meta.corpus);
const YEARS_HIST = fitData.yearsRequired as Record<string, number>;

/**
 * The vintage-and-provenance stamp. Contract: every fit-tool answer ends with
 * this line, so a stale dataset degrades into a labelled snapshot instead of a
 * silently wrong answer. Values come from the data file, not from code — the
 * regeneration runbook (private side) bumps them and the stamp follows.
 */
export const FIT_STAMP =
  `— Corpus: private snapshot ${fitData._meta.corpusWindow} (n=${fitData.corpusSize}), ` +
  `dictionary v${fitData._meta.dictVersion}. Describes this corpus, not the whole market.`;

/**
 * Keyword hit with a word-boundary rule for short ASCII tokens (≤4 chars):
 * plain substring matching would find ai⊂maintain, git⊂digital, app⊂Apache.
 * Longer tokens and CJK phrases match as substrings.
 */
export function kwHit(jdLower: string, k: string): boolean {
  const t = k.trim();
  if (/^[a-z0-9+#./&-]+$/.test(t) && t.length <= 4) {
    const esc = t.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(jdLower);
  }
  return jdLower.includes(t);
}

const CN: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** "3年以上" / "三年以上" → 3. Null when the posting states no requirement. */
export function extractYears(jdLower: string): { n: number; matched: string } | null {
  const yr = jdLower.match(/(\d+|[一二三四五六七八九十])\s*年以上/);
  if (!yr) return null;
  return { n: CN[yr[1]] ?? parseInt(yr[1], 10), matched: yr[0] };
}

function requireJd(raw: unknown): string {
  if (typeof raw !== "string") throw new InvalidArgument("jd must be a string");
  const jd = raw.trim();
  if (jd.length < 30) throw new InvalidArgument("jd is too short to analyse (need the posting text, not a title)");
  if (jd.length > 20000) throw new InvalidArgument("jd exceeds 20000 characters; send the requirements section only");
  return jd;
}

export interface JdAnalysis {
  matched: { id: string; hits: string[]; demandPct: number }[];
  yearsRequired: { n: number; matched: string } | null;
  groupsChecked: number;
}

/** Which dictionary groups does this posting ask for? */
export function analyzeJd(rawJd: unknown): JdAnalysis {
  const lower = requireJd(rawJd).toLowerCase();
  const matched = GROUPS.flatMap((g) => {
    const hits = g.kw.filter((k) => kwHit(lower, k));
    return hits.length ? [{ id: g.id, hits, demandPct: g.demandPct }] : [];
  });
  return { matched, yearsRequired: extractYears(lower), groupsChecked: GROUPS.length };
}

/**
 * A caller-supplied skill matches a group when it hits the group's keywords —
 * the same matcher the JD side uses, so both sides fail in the same way rather
 * than the skill side silently matching more loosely.
 */
export function skillToGroups(skill: string): string[] {
  const lower = skill.toLowerCase().trim();
  if (!lower) return [];
  return GROUPS.filter((g) => g.kw.some((k) => kwHit(lower, k) || kwHit(k, lower))).map((g) => g.id);
}

export interface GapReport {
  covered: { id: string; via: string[] }[];
  missing: { id: string; hits: string[]; demandPct: number }[];
  unmatchedSkills: string[];
  yearsRequired: { n: number; matched: string } | null;
}

export function skillGaps(rawJd: unknown, rawSkills: unknown): GapReport {
  if (!Array.isArray(rawSkills) || !rawSkills.length)
    throw new InvalidArgument("skills must be a non-empty array of strings");
  if (rawSkills.length > 100) throw new InvalidArgument("skills: at most 100 entries");
  const skills = rawSkills.map((s) => {
    if (typeof s !== "string" || !s.trim()) throw new InvalidArgument("skills entries must be non-empty strings");
    return s.trim().slice(0, 80);
  });

  const jd = analyzeJd(rawJd);
  const skillGroupPairs = skills.map((s) => ({ skill: s, groups: skillToGroups(s) }));
  const coveredIds = new Set(skillGroupPairs.flatMap((p) => p.groups));

  return {
    covered: jd.matched
      .filter((m) => coveredIds.has(m.id))
      .map((m) => ({
        id: m.id,
        via: skillGroupPairs.filter((p) => p.groups.includes(m.id)).map((p) => p.skill),
      })),
    missing: jd.matched.filter((m) => !coveredIds.has(m.id)),
    unmatchedSkills: skillGroupPairs.filter((p) => !p.groups.length).map((p) => p.skill),
    yearsRequired: jd.yearsRequired,
  };
}

export interface DemandRow {
  id: string;
  demandCount: number;
  demandPct: number;
}

/** Corpus-wide demand for groups, optionally filtered by a name fragment. */
export function marketDemand(rawQuery: unknown, rawLimit: unknown): DemandRow[] {
  let rows: FitGroup[] = GROUPS;
  if (rawQuery !== undefined && rawQuery !== null) {
    if (typeof rawQuery !== "string") throw new InvalidArgument("query must be a string");
    const q = rawQuery.trim().toLowerCase();
    if (q.length > 40) throw new InvalidArgument("query: at most 40 characters");
    if (q) rows = GROUPS.filter((g) => g.id.toLowerCase().includes(q) || g.kw.some((k) => k.includes(q)));
  }
  let limit = 15;
  if (rawLimit !== undefined && rawLimit !== null) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 44)
      throw new InvalidArgument("limit must be an integer between 1 and 44");
  }
  return [...rows]
    .sort((a, b) => b.demandCount - a.demandCount)
    .slice(0, limit)
    .map(({ id, demandCount, demandPct }) => ({ id, demandCount, demandPct }));
}

export function yearsDistribution(): { requirement: string; count: number; pct: number }[] {
  const order = (k: string) => (k === "none" ? -1 : Number(k));
  return Object.entries(YEARS_HIST)
    .sort((a, b) => order(a[0]) - order(b[0]))
    .map(([k, count]) => ({
      requirement: k === "none" ? "not stated" : `${k}+ years`,
      count,
      pct: +((count / CORPUS_SIZE) * 100).toFixed(1),
    }));
}
