// Single source of truth for deriving the AVRI Engine 2 fabricated-
// evidence booleans from a vulnrap_engine_results blob. Shared by the
// insert path, the feed row mapper, and the backfill script so all
// three agree on the scoping (engine name matches /Technical Substance/i).

export interface FabricatedEvidenceFlags {
  fakeRawHttp: boolean;
  strippedCrashTrace: boolean;
}

interface EngineLike {
  engine?: string;
  signalBreakdown?: {
    avri?: {
      rawHttp?: { isFake?: boolean } | null;
      crashTrace?: { isStripped?: boolean } | null;
    };
  };
}

interface EngineResultsBlob {
  engines?: EngineLike[];
}

export function deriveFabricatedEvidenceFlags(
  vulnrapEngineResults: unknown,
): FabricatedEvidenceFlags {
  const engines =
    ((vulnrapEngineResults ?? {}) as EngineResultsBlob).engines ?? [];
  const e2Avri = engines.find((e) =>
    /Technical Substance/i.test(e?.engine ?? ""),
  )?.signalBreakdown?.avri;
  return {
    fakeRawHttp: e2Avri?.rawHttp?.isFake === true,
    strippedCrashTrace: e2Avri?.crashTrace?.isStripped === true,
  };
}
