import { useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  Copy,
  Check,
  Monitor,
  Terminal,
  Plug,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const mcpServerBlock = `"vulnrap": {
  "command": "npx",
  "args": ["-y", "@vulnrap/mcp-server@latest"],
  "env": {
    "VULNRAP_API_BASE": "https://vulnrap.com"
  }
}`;

interface ClientConfig {
  id: string;
  name: string;
  configSnippet: string;
  paths: { os: string; path: string }[];
  notes?: string;
}

const clients: ClientConfig[] = [
  {
    id: "claude",
    name: "Claude Desktop",
    configSnippet: `{
  "mcpServers": {
${mcpServerBlock.split("\n").map((l) => "    " + l).join("\n")}
  }
}`,
    paths: [
      { os: "macOS", path: "~/Library/Application Support/Claude/claude_desktop_config.json" },
      { os: "Windows", path: "%APPDATA%\\Claude\\claude_desktop_config.json" },
      { os: "Linux", path: "~/.config/Claude/claude_desktop_config.json" },
    ],
    notes: "Restart Claude Desktop after saving.",
  },
  {
    id: "cursor",
    name: "Cursor",
    configSnippet: `{
  "mcpServers": {
${mcpServerBlock.split("\n").map((l) => "    " + l).join("\n")}
  }
}`,
    paths: [
      { os: "macOS", path: "~/.cursor/mcp.json" },
      { os: "Windows", path: "%USERPROFILE%\\.cursor\\mcp.json" },
      { os: "Linux", path: "~/.cursor/mcp.json" },
    ],
    notes: "Restart Cursor after saving. You can also add the snippet via Settings \u2192 MCP.",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    configSnippet: `{
  "mcpServers": {
${mcpServerBlock.split("\n").map((l) => "    " + l).join("\n")}
  }
}`,
    paths: [
      { os: "macOS", path: "~/.codeium/windsurf/mcp_config.json" },
      { os: "Windows", path: "%USERPROFILE%\\.codeium\\windsurf\\mcp_config.json" },
      { os: "Linux", path: "~/.codeium/windsurf/mcp_config.json" },
    ],
    notes: "Restart Windsurf after saving.",
  },
  {
    id: "zed",
    name: "Zed",
    configSnippet: `{
  "context_servers": {
    "vulnrap": {
      "command": {
        "path": "npx",
        "args": ["-y", "@vulnrap/mcp-server@latest"],
        "env": {
          "VULNRAP_API_BASE": "https://vulnrap.com"
        }
      }
    }
  }
}`,
    paths: [
      { os: "macOS", path: "~/.config/zed/settings.json" },
      { os: "Windows", path: "%APPDATA%\\Zed\\settings.json" },
      { os: "Linux", path: "~/.config/zed/settings.json" },
    ],
    notes: "Merge into your existing settings.json. Zed uses \"context_servers\" instead of \"mcpServers\".",
  },
  {
    id: "continue",
    name: "Continue",
    configSnippet: `{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "npx",
          "args": ["-y", "@vulnrap/mcp-server@latest"],
          "env": {
            "VULNRAP_API_BASE": "https://vulnrap.com"
          }
        }
      }
    ]
  }
}`,
    paths: [
      { os: "macOS", path: "~/.continue/config.json" },
      { os: "Windows", path: "%USERPROFILE%\\.continue\\config.json" },
      { os: "Linux", path: "~/.continue/config.json" },
    ],
    notes: "Merge the \"experimental\" block into your existing config.json.",
  },
];

function CopyButton({ value, testId }: { value: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }}
      className="absolute top-3 right-3 p-1.5 rounded-md bg-muted/50 hover:bg-muted text-muted-foreground hover:text-primary transition-all sm:opacity-0 sm:group-hover:opacity-100"
      aria-label="Copy to clipboard"
      data-testid={testId}
    >
      {copied ? (
        <Check className="w-3.5 h-3.5 text-emerald-400" />
      ) : (
        <Copy className="w-3.5 h-3.5" />
      )}
    </button>
  );
}

function ClientSection({ client }: { client: ClientConfig }) {
  return (
    <Card className="bg-card/60 border-border/50" id={`client-${client.id}`}>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Plug className="w-4 h-4 text-primary" />
          {client.name}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-1.5">
            <Monitor className="w-3.5 h-3.5" />
            Config file location
          </h4>
          <div className="grid gap-1.5">
            {client.paths.map(({ os, path }) => (
              <div key={os} className="flex items-center gap-2 text-sm">
                <Badge
                  variant="outline"
                  className="text-[10px] shrink-0 min-w-[60px] justify-center border-primary/20 text-muted-foreground"
                >
                  {os}
                </Badge>
                <code className="text-xs text-foreground/90 break-all">{path}</code>
              </div>
            ))}
          </div>
        </div>

        <div>
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-1.5">
            <Terminal className="w-3.5 h-3.5" />
            Configuration snippet
          </h4>
          <div className="relative group">
            <pre className="bg-black/40 border border-border/50 rounded-md p-4 text-xs text-foreground/90 overflow-x-auto">
              <code>{client.configSnippet}</code>
            </pre>
            <CopyButton
              value={client.configSnippet}
              testId={`copy-${client.id}`}
            />
          </div>
        </div>

        {client.notes && (
          <p className="text-xs text-muted-foreground/80 leading-relaxed">
            {client.notes}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

const TAB_IDS = clients.map((c) => c.id);

export default function ConnectPage() {
  const [activeTab, setActiveTab] = useState<string>("claude");

  const activeClient = clients.find((c) => c.id === activeTab)!;

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-2">
        <Link
          to="/blog"
          className="text-muted-foreground hover:text-primary transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
          Connect Your Agent
        </h1>
      </div>

      <p className="text-sm text-muted-foreground leading-relaxed max-w-2xl">
        Wire VulnRap into your AI coding assistant in under a minute. Pick your
        client below, copy the snippet into the config file, and restart. No API
        keys, no accounts &mdash; the server runs locally via{" "}
        <code className="text-foreground/90">npx</code>.
      </p>

      <div className="flex flex-wrap gap-1.5 border-b border-border/50 pb-px">
        {TAB_IDS.map((id) => {
          const client = clients.find((c) => c.id === id)!;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              className={cn(
                "px-3 py-1.5 text-sm font-medium rounded-t-md transition-all border-b-2",
                activeTab === id
                  ? "text-primary border-primary bg-primary/5"
                  : "text-muted-foreground border-transparent hover:text-primary hover:bg-primary/5",
              )}
            >
              {client.name}
            </button>
          );
        })}
      </div>

      <ClientSection client={activeClient} />

      <Card className="bg-card/60 border-border/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Available tools</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid sm:grid-cols-3 gap-4">
            <div className="space-y-1">
              <code className="text-sm text-primary font-semibold">score_report</code>
              <p className="text-xs text-muted-foreground">
                Full multi-axis validity scoring with per-engine breakdown.
              </p>
            </div>
            <div className="space-y-1">
              <code className="text-sm text-primary font-semibold">find_similar</code>
              <p className="text-xs text-muted-foreground">
                Similarity lookup using MinHash, SimHash, and section-level hashes.
              </p>
            </div>
            <div className="space-y-1">
              <code className="text-sm text-primary font-semibold">redact</code>
              <p className="text-xs text-muted-foreground">
                Auto-redact PII (emails, IPs, keys, company names) from report text.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="text-xs text-muted-foreground/70 space-y-1">
        <p>
          The MCP server source lives at{" "}
          <a
            href="https://github.com/REMEDiSSecurity/VulnRap.Com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            github.com/REMEDiSSecurity/VulnRap.Com
          </a>{" "}
          under <code>artifacts/mcp-server/</code>.
        </p>
        <p>
          Read the{" "}
          <Link to="/blog" className="text-primary hover:underline">
            MCP launch blog post
          </Link>{" "}
          for background and example agent prompts.
        </p>
      </div>
    </div>
  );
}
