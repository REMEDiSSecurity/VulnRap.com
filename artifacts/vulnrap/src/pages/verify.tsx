import { useParams, Link } from "react-router-dom";
import { useGetVerification, getGetVerificationQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { ShieldCheck, AlertTriangle, CheckCircle, Copy, ExternalLink, Hash, Clock, Search } from "lucide-react";
import logoSrc from "@/assets/logo.png";

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

export default function Verify() {
  const params = useParams<{ id: string }>();
  const id = parseInt(params.id || "0", 10);
  const { toast } = useToast();

  const { data, isLoading, isError } = useGetVerification(id, {
    query: {
      enabled: !!id,
      queryKey: getGetVerificationQueryKey(id),
    },
  });

  if (isLoading) {
    return (
      <div className="max-w-2xl mx-auto space-y-6 py-8">
        <Skeleton className="h-12 w-1/2 mx-auto" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="max-w-2xl mx-auto text-center py-16">
        <AlertTriangle className="w-12 h-12 text-destructive mx-auto mb-4" />
        <h2 className="text-2xl font-bold">Verification Not Found</h2>
        <p className="text-muted-foreground mt-2">This report ID does not exist or has been removed.</p>
      </div>
    );
  }

  const copyHash = () => {
    navigator.clipboard.writeText(data.contentHash);
    toast({ title: "Copied", description: "Content hash copied to clipboard." });
  };

  return (
    <div className="max-w-2xl mx-auto space-y-8 py-4">
      <div className="text-center space-y-3">
        <div className="flex justify-center">
          <img src={logoSrc} alt="VulnRap" className="w-14 h-14 rounded-lg shadow-lg shadow-primary/20 border border-primary/20" />
        </div>
        <h1 className="text-2xl font-bold uppercase tracking-tight text-primary">Report Verification</h1>
        <p className="text-sm text-muted-foreground">Independent verification of vulnerability report {data.reportCode}</p>
      </div>

      <Card className="border-primary/20 bg-card/40 backdrop-blur">
        <CardHeader className="text-center pb-2">
          <CardTitle className="flex items-center justify-center gap-2 text-lg">
            <ShieldCheck className="w-5 h-5 text-green-500" />
            Verified Report: {data.reportCode}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex flex-col items-center py-4">
            <div className={`text-6xl font-bold font-mono tracking-tighter ${getSlopColor(data.slopScore)}`}>
              {data.slopScore}
            </div>
            <div className="mt-2 text-lg font-medium tracking-wide uppercase">
              {data.slopTier}
            </div>
            <div className="w-full max-w-sm mt-6 space-y-1">
              <div className="flex justify-between text-xs text-muted-foreground font-mono">
                <span>0 (Human)</span>
                <span>100 (AI Slop)</span>
              </div>
              <Progress value={data.slopScore} className="h-2" indicatorClassName={getSlopProgressColor(data.slopScore)} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="bg-muted/50 rounded-lg p-4 text-center">
              <Search className="w-5 h-5 text-primary mx-auto mb-1" />
              <div className="text-2xl font-bold font-mono">{data.similarityMatchCount}</div>
              <div className="text-xs text-muted-foreground">Similar Reports</div>
            </div>
            <div className="bg-muted/50 rounded-lg p-4 text-center">
              <Hash className="w-5 h-5 text-primary mx-auto mb-1" />
              <div className="text-2xl font-bold font-mono">{data.sectionMatchCount}</div>
              <div className="text-xs text-muted-foreground">Section Matches</div>
            </div>
          </div>

          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between bg-muted/30 rounded-lg p-3">
              <span className="text-muted-foreground flex items-center gap-2">
                <Clock className="w-4 h-4" />
                Submitted
              </span>
              <span className="font-mono text-xs">{new Date(data.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</span>
            </div>
            <div className="flex items-center justify-between bg-muted/30 rounded-lg p-3">
              <span className="text-muted-foreground flex items-center gap-2">
                <Hash className="w-4 h-4" />
                Content Hash
              </span>
              <div className="flex items-center gap-1">
                <span className="font-mono text-xs text-primary truncate max-w-[180px]">{data.contentHash.slice(0, 16)}...</span>
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={copyHash}>
                  <Copy className="w-3 h-3" />
                </Button>
              </div>
            </div>
          </div>

          {data.slopScore < 30 && data.similarityMatchCount === 0 && (
            <div className="flex items-center gap-3 bg-green-500/10 border border-green-500/20 rounded-lg p-4">
              <CheckCircle className="w-6 h-6 text-green-500 flex-shrink-0" />
              <div>
                <div className="font-medium text-sm text-green-400">Clean Report</div>
                <div className="text-xs text-muted-foreground">This report shows no AI-generation signals and no duplicates in our database.</div>
              </div>
            </div>
          )}

          <div className="text-center pt-2">
            <Link to={`/results/${data.id}`}>
              <Button variant="outline" size="sm" className="gap-2">
                <ExternalLink className="w-4 h-4" />
                View Full Analysis
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground text-center">
        This verification was generated by VulnRap. <Link to="/privacy" className="text-primary hover:underline">Privacy Policy</Link>
      </p>
    </div>
  );
}
