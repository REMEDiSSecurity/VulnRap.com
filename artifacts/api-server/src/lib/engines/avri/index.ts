// Public surface of the AVRI module.

export { FAMILIES, FAMILIES_BY_ID, FLAT_FAMILY, familyForCweNumber } from "./families";
export type { FamilyId, FamilyRubric } from "./families";
export { classifyReport } from "./classify";
export type { ClassificationResult, ClassificationConfidence } from "./classify";
export { runEngine2Avri } from "./engine2-avri";
export { runEngine3Avri } from "./engine3-avri";
export { runAvriComposite } from "./composite";
export type { AvriCompositeResult, AvriCompositeOptions } from "./composite";
export { recordAndScore as recordVelocity, peek as peekVelocity, __resetVelocityForTests } from "./velocity";
export { recordAndScore as recordTemplate, peek as peekTemplate, structuralFingerprint, __resetFingerprintsForTests } from "./template-fingerprint";
export { ancestorsOf, normalizeCweId, hierarchySize } from "./hierarchy";
