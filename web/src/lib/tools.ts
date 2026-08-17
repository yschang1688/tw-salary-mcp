// The tool surface exposed over MCP.
//
// Seven named read-only tools and a schema resource — deliberately no generic
// query tool. Descriptions carry the trigger condition ("use this when…"), not
// just the capability, because that is what a model routes on.
//
// Two tool families share the server, and they sit at different evidence tiers —
// the descriptions and stamps keep them apart on purpose:
//   salary family  = MOPS statutory disclosures. Census-grade: every listed
//                    company, statutory filing, no self-selection.
//   fit family     = a versioned skill dictionary + demand aggregates over a
//                    private 1,086-posting corpus. Deterministic and dated,
//                    but corpus-scoped, self-collected evidence.
// Never let the fit family borrow the census family's authority.
// The fit family holds no personal data: callers supply their own skills.

import * as ds from "@/lib/dataset";
import * as fit from "@/lib/fit";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => string;
}

export const TOOLS: ToolDef[] = [
  {
    name: "lookup_company",
    description:
      "Look up one company's salary disclosure by TWSE/TPEx stock code or name. " +
      "Use this when the question names a specific Taiwanese listed company and needs its pay level, " +
      "headcount, or where it ranks. Names match as a substring, so a short query can return several companies.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: 'A 4-6 digit stock code (e.g. "2330"), or part of a company name (e.g. "台積").',
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    run: (args) => {
      const hits = ds.findCompanies(args.query);
      const q = String(args.query ?? "").trim();
      if (!hits.length) {
        return `No listed company matches '${q}'. It may be private or below the disclosure threshold.`;
      }
      if (hits.length > 10) {
        const names = hits.slice(0, 10).map((c) => `${c.name}(${c.code})`).join(", ");
        return `${hits.length} companies match '${q}'. Narrow the query, or pick a code. First 10: ${names}`;
      }
      return `${hits.map(ds.formatCompany).join("\n")}\n\n${ds.UNIT_NOTE}\n${ds.SALARY_STAMP}`;
    },
  },

  {
    name: "industry_stats",
    description:
      "Summarise the pay distribution within one industry. " +
      "Use this whenever you need to judge whether a company's pay is high or low for its sector — " +
      "an absolute figure means little without the sector baseline.",
    inputSchema: {
      type: "object",
      properties: {
        industry: {
          type: "string",
          description: 'Industry name or part of one, e.g. "半導體", "航運業", "電子通路".',
        },
      },
      required: ["industry"],
      additionalProperties: false,
    },
    run: (args) => {
      const s = ds.industryStats(args.industry);
      if (!s) return `No industry matches '${String(args.industry ?? "").trim()}'.`;
      return [
        `Industry '${s.industry}' (${s.year}): ${s.companyCount} companies`,
        `median of medians: ${s.medianOfMedians} 萬/yr`,
        `p25: ${s.p25} | p75: ${s.p75} | range: ${s.min}-${s.max}`,
        "",
        "Highest-paying in this industry:",
        ...s.companies.slice(0, 5).map((c, i) => `  ${i + 1}. ${ds.formatCompany(c)}`),
        "",
        ds.UNIT_NOTE,
        ds.SALARY_STAMP,
      ].join("\n");
    },
  },

  {
    name: "top_by_median",
    description:
      "Rank companies by non-managerial median pay, highest first, with optional industry and floor filters. " +
      "Use this for 'which companies pay the most' questions, or to build a shortlist within a sector.",
    inputSchema: {
      type: "object",
      properties: {
        industry: { type: "string", description: "Optional industry filter (substring). Omit for all industries." },
        min_median: { type: "number", description: "Optional floor in 萬元/yr, e.g. 120 keeps only medians >= NT$1.2M." },
        limit: { type: "integer", description: "How many to return (1-50; larger values are clamped to 50)." },
      },
      additionalProperties: false,
    },
    run: (args) => {
      const hits = ds.topByMedian({
        industry: args.industry,
        minMedian: args.min_median,
        limit: args.limit,
      });
      if (!hits.length) return "No company matches those filters.";
      const scope = args.industry ? `industry '${args.industry}'` : "all industries";
      const floor = args.min_median ? `, median >= ${args.min_median} 萬` : "";
      return [
        `Top ${hits.length} by median pay (${scope}${floor}):`,
        ...hits.map((c, i) => `  ${i + 1}. ${ds.formatCompany(c)}`),
        "",
        ds.UNIT_NOTE,
        ds.SALARY_STAMP,
      ].join("\n");
    },
  },

  {
    name: "company_trend",
    description:
      "Show one company's median pay for every year on record (2019-2025). " +
      "Use this when the question is about direction over time — whether pay is rising, flat, or falling — " +
      "rather than the current level.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: 'A 4-6 digit TWSE/TPEx stock code, e.g. "2330".' },
      },
      required: ["code"],
      additionalProperties: false,
    },
    run: (args) => {
      const t = ds.companyTrend(args.code);
      if (!t) return `No disclosure on record for code '${String(args.code ?? "").trim()}'.`;
      const series = Object.entries(t.series)
        .map(([y, v]) => `${y}: ${v ?? "n/a"}`)
        .join(" -> ");
      const lines = [
        `${t.name} (${t.code}) median pay by year:`,
        `  ${series}`,
        t.changePct != null
          ? `  ${t.firstYear}->${t.lastYear}: ${t.changePct > 0 ? "+" : ""}${t.changePct}%`
          : "  change: n/a",
      ];
      if (t.missingYears.length) {
        lines.push(
          `  Not disclosed in: ${t.missingYears.join(", ")} (below the disclosure threshold, or not yet listed)`,
        );
      }
      return [...lines, "", ds.UNIT_NOTE, ds.SALARY_STAMP].join("\n");
    },
  },

  {
    name: "analyze_jd",
    description:
      "Deterministic JD breakdown: which skill groups a job description asks for, each with its " +
      "demand share in a fixed 1,086-posting corpus of Taiwanese data/AI roles, plus the stated " +
      "years-of-experience requirement. Same JD, same answer — versioned dictionary, word-boundary " +
      "matching, no generation. Use this instead of freestyling a JD summary when the answer needs " +
      "to be reproducible or auditable. Corpus-scoped evidence (self-collected), not census data.",
    inputSchema: {
      type: "object",
      properties: {
        jd: { type: "string", description: "The job description text (requirements section is enough). 30-20000 chars." },
      },
      required: ["jd"],
      additionalProperties: false,
    },
    run: (args) => {
      const a = fit.analyzeJd(args.jd);
      if (!a.matched.length) {
        return (
          `None of the ${a.groupsChecked} skill groups match this text. ` +
          "The dictionary covers data/AI/software roles — for other fields the result is expected to be empty.\n" +
          fit.FIT_STAMP
        );
      }
      const rows = [...a.matched].sort((x, y) => y.demandPct - x.demandPct);
      return [
        `Matched ${rows.length}/${a.groupsChecked} skill groups (demand % = share of corpus postings asking for it):`,
        ...rows.map((m) => `  - ${m.id}  [corpus demand ${m.demandPct}%]  via: ${m.hits.join(", ")}`),
        a.yearsRequired
          ? `Experience required: ${a.yearsRequired.n}+ years ("${a.yearsRequired.matched}")`
          : "Experience required: not stated",
        "",
        fit.FIT_STAMP,
      ].join("\n");
    },
  },

  {
    name: "skill_gaps",
    description:
      "Deterministic gap report: compare a job description against the skills the caller supplies, " +
      "and say which of the JD's asks are covered, which are gaps, and which supplied skills the " +
      "dictionary cannot place (reported, never silently dropped). Use this when 'am I qualified?' " +
      "needs a reproducible answer rather than an impression. The server stores nothing — skills " +
      "exist only for this call. Corpus-scoped evidence, not census data.",
    inputSchema: {
      type: "object",
      properties: {
        jd: { type: "string", description: "The job description text. 30-20000 chars." },
        skills: {
          type: "array",
          items: { type: "string" },
          description: 'The user\'s skills as short strings, e.g. ["python", "sql", "airflow", "教育訓練"]. Max 100.',
        },
      },
      required: ["jd", "skills"],
      additionalProperties: false,
    },
    run: (args) => {
      const g = fit.skillGaps(args.jd, args.skills);
      const lines: string[] = [];
      if (g.covered.length) {
        lines.push(`Covered (${g.covered.length}):`);
        lines.push(...g.covered.map((c) => `  ✓ ${c.id}  (your: ${c.via.join(", ")})`));
      }
      if (g.missing.length) {
        lines.push(`Gaps (${g.missing.length}) — the JD asks, none of the supplied skills match:`);
        lines.push(
          ...[...g.missing]
            .sort((x, y) => y.demandPct - x.demandPct)
            .map((m) => `  ✗ ${m.id}  [corpus demand ${m.demandPct}%]  JD asked via: ${m.hits.join(", ")}`),
        );
      }
      if (!g.covered.length && !g.missing.length) {
        lines.push("The JD matched no dictionary group — nothing to compare against.");
      }
      if (g.unmatchedSkills.length) {
        lines.push(
          `Not in the dictionary (${g.unmatchedSkills.length}): ${g.unmatchedSkills.join(", ")} — ` +
            "no claim either way about these.",
        );
      }
      lines.push(
        g.yearsRequired
          ? `Experience required: ${g.yearsRequired.n}+ years`
          : "Experience required: not stated",
      );
      lines.push(fit.FIT_STAMP);
      return lines.join("\n");
    },
  },

  {
    name: "market_demand",
    description:
      "Rank skill groups by how many corpus postings ask for them, optionally filtered by a name " +
      "fragment; also reports the years-of-experience distribution. Use this for 'what is in " +
      "demand?' or 'how common is X?' questions about Taiwanese data/AI roles. Unlike a model's " +
      "recollection, these are counts over an actual dated corpus — but they describe that corpus " +
      "only; the stamp in the output says which vintage you are quoting.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: 'Optional group-name or keyword fragment, e.g. "python", "雲端". Omit to rank all.' },
        limit: { type: "integer", description: "How many groups to return (1-44, default 15)." },
      },
      additionalProperties: false,
    },
    run: (args) => {
      const rows = fit.marketDemand(args.query, args.limit);
      if (!rows.length) return `No skill group matches '${String(args.query ?? "").trim()}'.\n${fit.FIT_STAMP}`;
      const years = fit
        .yearsDistribution()
        .map((y) => `${y.requirement} ${y.pct}%`)
        .join(" | ");
      return [
        `Skill-group demand across ${fit.CORPUS_SIZE} postings:`,
        ...rows.map((r, i) => `  ${i + 1}. ${r.id}  ${r.demandCount} postings (${r.demandPct}%)`),
        "",
        `Years-of-experience requirements: ${years}`,
        "",
        fit.FIT_STAMP,
      ].join("\n");
    },
  },
];

export const RESOURCES = [
  {
    uri: "salary://schema",
    name: "schema",
    description: "What this dataset contains, where it came from, and how to read it.",
    mimeType: "text/plain",
    read: () => ds.SCHEMA_TEXT,
  },
];
