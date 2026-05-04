import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ExternalLink, Plug } from "lucide-react";
import { MarkdownRecipe } from "@/components/markdown-recipe";
import hackeroneSource from "../../../api-server/docs/integrations/hackerone.md?raw";
import bugcrowdSource from "../../../api-server/docs/integrations/bugcrowd.md?raw";
import intigritiSource from "../../../api-server/docs/integrations/intigriti.md?raw";

type RecipeMeta = {
  slug: string;
  title: string;
  platform: string;
  source: string;
  githubPath: string;
};

const RECIPES: Record<string, RecipeMeta> = {
  hackerone: {
    slug: "hackerone",
    title: "HackerOne integration recipe",
    platform: "HackerOne",
    source: hackeroneSource,
    githubPath:
      "https://github.com/vulnrap/vulnrap/blob/main/artifacts/api-server/docs/integrations/hackerone.md",
  },
  bugcrowd: {
    slug: "bugcrowd",
    title: "Bugcrowd integration recipe",
    platform: "Bugcrowd",
    source: bugcrowdSource,
    githubPath:
      "https://github.com/vulnrap/vulnrap/blob/main/artifacts/api-server/docs/integrations/bugcrowd.md",
  },
  intigriti: {
    slug: "intigriti",
    title: "Intigriti integration recipe",
    platform: "Intigriti",
    source: intigritiSource,
    githubPath:
      "https://github.com/vulnrap/vulnrap/blob/main/artifacts/api-server/docs/integrations/intigriti.md",
  },
};

export const INTEGRATION_RECIPE_SLUGS = Object.keys(RECIPES);

export default function IntegrationRecipe() {
  const { slug = "" } = useParams<{ slug: string }>();
  const recipe = RECIPES[slug];

  if (!recipe) {
    return (
      <div className="max-w-3xl mx-auto py-12">
        <Link
          to="/developers"
          className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
          data-testid="link-back-to-developers"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to API documentation
        </Link>
        <h1 className="text-3xl font-bold mt-6 mb-2">Recipe not found</h1>
        <p className="text-muted-foreground">
          We don't have an integration recipe for{" "}
          <code className="font-mono">{slug || "(empty)"}</code>. Available:{" "}
          {INTEGRATION_RECIPE_SLUGS.join(", ")}.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto" data-testid="integration-recipe-page">
      <div className="border-b border-border pb-6 mb-6">
        <Link
          to="/developers"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors mb-4"
          data-testid="link-back-to-developers"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to API documentation
        </Link>

        <div className="flex items-start justify-between flex-wrap gap-3">
          <h1 className="text-3xl font-bold uppercase tracking-tight flex items-center gap-3">
            <Plug className="w-8 h-8 text-primary" />
            {recipe.platform}
          </h1>
          <a
            href={recipe.githubPath}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors"
            data-testid={`link-${recipe.slug}-recipe-github`}
          >
            View on GitHub
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
        <p className="text-sm text-muted-foreground mt-2">
          End-to-end recipe for plugging VulnRap into your {recipe.platform}{" "}
          triage queue. Pure docs — copy the scripts, adapt to your environment.
        </p>
      </div>

      <article className="prose-recipe">
        <MarkdownRecipe source={recipe.source} />
      </article>
    </div>
  );
}
