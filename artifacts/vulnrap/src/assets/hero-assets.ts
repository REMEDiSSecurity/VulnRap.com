import slopdemicHeroFull from "./insights-slopdemic-hero.webp";
import slopdemicHero480 from "./insights-slopdemic-hero-480.webp";
import slopdemicHero768 from "./insights-slopdemic-hero-768.webp";
import slopdemicHero1200 from "./insights-slopdemic-hero-1200.webp";

import threePillarsHeroFull from "./engines-three-pillars-hero.webp";
import threePillarsHero480 from "./engines-three-pillars-hero-480.webp";
import threePillarsHero768 from "./engines-three-pillars-hero-768.webp";
import threePillarsHero1200 from "./engines-three-pillars-hero-1200.webp";

import pipelineHeroFull from "./pipeline-cross-section-hero.webp";
import pipelineHero480 from "./pipeline-cross-section-hero-480.webp";
import pipelineHero768 from "./pipeline-cross-section-hero-768.webp";
import pipelineHero1200 from "./pipeline-cross-section-hero-1200.webp";

import avriPortraitFull from "./engines-avri-portrait.webp";
import avriPortrait480 from "./engines-avri-portrait-480.webp";
import avriPortrait768 from "./engines-avri-portrait-768.webp";
import avriPortrait1200 from "./engines-avri-portrait-1200.webp";

import cwePortraitFull from "./engines-cwe-portrait.webp";
import cwePortrait480 from "./engines-cwe-portrait-480.webp";
import cwePortrait768 from "./engines-cwe-portrait-768.webp";
import cwePortrait1200 from "./engines-cwe-portrait-1200.webp";

import linguisticPortraitFull from "./engines-linguistic-portrait.webp";
import linguisticPortrait480 from "./engines-linguistic-portrait-480.webp";
import linguisticPortrait768 from "./engines-linguistic-portrait-768.webp";
import linguisticPortrait1200 from "./engines-linguistic-portrait-1200.webp";

import substancePortraitFull from "./engines-substance-portrait.webp";
import substancePortrait480 from "./engines-substance-portrait-480.webp";
import substancePortrait768 from "./engines-substance-portrait-768.webp";
import substancePortrait1200 from "./engines-substance-portrait-1200.webp";

import methodologyConstellationFull from "./methodology-verification-constellation.webp";
import methodologyConstellation480 from "./methodology-verification-constellation-480.webp";
import methodologyConstellation768 from "./methodology-verification-constellation-768.webp";
import methodologyConstellation1200 from "./methodology-verification-constellation-1200.webp";

import originAnalystWallFull from "./origin-analyst-wall.webp";
import originAnalystWall480 from "./origin-analyst-wall-480.webp";
import originAnalystWall768 from "./origin-analyst-wall-768.webp";
import originAnalystWall1200 from "./origin-analyst-wall-1200.webp";

export interface HeroAsset {
  src: string;
  srcSet: string;
  width: number;
  height: number;
}

function build(
  full: string,
  v480: string,
  v768: string,
  v1200: string,
  fullWidth: number,
  width: number,
  height: number,
): HeroAsset {
  return {
    src: full,
    srcSet: `${v480} 480w, ${v768} 768w, ${v1200} 1200w, ${full} ${fullWidth}w`,
    width,
    height,
  };
}

export const slopdemicHeroAsset = build(
  slopdemicHeroFull,
  slopdemicHero480,
  slopdemicHero768,
  slopdemicHero1200,
  1672,
  1792,
  1024,
);

export const threePillarsHeroAsset = build(
  threePillarsHeroFull,
  threePillarsHero480,
  threePillarsHero768,
  threePillarsHero1200,
  1672,
  1792,
  1024,
);

export const pipelineHeroAsset = build(
  pipelineHeroFull,
  pipelineHero480,
  pipelineHero768,
  pipelineHero1200,
  1928,
  1792,
  768,
);

export const avriPortraitAsset = build(
  avriPortraitFull,
  avriPortrait480,
  avriPortrait768,
  avriPortrait1200,
  1254,
  1024,
  1024,
);

export const cwePortraitAsset = build(
  cwePortraitFull,
  cwePortrait480,
  cwePortrait768,
  cwePortrait1200,
  1448,
  1280,
  960,
);

export const linguisticPortraitAsset = build(
  linguisticPortraitFull,
  linguisticPortrait480,
  linguisticPortrait768,
  linguisticPortrait1200,
  1536,
  1536,
  1024,
);

export const substancePortraitAsset = build(
  substancePortraitFull,
  substancePortrait480,
  substancePortrait768,
  substancePortrait1200,
  1448,
  1536,
  1024,
);

export const methodologyConstellationAsset = build(
  methodologyConstellationFull,
  methodologyConstellation480,
  methodologyConstellation768,
  methodologyConstellation1200,
  1254,
  1792,
  896,
);

export const originAnalystWallAsset = build(
  originAnalystWallFull,
  originAnalystWall480,
  originAnalystWall768,
  originAnalystWall1200,
  1672,
  1792,
  896,
);
