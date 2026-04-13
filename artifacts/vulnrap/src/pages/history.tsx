import { useState } from "react";
import { Link } from "react-router-dom";
import { Clock, Trash2, FileText, Search, AlertTriangle, CheckCircle, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { getHistory, clearHistory, removeHistoryEntry, type HistoryEntry } from "@/lib/history";
import { getSettings, getSlopColorCustom, getSlopProgressColorCustom } from "@/lib/settings";

function timeAgo(date: string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(date).toLocaleDateString();
}

export default function History() {
  const [entries, setEntries] = useState<HistoryEntry[]>(getHistory());
  const settings = getSettings();

  const handleClearAll = () => {
    clearHistory();
    setEntries([]);
  };

  const handleRemove = (id: number, type: "submit" | "check") => {
    removeHistoryEntry(id, type);
    setEntries(getHistory());
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6 sm:space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 sm:pb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold uppercase tracking-tight flex items-center gap-2 glow-text">
            <Clock className="w-6 h-6 sm:w-8 sm:h-8 text-primary shrink-0" />
            Session History
          </h1>
          <p className="text-sm text-muted-foreground mt-2 max-w-2xl leading-relaxed">
            Reports you have analyzed in this browser. Stored locally — nothing leaves your machine.
          </p>
        </div>
        {entries.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleClearAll}
            className="gap-2 glass-card hover:border-destructive/30 text-destructive hover:text-destructive shrink-0"
          >
            <Trash2 className="w-4 h-4" />
            Clear History
          </Button>
        )}
      </div>
      <div className="h-px bg-gradient-to-r from-primary/30 via-primary/10 to-transparent -mt-4" />

      {entries.length === 0 ? (
        <Card className="glass-card rounded-xl">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
            <div className="p-4 rounded-full icon-glow-green mb-4">
              <Clock className="w-12 h-12 text-primary/50" />
            </div>
            <p className="font-medium text-foreground">No history yet</p>
            <p className="text-sm mt-1">Reports you submit or check will appear here.</p>
            <div className="flex gap-3 mt-6">
              <Button asChild variant="outline" className="gap-2 glass-card">
                <Link to="/">
                  <FileText className="w-4 h-4" />
                  Submit a Report
                </Link>
              </Button>
              <Button asChild variant="outline" className="gap-2 glass-card">
                <Link to="/check">
                  <Search className="w-4 h-4" />
                  Check a Report
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => {
            const slopColor = getSlopColorCustom(entry.slopScore, settings.slopThresholdLow, settings.slopThresholdHigh);
            const progressColor = getSlopProgressColorCustom(entry.slopScore, settings.slopThresholdLow, settings.slopThresholdHigh);
            return (
              <Card key={`${entry.type}-${entry.id}`} className="glass-card rounded-xl group">
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        {entry.type === "submit" ? (
                          <Link
                            to={`/results/${entry.id}`}
                            className="font-mono text-sm text-primary hover:underline glow-text-sm"
                          >
                            {entry.reportCode}
                          </Link>
                        ) : (
                          <span className="font-mono text-sm text-muted-foreground">
                            {entry.reportCode}
                          </span>
                        )}
                        <Badge
                          variant="outline"
                          className={`text-[10px] px-1.5 py-0 h-4 ${
                            entry.type === "submit"
                              ? "border-primary/30 text-primary"
                              : "border-muted-foreground/30 text-muted-foreground"
                          }`}
                        >
                          {entry.type === "submit" ? "Submitted" : "Checked"}
                        </Badge>
                        {entry.fileName && (
                          <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                            {entry.fileName}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-2">
                        <div className="flex items-center gap-2 flex-1 max-w-xs">
                          <span className={`font-mono text-sm font-bold ${slopColor}`}>
                            {entry.slopScore}
                          </span>
                          <Progress
                            value={entry.slopScore}
                            className="h-1.5 flex-1"
                            indicatorClassName={progressColor}
                          />
                        </div>
                        <span className="text-xs text-muted-foreground">{entry.slopTier}</span>
                        {entry.matchCount > 0 && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                            {entry.matchCount} match{entry.matchCount !== 1 ? "es" : ""}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-xs text-muted-foreground hidden sm:inline">
                        {timeAgo(entry.timestamp)}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleRemove(entry.id, entry.type)}
                        className="p-1.5 rounded-md text-muted-foreground/30 hover:text-destructive hover:bg-destructive/10 transition-colors sm:opacity-0 sm:group-hover:opacity-100"
                        title="Remove from history"
                      >
                        <XCircle className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {entries.length > 0 && (
        <div className="text-center text-xs text-muted-foreground/50 pb-4">
          <p>History is stored in your browser's local storage. It is never sent to our servers.</p>
        </div>
      )}
    </div>
  );
}
