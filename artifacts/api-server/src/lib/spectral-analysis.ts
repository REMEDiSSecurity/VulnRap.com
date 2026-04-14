export interface SpectralMarker {
  type: string;
  description: string;
  weight: number;
  value?: number;
}

export interface SpectralResult {
  score: number;
  markers: SpectralMarker[];
}

export function computeSpectralScore(text: string): SpectralResult {
  const markers: SpectralMarker[] = [];

  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const lengths = sentences.map(s => s.trim().split(/\s+/).length);

  if (lengths.length >= 5) {
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance = lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;

    if (cv < 0.25) {
      markers.push({
        type: "low_sentence_variance",
        description: `Sentence length coefficient of variation (${cv.toFixed(2)}) is unusually uniform — characteristic of AI generation`,
        weight: 12,
        value: cv,
      });
    }
  }

  const words = text.toLowerCase().match(/\b[a-z]+\b/g) || [];

  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 20);
  if (paragraphs.length >= 3) {
    const paraLengths = paragraphs.map(p => p.length);
    const paraMean = paraLengths.reduce((a, b) => a + b, 0) / paraLengths.length;
    const paraCV = paraMean > 0
      ? Math.sqrt(paraLengths.reduce((a, b) => a + (b - paraMean) ** 2, 0) / paraLengths.length) / paraMean
      : 0;

    if (paraCV < 0.3) {
      markers.push({
        type: "uniform_paragraphs",
        description: `Paragraph lengths are unusually uniform (CV=${paraCV.toFixed(2)}) — AI tends to produce evenly-sized blocks`,
        weight: 8,
        value: paraCV,
      });
    }
  }

  const hedges = (text.match(/\b(?:potentially|possibly|might|could|may|appears?\s+to|seems?\s+to|likely|approximately)\b/gi) || []).length;
  const hedgeDensity = words.length > 0 ? (hedges / words.length) * 100 : 0;

  if (hedgeDensity > 2.0) {
    markers.push({
      type: "high_hedge_density",
      description: `Hedging language density (${hedgeDensity.toFixed(1)}%) is elevated — AI tends to over-hedge`,
      weight: 6,
      value: hedgeDensity,
    });
  }

  const listItems = text.match(/^[\s]*[-*•]\s+.+$/gm) || [];
  if (listItems.length >= 4) {
    const itemLengths = listItems.map(i => i.trim().length);
    const itemMean = itemLengths.reduce((a, b) => a + b, 0) / itemLengths.length;
    const itemCV = itemMean > 0
      ? Math.sqrt(itemLengths.reduce((a, b) => a + (b - itemMean) ** 2, 0) / itemLengths.length) / itemMean
      : 0;

    if (itemCV < 0.2) {
      markers.push({
        type: "uniform_list_items",
        description: `List items have suspiciously uniform length (CV=${itemCV.toFixed(2)})`,
        weight: 8,
        value: itemCV,
      });
    }
  }

  const connectors = (text.match(/\b(?:Furthermore|Moreover|Additionally|In\s+addition|Consequently|Therefore|However|Nevertheless)\b/gi) || []).length;
  const connectorDensity = sentences.length > 0 ? connectors / sentences.length : 0;

  if (connectorDensity > 0.3) {
    markers.push({
      type: "high_connector_density",
      description: `Formal connector words appear in ${Math.round(connectorDensity * 100)}% of sentences — AI overuses transitions`,
      weight: 8,
    });
  }

  const totalWeight = markers.reduce((sum, f) => sum + f.weight, 0);
  const score = Math.min(100, totalWeight * 2);

  return { score, markers };
}
