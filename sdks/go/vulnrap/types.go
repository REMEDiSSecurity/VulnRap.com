package vulnrap

import (
        "encoding/json"
        "fmt"
        "time"
)

// ContentMode controls how submitted content is stored on the server.
type ContentMode string

const (
        // ContentModeFull stores the redacted text alongside the analysis.
        ContentModeFull ContentMode = "full"
        // ContentModeSimilarityOnly stores only hashes (no text body).
        ContentModeSimilarityOnly ContentMode = "similarity_only"
)

// ScoreBreakdown is the per-dimension breakdown of a slop score.
//
// Optional integer fields use *int so callers can distinguish "not computed"
// (nil) from a real zero score.
type ScoreBreakdown struct {
        Linguistic      int  `json:"linguistic"`
        Factual         int  `json:"factual"`
        Template        int  `json:"template"`
        Quality         int  `json:"quality"`
        LLM             *int `json:"llm,omitempty"`
        Verification    *int `json:"verification,omitempty"`
        SubstanceScore  *int `json:"substanceScore,omitempty"`
        CoherenceScore  *int `json:"coherenceScore,omitempty"`
        PocValidity     *int `json:"pocValidity,omitempty"`
        DomainCoherence *int `json:"domainCoherence,omitempty"`
}

// EvidenceItem is one signal that fired during analysis.
type EvidenceItem struct {
        Type        string  `json:"type"`
        Description string  `json:"description"`
        Weight      int     `json:"weight"`
        Matched     *string `json:"matched,omitempty"`
}

// SimilarityMatch describes one report that resembles the submitted one.
type SimilarityMatch struct {
        ReportID   int    `json:"reportId"`
        Similarity int    `json:"similarity"`
        MatchType  string `json:"matchType"`
}

// SectionMatchItem is a section-level similarity match.
type SectionMatchItem struct {
        SectionTitle        string `json:"sectionTitle"`
        MatchedReportID     int    `json:"matchedReportId"`
        MatchedSectionTitle string `json:"matchedSectionTitle"`
        Similarity          int    `json:"similarity"`
}

// RedactionSummary summarises what auto-redaction stripped from the report.
type RedactionSummary struct {
        TotalRedactions int            `json:"totalRedactions"`
        Categories      map[string]int `json:"categories"`
}

// VulnrapEngineResult is one engine's score in the multi-engine composite.
type VulnrapEngineResult struct {
        Engine     string `json:"engine"`
        Score      int    `json:"score"`
        Verdict    string `json:"verdict"`
        Confidence string `json:"confidence"`
        Note       string `json:"note,omitempty"`
}

// VulnrapComposite is the multi-engine consensus score.
type VulnrapComposite struct {
        CompositeScore   int                   `json:"compositeScore"`
        Label            string                `json:"label"`
        Engines          []VulnrapEngineResult `json:"engines"`
        OverridesApplied []string              `json:"overridesApplied"`
        Warnings         []string              `json:"warnings,omitempty"`
        EngineCount      int                   `json:"engineCount,omitempty"`
}

// ReportAnalysis is the response from ScoreReport and LookupReport.
//
// Only the always-present fields are typed strongly. The full server payload
// is also kept on Raw so callers can reach into newer or experimental fields
// without waiting for an SDK release. Use json.Unmarshal on Raw[fieldName] to
// pull additional fields out.
type ReportAnalysis struct {
        ID                int                `json:"id"`
        DeleteToken       string             `json:"deleteToken,omitempty"`
        ContentHash       string             `json:"contentHash"`
        ContentMode       ContentMode        `json:"contentMode"`
        SlopScore         int                `json:"slopScore"`
        SlopTier          string             `json:"slopTier"`
        QualityScore      int                `json:"qualityScore"`
        Confidence        float64            `json:"confidence"`
        Breakdown         ScoreBreakdown     `json:"breakdown"`
        Evidence          []EvidenceItem     `json:"evidence"`
        SimilarityMatches []SimilarityMatch  `json:"similarityMatches"`
        SectionMatches    []SectionMatchItem `json:"sectionMatches"`
        SectionHashes     map[string]string  `json:"sectionHashes,omitempty"`
        RedactedText      *string            `json:"redactedText,omitempty"`
        RedactionSummary  RedactionSummary   `json:"redactionSummary"`
        Feedback          []string           `json:"feedback"`
        LLMSlopScore      *int               `json:"llmSlopScore,omitempty"`
        LLMFeedback       []string           `json:"llmFeedback,omitempty"`
        AuthenticityScore *int               `json:"authenticityScore,omitempty"`
        ValidityScore     *int               `json:"validityScore,omitempty"`
        Quadrant          string             `json:"quadrant,omitempty"`
        Archetype         string             `json:"archetype,omitempty"`
        AnalysisMode      string             `json:"analysisMode,omitempty"`
        LLMEnhanced       bool               `json:"llmEnhanced"`
        LLMFailed         bool               `json:"llmFailed,omitempty"`
        LLMUsed           bool               `json:"llmUsed,omitempty"`
        RedactionApplied  bool               `json:"redactionApplied,omitempty"`
        Vulnrap           *VulnrapComposite  `json:"vulnrap,omitempty"`
        AvriFamily        *string            `json:"avriFamily,omitempty"`
        FileName          *string            `json:"fileName,omitempty"`
        FileSize          int                `json:"fileSize"`
        CreatedAt         time.Time          `json:"createdAt"`

        // Raw holds the unparsed server response so callers can read fields not
        // surfaced by this struct (e.g. diagnostics, triageRecommendation).
        Raw map[string]json.RawMessage `json:"-"`
}

// UnmarshalJSON keeps Raw populated alongside the typed fields.
func (r *ReportAnalysis) UnmarshalJSON(data []byte) error {
        type alias ReportAnalysis
        var typed alias
        if err := json.Unmarshal(data, &typed); err != nil {
                return err
        }
        var raw map[string]json.RawMessage
        if err := json.Unmarshal(data, &raw); err != nil {
                return err
        }
        *r = ReportAnalysis(typed)
        r.Raw = raw
        return nil
}

// CheckResult is the response from TestYourself (POST /reports/check).
//
// The shape mirrors ReportAnalysis but omits storage-only fields (id,
// deleteToken, createdAt) since the server does not persist anything.
type CheckResult struct {
        SlopScore         int                `json:"slopScore"`
        SlopTier          string             `json:"slopTier"`
        QualityScore      int                `json:"qualityScore,omitempty"`
        Confidence        float64            `json:"confidence,omitempty"`
        Breakdown         ScoreBreakdown     `json:"breakdown"`
        Evidence          []EvidenceItem     `json:"evidence,omitempty"`
        SimilarityMatches []SimilarityMatch  `json:"similarityMatches"`
        SectionMatches    []SectionMatchItem `json:"sectionMatches,omitempty"`
        SectionHashes     map[string]string  `json:"sectionHashes,omitempty"`
        RedactionSummary  RedactionSummary   `json:"redactionSummary"`
        Feedback          []string           `json:"feedback,omitempty"`
        LLMSlopScore      *int               `json:"llmSlopScore,omitempty"`
        LLMFeedback       []string           `json:"llmFeedback,omitempty"`
        // LLMEnhanced is required by the OpenAPI spec on `/reports/check`
        // responses (true when the LLM contributed to the score).
        LLMEnhanced bool `json:"llmEnhanced"`
        // PreviouslySubmitted is required by the OpenAPI spec — true when
        // the same report body was already in the database.
        PreviouslySubmitted bool `json:"previouslySubmitted"`
        // ExistingReportID is the matching row when PreviouslySubmitted is true.
        ExistingReportID *int `json:"existingReportId,omitempty"`

        // Raw holds the unparsed server response.
        Raw map[string]json.RawMessage `json:"-"`
}

// UnmarshalJSON keeps Raw populated alongside the typed fields.
func (c *CheckResult) UnmarshalJSON(data []byte) error {
        type alias CheckResult
        var typed alias
        if err := json.Unmarshal(data, &typed); err != nil {
                return err
        }
        var raw map[string]json.RawMessage
        if err := json.Unmarshal(data, &raw); err != nil {
                return err
        }
        *c = CheckResult(typed)
        c.Raw = raw
        return nil
}

// PlatformStats is the response from QueryStats (GET /stats).
type PlatformStats struct {
        TotalReports       int           `json:"totalReports"`
        DuplicatesDetected int           `json:"duplicatesDetected"`
        AvgSlopScore       float64       `json:"avgSlopScore"`
        ReportsByMode      ReportsByMode `json:"reportsByMode"`
        ReportsToday       int           `json:"reportsToday"`
        ReportsThisWeek    int           `json:"reportsThisWeek"`
}

// ReportsByMode counts reports grouped by their privacy mode.
type ReportsByMode struct {
        Full           int `json:"full"`
        SimilarityOnly int `json:"similarity_only"`
}

// APIError is returned when the server responds with a non-2xx status.
type APIError struct {
        StatusCode int
        Message    string
        Body       []byte
}

// Error implements the error interface.
func (e *APIError) Error() string {
        if e.Message != "" {
                return fmt.Sprintf("vulnrap: HTTP %d: %s", e.StatusCode, e.Message)
        }
        return fmt.Sprintf("vulnrap: HTTP %d", e.StatusCode)
}
