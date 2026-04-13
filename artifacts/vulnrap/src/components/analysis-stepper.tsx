import { useEffect, useState } from "react";
import { CheckCircle, Loader2, Circle } from "lucide-react";
import { cn } from "@/lib/utils";

interface Step {
  id: string;
  label: string;
  description: string;
}

const ANALYSIS_STEPS: Step[] = [
  { id: "upload", label: "Upload", description: "Receiving report content" },
  { id: "redact", label: "Redact", description: "Scanning for PII & secrets" },
  { id: "linguistic", label: "Linguistic", description: "AI phrase detection" },
  { id: "factual", label: "Factual", description: "Verifying claims & CVEs" },
  { id: "template", label: "Template", description: "Template fingerprinting" },
  { id: "llm", label: "LLM", description: "Semantic analysis" },
  { id: "triage", label: "Triage", description: "Generating guidance" },
];

const CHECK_STEPS: Step[] = [
  { id: "upload", label: "Upload", description: "Receiving report content" },
  { id: "redact", label: "Redact", description: "Scanning for PII & secrets" },
  { id: "linguistic", label: "Linguistic", description: "AI phrase detection" },
  { id: "factual", label: "Factual", description: "Verifying claims & CVEs" },
  { id: "similarity", label: "Similarity", description: "Comparing against database" },
  { id: "scoring", label: "Scoring", description: "Computing final score" },
];

interface AnalysisStepperProps {
  isActive: boolean;
  mode?: "submit" | "check";
  className?: string;
}

export function AnalysisStepper({ isActive, mode = "submit", className }: AnalysisStepperProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const steps = mode === "submit" ? ANALYSIS_STEPS : CHECK_STEPS;

  useEffect(() => {
    if (!isActive) {
      setCurrentStep(0);
      return;
    }

    setCurrentStep(0);
    const baseDelay = mode === "submit" ? 900 : 700;
    const timers: ReturnType<typeof setTimeout>[] = [];

    steps.forEach((_, i) => {
      if (i === 0) return;
      const delay = i <= 2
        ? baseDelay * i
        : baseDelay * 2 + (i - 2) * (baseDelay * 1.3);
      timers.push(setTimeout(() => setCurrentStep(i), delay));
    });

    return () => timers.forEach(clearTimeout);
  }, [isActive, mode, steps.length]);

  if (!isActive) return null;

  return (
    <div className={cn("w-full max-w-md mx-auto", className)}>
      <div className="space-y-0.5">
        {steps.map((step, i) => {
          const state = i < currentStep ? "done" : i === currentStep ? "active" : "pending";
          return (
            <div key={step.id} className="flex items-center gap-3">
              <div className="flex flex-col items-center w-5">
                {state === "done" ? (
                  <CheckCircle className="w-4 h-4 text-green-400 animate-in zoom-in duration-200" />
                ) : state === "active" ? (
                  <Loader2 className="w-4 h-4 text-primary animate-spin" />
                ) : (
                  <Circle className="w-3.5 h-3.5 text-muted-foreground/30" />
                )}
                {i < steps.length - 1 && (
                  <div className={cn(
                    "w-px h-3 mt-0.5",
                    state === "done" ? "bg-green-400/40" : "bg-muted-foreground/10"
                  )} />
                )}
              </div>
              <div className={cn(
                "flex-1 flex items-center justify-between py-0.5 transition-opacity duration-300",
                state === "pending" ? "opacity-30" : "opacity-100"
              )}>
                <span className={cn(
                  "text-xs font-medium",
                  state === "active" ? "text-primary" : state === "done" ? "text-muted-foreground" : "text-muted-foreground/50"
                )}>
                  {step.label}
                </span>
                <span className={cn(
                  "text-[10px]",
                  state === "active" ? "text-primary/70" : "text-muted-foreground/40"
                )}>
                  {step.description}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
