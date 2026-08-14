// The tool surface exposed over MCP.
//
// Four named read-only tools and a schema resource — deliberately no generic
// query tool. Descriptions carry the trigger condition ("use this when…"), not
// just the capability, because that is what a model routes on.

import * as ds from "@/lib/dataset";

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
      return `${hits.map(ds.formatCompany).join("\n")}\n\n${ds.UNIT_NOTE}`;
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
      return [...lines, "", ds.UNIT_NOTE].join("\n");
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
