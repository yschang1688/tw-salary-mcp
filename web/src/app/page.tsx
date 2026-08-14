const TOOLS: [string, string][] = [
  ["lookup_company", "One company by stock code or name."],
  ["industry_stats", "Pay distribution within a sector — the baseline a single figure needs."],
  ["top_by_median", "Rank by median pay, with industry and floor filters."],
  ["company_trend", "One company's median, 2019 to 2025."],
];

export default function Home() {
  return (
    <main
      style={{
        maxWidth: 640,
        margin: "0 auto",
        padding: "3rem 1.25rem",
        font: "16px/1.65 ui-sans-serif, system-ui, sans-serif",
        color: "#1a1a1a",
      }}
    >
      <h1 style={{ fontSize: "1.5rem", marginBottom: ".25rem" }}>salary-db</h1>
      <p style={{ color: "#666", marginTop: 0 }}>
        A remote MCP server over the MOPS salary disclosures for 1,826 TWSE/TPEx listed
        companies, 2019&ndash;2025. Runs on the edge.
      </p>

      <h2 style={{ fontSize: "1rem", marginTop: "2rem" }}>Connect</h2>
      <p>Add this URL as a remote MCP server in any MCP client:</p>
      <pre
        style={{
          background: "#f5f5f4",
          padding: ".75rem 1rem",
          borderRadius: 6,
          overflowX: "auto",
          fontSize: ".875rem",
        }}
      >
        <code>https://salary-mcp-beige.vercel.app/mcp</code>
      </pre>

      <h2 style={{ fontSize: "1rem", marginTop: "2rem" }}>Tools</h2>
      <ul style={{ paddingLeft: "1.1rem" }}>
        {TOOLS.map(([name, desc]) => (
          <li key={name} style={{ marginBottom: ".4rem" }}>
            <code>{name}</code> &mdash; {desc}
          </li>
        ))}
      </ul>

      <h2 style={{ fontSize: "1rem", marginTop: "2rem" }}>On the tool surface</h2>
      <p>
        Four named read-only tools, and deliberately no generic query tool. A general{" "}
        <code>query</code> endpoint hands the full expressive power of a query language to the
        model &mdash; and to anything that can inject into it. Arguments are validated and clamped
        server-side; malformed input returns a short message, never a stack trace or a path.
      </p>
      <p style={{ color: "#666", fontSize: ".9rem" }}>
        Figures are 萬元 (NT$10,000) per year, non-managerial full-time staff. Company-level public
        aggregates only &mdash; no personal data. A company absent in a year was below the
        disclosure threshold or not yet listed; that is reported as null, never as zero.
      </p>
    </main>
  );
}
