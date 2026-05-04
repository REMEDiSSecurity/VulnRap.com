import { useState, type ReactNode } from "react";
import { Copy, Check } from "lucide-react";

function CopyBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group my-4" data-testid="recipe-code-block">
      {language && (
        <div className="absolute top-2 left-3 text-[10px] font-mono uppercase tracking-wider text-muted-foreground/60 select-none">
          {language}
        </div>
      )}
      <pre className="glass-card rounded-xl p-4 pt-7 text-sm font-mono whitespace-pre overflow-x-auto leading-relaxed text-muted-foreground">
        <code>{code}</code>
      </pre>
      <button
        onClick={handleCopy}
        aria-label="Copy code"
        className="absolute top-2 right-2 p-1.5 rounded-md bg-muted/50 hover:bg-muted text-muted-foreground hover:text-primary transition-all sm:opacity-0 sm:group-hover:opacity-100"
      >
        {copied ? (
          <Check className="w-3.5 h-3.5" />
        ) : (
          <Copy className="w-3.5 h-3.5" />
        )}
      </button>
    </div>
  );
}

type Block =
  | { type: "heading"; level: number; content: string }
  | { type: "paragraph"; content: string }
  | { type: "blockquote"; content: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "code"; language: string; content: string }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "hr" };

function parseRow(line: string): string[] {
  return line
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  const isListLine = (l: string) => /^[-*] /.test(l);
  const isOrderedLine = (l: string) => /^\d+\.\s/.test(l);

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ type: "code", language, content: buf.join("\n") });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1].length,
        content: heading[2],
      });
      i++;
      continue;
    }

    if (line.startsWith(">")) {
      const buf: string[] = [];
      while (
        i < lines.length &&
        (lines[i].startsWith(">") || lines[i].trim() === "")
      ) {
        if (lines[i].trim() === "") {
          if (
            i + 1 < lines.length &&
            (lines[i + 1].startsWith(">") || lines[i + 1].trim() === "")
          ) {
            buf.push("");
            i++;
            continue;
          }
          break;
        }
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "blockquote", content: buf.join("\n").trim() });
      continue;
    }

    if (isListLine(line)) {
      const items: string[] = [];
      while (i < lines.length && isListLine(lines[i])) {
        let item = lines[i].slice(2);
        i++;
        while (
          i < lines.length &&
          /^ {2,}\S/.test(lines[i]) &&
          !isListLine(lines[i].trimStart())
        ) {
          item += "\n" + lines[i].replace(/^ {2}/, "");
          i++;
        }
        items.push(item);
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    if (isOrderedLine(line)) {
      const items: string[] = [];
      while (i < lines.length && isOrderedLine(lines[i])) {
        let item = lines[i].replace(/^\d+\.\s/, "");
        i++;
        while (
          i < lines.length &&
          /^ {2,}\S/.test(lines[i]) &&
          !isOrderedLine(lines[i].trimStart())
        ) {
          item += "\n" + lines[i].replace(/^ {2,}/, "");
          i++;
        }
        items.push(item);
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    if (
      line.startsWith("|") &&
      i + 1 < lines.length &&
      /^\|[\s:|-]+\|/.test(lines[i + 1])
    ) {
      const headers = parseRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !lines[i].startsWith("```") &&
      !lines[i].startsWith(">") &&
      !isListLine(lines[i]) &&
      !isOrderedLine(lines[i]) &&
      !lines[i].startsWith("|")
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ type: "paragraph", content: buf.join(" ") });
  }

  return blocks;
}

const INLINE_RE =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]]+\]\([^)\s]+\))/;

export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let key = 0;
  while (rest.length > 0) {
    const m = rest.match(INLINE_RE);
    if (!m || m.index === undefined) {
      out.push(<span key={`t${key++}`}>{rest}</span>);
      break;
    }
    if (m.index > 0) {
      out.push(<span key={`t${key++}`}>{rest.slice(0, m.index)}</span>);
    }
    const tok = m[0];
    if (tok.startsWith("`")) {
      out.push(
        <code
          key={`c${key++}`}
          className="font-mono text-[0.85em] px-1 py-0.5 bg-muted/40 rounded text-foreground"
        >
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("**")) {
      out.push(
        <strong key={`b${key++}`} className="font-semibold text-foreground">
          {tok.slice(2, -2)}
        </strong>,
      );
    } else if (tok.startsWith("*")) {
      out.push(<em key={`i${key++}`}>{tok.slice(1, -1)}</em>);
    } else {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      if (lm) {
        const url = lm[2];
        const isExternal = /^https?:\/\//.test(url);
        out.push(
          <a
            key={`l${key++}`}
            href={url}
            target={isExternal ? "_blank" : undefined}
            rel={isExternal ? "noopener noreferrer" : undefined}
            className="text-primary hover:underline"
          >
            {lm[1]}
          </a>,
        );
      } else {
        out.push(<span key={`t${key++}`}>{tok}</span>);
      }
    }
    rest = rest.slice(m.index + tok.length);
  }
  return out;
}

function renderBlock(b: Block, key: number): ReactNode {
  switch (b.type) {
    case "heading": {
      const sizes = [
        "text-3xl font-bold mt-2 mb-4",
        "text-2xl font-bold mt-10 mb-3 border-b border-border pb-2",
        "text-xl font-semibold mt-8 mb-2",
        "text-lg font-semibold mt-6 mb-2",
        "text-base font-semibold mt-4 mb-1",
        "text-sm font-semibold mt-4 mb-1",
      ];
      const cls = sizes[Math.min(b.level, 6) - 1];
      const content = renderInline(b.content);
      const id = b.content
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 80);
      const props = { key, id, className: cls };
      if (b.level === 1) return <h1 {...props}>{content}</h1>;
      if (b.level === 2) return <h2 {...props}>{content}</h2>;
      if (b.level === 3) return <h3 {...props}>{content}</h3>;
      if (b.level === 4) return <h4 {...props}>{content}</h4>;
      if (b.level === 5) return <h5 {...props}>{content}</h5>;
      return <h6 {...props}>{content}</h6>;
    }
    case "paragraph":
      return (
        <p key={key} className="text-sm text-muted-foreground leading-relaxed my-3">
          {renderInline(b.content)}
        </p>
      );
    case "blockquote":
      return (
        <blockquote
          key={key}
          className="border-l-2 border-primary/40 bg-muted/20 pl-4 py-2 my-4 italic text-sm text-muted-foreground"
        >
          {b.content.split("\n\n").map((para, i) => (
            <p key={i} className={i > 0 ? "mt-2" : ""}>
              {renderInline(para)}
            </p>
          ))}
        </blockquote>
      );
    case "ul":
      return (
        <ul
          key={key}
          className="list-disc pl-6 space-y-1.5 my-3 text-sm text-muted-foreground"
        >
          {b.items.map((it, i) => (
            <li key={i} className="leading-relaxed">
              {renderInline(it.replace(/\n/g, " "))}
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol
          key={key}
          className="list-decimal pl-6 space-y-1.5 my-3 text-sm text-muted-foreground"
        >
          {b.items.map((it, i) => (
            <li key={i} className="leading-relaxed">
              {renderInline(it.replace(/\n/g, " "))}
            </li>
          ))}
        </ol>
      );
    case "code":
      return (
        <CopyBlock key={key} code={b.content} language={b.language || undefined} />
      );
    case "table":
      return (
        <div key={key} className="my-4 overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-border">
                {b.headers.map((h, i) => (
                  <th
                    key={i}
                    className="text-left font-semibold text-foreground px-3 py-2"
                  >
                    {renderInline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, ri) => (
                <tr key={ri} className="border-b border-border/50">
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      className="px-3 py-2 text-muted-foreground align-top"
                    >
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      return <hr key={key} className="my-8 border-border" />;
  }
}

export function MarkdownRecipe({ source }: { source: string }) {
  const blocks = parseBlocks(source);
  return (
    <div data-testid="markdown-recipe">
      {blocks.map((b, i) => renderBlock(b, i))}
    </div>
  );
}
