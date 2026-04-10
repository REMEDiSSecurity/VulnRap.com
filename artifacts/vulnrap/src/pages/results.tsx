import { useParams } from "wouter";
import { useGetReport, getGetReportQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, CheckCircle, Copy, AlertTriangle, FileText, Clock, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

function anonymizeId(id: number): string {
  const hex = id.toString(16).padStart(4, "0");
  return `VR-${hex.toUpperCase()}`;
}

function getSlopColor(score: number) {
  if (score < 30) return "text-green-500";
  if (score < 70) return "text-yellow-500";
  return "text-destructive";
}

function getSlopProgressColor(score: number) {
  if (score < 30) return "bg-green-500";
  if (score < 70) return "bg-yellow-500";
  return "bg-destructive";
}

export default function Results() {
  const params = useParams<{ id: string }>();
  const id = parseInt(params.id || "0", 10);
  const { toast } = useToast();

  const { data: report, isLoading, isError } = useGetReport(id, {
    query: {
      enabled: !!id,
      queryKey: getGetReportQueryKey(id)
    }
  });

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    toast({ title: "Link copied", description: "Shareable link copied to clipboard." });
  };

  const copyHash = (hash: string) => {
    navigator.clipboard.writeText(hash);
    toast({ title: "Hash copied", description: "Content hash copied to clipboard." });
  };

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto space-y-6">
        <Skeleton className="h-12 w-1/3" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Skeleton className="h-48 md:col-span-2" />
          <Skeleton className="h-48" />
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (isError || !report) {
    return (
      <div className="max-w-4xl mx-auto text-center py-12">
        <AlertTriangle className="w-12 h-12 text-destructive mx-auto mb-4" />
        <h2 className="text-2xl font-bold">Report not found</h2>
        <p className="text-muted-foreground mt-2">The requested report could not be loaded or doesn't exist.</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-6">
        <div>
          <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-2">
            <FileText className="w-8 h-8 text-primary" />
            Analysis Results
          </h1>
          <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              <Clock className="w-4 h-4" />
              {new Date(report.createdAt).toLocaleString()}
            </span>
            <span className="flex items-center gap-1">
              <Badge variant="outline" className="uppercase text-xs">{report.contentMode.replace("_", " ")}</Badge>
            </span>
          </div>
        </div>
        <Button variant="outline" onClick={copyLink} className="gap-2">
          <Copy className="w-4 h-4" />
          Share Link
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Slop Score Card */}
        <Card className="md:col-span-2 border-primary/20 bg-card/40 backdrop-blur">
          <CardHeader>
            <CardTitle className="uppercase tracking-wide text-sm text-muted-foreground">AI Sloppiness Score</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center justify-center py-6">
            <div className={`text-7xl font-bold font-mono tracking-tighter ${getSlopColor(report.slopScore)}`}>
              {report.slopScore}
            </div>
            <div className="mt-4 text-xl font-medium tracking-wide uppercase">
              {report.slopTier}
            </div>
            <div className="w-full max-w-md mt-8 space-y-2">
              <div className="flex justify-between text-xs text-muted-foreground font-mono">
                <span>0 (Human)</span>
                <span>100 (Pure AI Slop)</span>
              </div>
              <Progress value={report.slopScore} className="h-2" indicatorClassName={getSlopProgressColor(report.slopScore)} />
            </div>
          </CardContent>
        </Card>

        {/* Metadata Card */}
        <Card className="bg-card/40 backdrop-blur">
          <CardHeader>
            <CardTitle className="uppercase tracking-wide text-sm text-muted-foreground">File Metadata</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="text-xs text-muted-foreground uppercase mb-1">File Name</div>
              <div className="font-mono text-sm truncate" title={report.fileName || "Unknown"}>
                {report.fileName || "Unknown"}
              </div>
            </div>
            <Separator />
            <div>
              <div className="text-xs text-muted-foreground uppercase mb-1">File Size</div>
              <div className="font-mono text-sm">
                {(report.fileSize / 1024).toFixed(2)} KB
              </div>
            </div>
            <Separator />
            <div>
              <div className="text-xs text-muted-foreground uppercase mb-1 flex items-center justify-between">
                SHA-256 Hash
                <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => copyHash(report.contentHash)}>
                  <Copy className="w-3 h-3" />
                </Button>
              </div>
              <div className="font-mono text-xs truncate text-primary" title={report.contentHash}>
                {report.contentHash}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Similarity Matches */}
      <Card className="bg-card/40 backdrop-blur border-border">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Search className="w-5 h-5 text-primary" />
            Similarity Analysis
          </CardTitle>
          <CardDescription>Comparison against previously submitted reports</CardDescription>
        </CardHeader>
        <CardContent>
          {report.similarityMatches && report.similarityMatches.length > 0 ? (
            <div className="space-y-6">
              {report.similarityMatches.map((match, i) => (
                <div key={i} className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="font-mono text-sm">
                      Match <span className="text-primary">{anonymizeId(match.reportId)}</span>
                    </span>
                    <Badge variant={match.similarity > 80 ? "destructive" : "secondary"}>
                      {match.matchType}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-4">
                    <Progress value={match.similarity} className="flex-1 h-2" indicatorClassName={match.similarity > 80 ? "bg-destructive" : "bg-primary"} />
                    <span className="font-mono text-sm w-12 text-right">{Math.round(match.similarity)}%</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
              <CheckCircle className="w-12 h-12 text-green-500 mb-4" />
              <p className="font-medium text-foreground">No significant similarities found</p>
              <p className="text-sm">This report appears to be unique in our database.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Actionable Feedback */}
      <Card className="bg-card/40 backdrop-blur border-border">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertCircle className="w-5 h-5 text-primary" />
            Analysis Feedback
          </CardTitle>
          <CardDescription>Observations based on structural and linguistic patterns</CardDescription>
        </CardHeader>
        <CardContent>
          {report.feedback && report.feedback.length > 0 ? (
            <ul className="space-y-3">
              {report.feedback.map((item, i) => (
                <li key={i} className="flex items-start gap-3 bg-muted/50 p-3 rounded-md">
                  <div className="mt-0.5 w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />
                  <span className="text-sm leading-relaxed">{item}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground py-4">No specific feedback generated for this report.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
