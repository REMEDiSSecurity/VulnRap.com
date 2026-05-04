package vulnrap

import (
        "context"
        "encoding/json"
        "io"
        "mime/multipart"
        "net/http"
        "net/http/httptest"
        "strings"
        "testing"
        "time"
)

func TestNewClientDefaults(t *testing.T) {
        c := NewClient()
        if c.baseURL != DefaultBaseURL {
                t.Errorf("baseURL = %q, want %q", c.baseURL, DefaultBaseURL)
        }
        if c.httpClient == nil {
                t.Fatal("httpClient is nil")
        }
        if c.userAgent == "" {
                t.Error("userAgent is empty")
        }
}

func TestNewClientOptions(t *testing.T) {
        custom := &http.Client{Timeout: 5 * time.Second}
        c := NewClient(
                WithBaseURL("https://staging.example/api"),
                WithHTTPClient(custom),
                WithUserAgent("my-app/1.2"),
        )
        if c.baseURL != "https://staging.example/api" {
                t.Errorf("baseURL not overridden: %q", c.baseURL)
        }
        if c.httpClient != custom {
                t.Error("httpClient not overridden")
        }
        if c.userAgent != "my-app/1.2" {
                t.Errorf("userAgent = %q", c.userAgent)
        }
}

func TestJoinURL(t *testing.T) {
        cases := []struct {
                base string
                path string
                want string
        }{
                {"https://vulnrap.com/api", "/reports", "https://vulnrap.com/api/reports"},
                {"https://vulnrap.com/api/", "/reports", "https://vulnrap.com/api/reports"},
                {"https://vulnrap.com", "/stats", "https://vulnrap.com/stats"},
                {"https://vulnrap.com/api", "/reports/42", "https://vulnrap.com/api/reports/42"},
        }
        for _, tc := range cases {
                got, err := joinURL(tc.base, tc.path)
                if err != nil {
                        t.Errorf("joinURL(%q,%q) error: %v", tc.base, tc.path, err)
                        continue
                }
                if got != tc.want {
                        t.Errorf("joinURL(%q,%q) = %q, want %q", tc.base, tc.path, got, tc.want)
                }
        }
}

func TestScoreReportRequiresContent(t *testing.T) {
        c := NewClient()
        if _, err := c.ScoreReport(context.Background(), &ScoreReportInput{}); err == nil {
                t.Fatal("expected error when no content provided")
        }
        if _, err := c.ScoreReport(context.Background(), nil); err == nil {
                t.Fatal("expected error for nil input")
        }
        if _, err := c.ScoreReport(context.Background(), &ScoreReportInput{RawText: "x", ReportURL: "https://example/r.md"}); err == nil {
                t.Fatal("expected error when multiple sources provided")
        }
}

// TestScoreReportRoundtrip exercises the full happy path against an httptest
// server: the SDK should marshal a multipart body with the right fields and
// decode the JSON response into a typed ReportAnalysis.
func TestScoreReportRoundtrip(t *testing.T) {
        var (
                gotMethod      string
                gotPath        string
                gotContentType string
                gotRawText     string
                gotMode        string
                gotShowInFeed  string
                gotSkipLLM     string
                gotUA          string
        )

        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                gotMethod = r.Method
                gotPath = r.URL.Path
                gotContentType = r.Header.Get("Content-Type")
                gotUA = r.Header.Get("User-Agent")

                mr, err := r.MultipartReader()
                if err != nil {
                        http.Error(w, "multipart parse: "+err.Error(), http.StatusBadRequest)
                        return
                }
                for {
                        part, perr := mr.NextPart()
                        if perr == io.EOF {
                                break
                        }
                        if perr != nil {
                                http.Error(w, perr.Error(), http.StatusBadRequest)
                                return
                        }
                        body, _ := io.ReadAll(part)
                        switch part.FormName() {
                        case "rawText":
                                gotRawText = string(body)
                        case "contentMode":
                                gotMode = string(body)
                        case "showInFeed":
                                gotShowInFeed = string(body)
                        case "skipLlm":
                                gotSkipLLM = string(body)
                        }
                }

                w.Header().Set("Content-Type", "application/json")
                w.WriteHeader(http.StatusCreated)
                json.NewEncoder(w).Encode(map[string]interface{}{
                        "id":           42,
                        "deleteToken":  "tok-abc",
                        "contentHash":  "deadbeef",
                        "contentMode":  "full",
                        "slopScore":    23,
                        "slopTier":     "LOW",
                        "qualityScore": 78,
                        "confidence":   0.83,
                        "breakdown": map[string]interface{}{
                                "linguistic": 10, "factual": 5, "template": 8, "quality": 78,
                        },
                        "evidence":          []interface{}{},
                        "similarityMatches": []interface{}{},
                        "sectionMatches":    []interface{}{},
                        "redactionSummary": map[string]interface{}{
                                "totalRedactions": 0, "categories": map[string]int{},
                        },
                        "feedback":    []string{"looks human"},
                        "llmEnhanced": false,
                        "fileSize":    1024,
                        "createdAt":   "2026-05-02T18:00:00Z",
                })
        }))
        defer srv.Close()

        c := NewClient(WithBaseURL(srv.URL))
        res, err := c.ScoreReport(context.Background(), &ScoreReportInput{
                RawText:    "Found a path traversal in /api/files",
                ShowInFeed: true,
        })
        if err != nil {
                t.Fatalf("ScoreReport error: %v", err)
        }

        if gotMethod != http.MethodPost {
                t.Errorf("method = %q, want POST", gotMethod)
        }
        if gotPath != "/reports" {
                t.Errorf("path = %q, want /reports", gotPath)
        }
        if !strings.HasPrefix(gotContentType, "multipart/form-data") {
                t.Errorf("Content-Type = %q, want multipart/form-data", gotContentType)
        }
        if !strings.Contains(gotUA, "vulnrap-go/") {
                t.Errorf("User-Agent = %q, expected vulnrap-go/ prefix", gotUA)
        }
        if gotRawText == "" {
                t.Error("rawText form field was empty")
        }
        if gotMode != "full" {
                t.Errorf("contentMode = %q, want full", gotMode)
        }
        if gotShowInFeed != "true" {
                t.Errorf("showInFeed = %q, want true", gotShowInFeed)
        }
        if gotSkipLLM != "false" {
                t.Errorf("skipLlm = %q, want false", gotSkipLLM)
        }

        if res.ID != 42 {
                t.Errorf("res.ID = %d, want 42", res.ID)
        }
        if res.SlopScore != 23 {
                t.Errorf("res.SlopScore = %d, want 23", res.SlopScore)
        }
        if res.DeleteToken != "tok-abc" {
                t.Errorf("res.DeleteToken = %q, want tok-abc", res.DeleteToken)
        }
        if res.Breakdown.Linguistic != 10 {
                t.Errorf("res.Breakdown.Linguistic = %d, want 10", res.Breakdown.Linguistic)
        }
        if len(res.Feedback) != 1 || res.Feedback[0] != "looks human" {
                t.Errorf("res.Feedback = %v, want [looks human]", res.Feedback)
        }
        // Raw should be populated alongside typed fields.
        if _, ok := res.Raw["createdAt"]; !ok {
                t.Error("res.Raw missing createdAt")
        }
}

func TestLookupReport(t *testing.T) {
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                if r.Method != http.MethodGet || r.URL.Path != "/reports/7" {
                        http.Error(w, "unexpected: "+r.Method+" "+r.URL.Path, http.StatusBadRequest)
                        return
                }
                w.Header().Set("Content-Type", "application/json")
                json.NewEncoder(w).Encode(map[string]interface{}{
                        "id": 7, "contentHash": "abc", "contentMode": "full",
                        "slopScore": 5, "slopTier": "LOW", "qualityScore": 90,
                        "confidence":        0.9,
                        "breakdown":         map[string]interface{}{"linguistic": 0, "factual": 0, "template": 0, "quality": 90},
                        "evidence":          []interface{}{},
                        "similarityMatches": []interface{}{},
                        "sectionMatches":    []interface{}{},
                        "redactionSummary":  map[string]interface{}{"totalRedactions": 0, "categories": map[string]int{}},
                        "feedback":          []string{},
                        "llmEnhanced":       false,
                        "fileSize":          0,
                        "createdAt":         "2026-05-02T18:00:00Z",
                })
        }))
        defer srv.Close()

        c := NewClient(WithBaseURL(srv.URL))
        res, err := c.LookupReport(context.Background(), 7)
        if err != nil {
                t.Fatalf("LookupReport error: %v", err)
        }
        if res.ID != 7 {
                t.Errorf("res.ID = %d, want 7", res.ID)
        }

        if _, err := c.LookupReport(context.Background(), 0); err == nil {
                t.Error("expected error for non-positive id")
        }
}

func TestQueryStats(t *testing.T) {
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                if r.URL.Path != "/stats" {
                        http.Error(w, "wrong path", http.StatusNotFound)
                        return
                }
                w.Header().Set("Content-Type", "application/json")
                json.NewEncoder(w).Encode(map[string]interface{}{
                        "totalReports":       1234,
                        "duplicatesDetected": 56,
                        "avgSlopScore":       42.5,
                        "reportsByMode":      map[string]int{"full": 1000, "similarity_only": 234},
                        "reportsToday":       7,
                        "reportsThisWeek":    49,
                })
        }))
        defer srv.Close()

        c := NewClient(WithBaseURL(srv.URL))
        stats, err := c.QueryStats(context.Background())
        if err != nil {
                t.Fatalf("QueryStats error: %v", err)
        }
        if stats.TotalReports != 1234 {
                t.Errorf("TotalReports = %d, want 1234", stats.TotalReports)
        }
        if stats.ReportsByMode.Full != 1000 || stats.ReportsByMode.SimilarityOnly != 234 {
                t.Errorf("ReportsByMode = %+v", stats.ReportsByMode)
        }
}

func TestTestYourselfWithFile(t *testing.T) {
        var gotFileName string
        var gotFileBody string

        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                if r.URL.Path != "/reports/check" {
                        http.Error(w, "wrong path", http.StatusNotFound)
                        return
                }
                mr, err := r.MultipartReader()
                if err != nil {
                        http.Error(w, err.Error(), http.StatusBadRequest)
                        return
                }
                for {
                        part, perr := mr.NextPart()
                        if perr == io.EOF {
                                break
                        }
                        if perr != nil {
                                http.Error(w, perr.Error(), http.StatusBadRequest)
                                return
                        }
                        body, _ := io.ReadAll(part)
                        if part.FormName() == "file" {
                                gotFileName = part.FileName()
                                gotFileBody = string(body)
                        }
                }
                w.Header().Set("Content-Type", "application/json")
                json.NewEncoder(w).Encode(map[string]interface{}{
                        "slopScore": 11, "slopTier": "LOW",
                        "breakdown":         map[string]interface{}{"linguistic": 1, "factual": 2, "template": 3, "quality": 80},
                        "similarityMatches": []interface{}{},
                        "redactionSummary":  map[string]interface{}{"totalRedactions": 0, "categories": map[string]int{}},
                })
        }))
        defer srv.Close()

        c := NewClient(WithBaseURL(srv.URL))
        res, err := c.TestYourself(context.Background(), &TestYourselfInput{
                File:     strings.NewReader("crash trace here"),
                FileName: "report.txt",
        })
        if err != nil {
                t.Fatalf("TestYourself error: %v", err)
        }
        if gotFileName != "report.txt" {
                t.Errorf("file name = %q, want report.txt", gotFileName)
        }
        if gotFileBody != "crash trace here" {
                t.Errorf("file body = %q", gotFileBody)
        }
        if res.SlopScore != 11 {
                t.Errorf("res.SlopScore = %d, want 11", res.SlopScore)
        }
}

// TestCheckResultRecommendationPresent verifies that when the server includes a
// recommendation object it is decoded into the typed Recommendation field.
func TestCheckResultRecommendationPresent(t *testing.T) {
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "application/json")
                json.NewEncoder(w).Encode(map[string]interface{}{
                        "slopScore": 15, "slopTier": "LOW",
                        "breakdown":         map[string]interface{}{"linguistic": 1, "factual": 2, "template": 3, "quality": 80},
                        "similarityMatches": []interface{}{},
                        "redactionSummary":  map[string]interface{}{"totalRedactions": 0, "categories": map[string]int{}},
                        "recommendation": map[string]interface{}{
                                "action":             "CHALLENGE_REPORTER",
                                "reason":             "low composite, suspect phrasing",
                                "challengeQuestions": []string{"Can you share a PoC?", "What version is affected?"},
                        },
                })
        }))
        defer srv.Close()

        c := NewClient(WithBaseURL(srv.URL))
        res, err := c.TestYourself(context.Background(), &TestYourselfInput{RawText: "test"})
        if err != nil {
                t.Fatalf("TestYourself error: %v", err)
        }
        if res.Recommendation == nil {
                t.Fatal("Recommendation is nil, want non-nil")
        }
        if res.Recommendation.Action != "CHALLENGE_REPORTER" {
                t.Errorf("Action = %q, want CHALLENGE_REPORTER", res.Recommendation.Action)
        }
        if res.Recommendation.Reason != "low composite, suspect phrasing" {
                t.Errorf("Reason = %q", res.Recommendation.Reason)
        }
        if len(res.Recommendation.ChallengeQuestions) != 2 {
                t.Errorf("ChallengeQuestions len = %d, want 2", len(res.Recommendation.ChallengeQuestions))
        }
}

// TestCheckResultRecommendationAbsent verifies that when the server omits
// recommendation the field is nil rather than a zero-value struct.
func TestCheckResultRecommendationAbsent(t *testing.T) {
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "application/json")
                json.NewEncoder(w).Encode(map[string]interface{}{
                        "slopScore": 5, "slopTier": "LOW",
                        "breakdown":         map[string]interface{}{"linguistic": 0, "factual": 0, "template": 0, "quality": 90},
                        "similarityMatches": []interface{}{},
                        "redactionSummary":  map[string]interface{}{"totalRedactions": 0, "categories": map[string]int{}},
                })
        }))
        defer srv.Close()

        c := NewClient(WithBaseURL(srv.URL))
        res, err := c.TestYourself(context.Background(), &TestYourselfInput{RawText: "test"})
        if err != nil {
                t.Fatalf("TestYourself error: %v", err)
        }
        if res.Recommendation != nil {
                t.Errorf("Recommendation = %+v, want nil", res.Recommendation)
        }
}

// TestReportAnalysisRecommendationPresent verifies that recommendation is also
// decoded on ReportAnalysis (ScoreReport / LookupReport responses).
func TestReportAnalysisRecommendationPresent(t *testing.T) {
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "application/json")
                w.WriteHeader(http.StatusCreated)
                json.NewEncoder(w).Encode(map[string]interface{}{
                        "id": 99, "contentHash": "abc", "contentMode": "full",
                        "slopScore": 80, "slopTier": "HIGH", "qualityScore": 20,
                        "confidence":        0.9,
                        "breakdown":         map[string]interface{}{"linguistic": 20, "factual": 10, "template": 30, "quality": 20},
                        "evidence":          []interface{}{},
                        "similarityMatches": []interface{}{},
                        "sectionMatches":    []interface{}{},
                        "redactionSummary":  map[string]interface{}{"totalRedactions": 0, "categories": map[string]int{}},
                        "feedback":          []string{},
                        "llmEnhanced":       false,
                        "fileSize":          0,
                        "createdAt":         "2026-05-04T00:00:00Z",
                        "recommendation": map[string]interface{}{
                                "action": "AUTO_CLOSE",
                                "reason": "composite below threshold",
                        },
                })
        }))
        defer srv.Close()

        c := NewClient(WithBaseURL(srv.URL))
        res, err := c.ScoreReport(context.Background(), &ScoreReportInput{RawText: "test"})
        if err != nil {
                t.Fatalf("ScoreReport error: %v", err)
        }
        if res.Recommendation == nil {
                t.Fatal("Recommendation is nil, want non-nil")
        }
        if res.Recommendation.Action != "AUTO_CLOSE" {
                t.Errorf("Action = %q, want AUTO_CLOSE", res.Recommendation.Action)
        }
        if res.Recommendation.Reason != "composite below threshold" {
                t.Errorf("Reason = %q", res.Recommendation.Reason)
        }
        if res.Recommendation.ChallengeQuestions != nil {
                t.Errorf("ChallengeQuestions = %v, want nil", res.Recommendation.ChallengeQuestions)
        }
}

// TestReportAnalysisRecommendationAbsent verifies that Recommendation is nil
// on ReportAnalysis when the server omits the field.
func TestReportAnalysisRecommendationAbsent(t *testing.T) {
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "application/json")
                w.WriteHeader(http.StatusCreated)
                json.NewEncoder(w).Encode(map[string]interface{}{
                        "id": 55, "contentHash": "abc", "contentMode": "full",
                        "slopScore": 10, "slopTier": "LOW", "qualityScore": 88,
                        "confidence":        0.85,
                        "breakdown":         map[string]interface{}{"linguistic": 2, "factual": 1, "template": 1, "quality": 88},
                        "evidence":          []interface{}{},
                        "similarityMatches": []interface{}{},
                        "sectionMatches":    []interface{}{},
                        "redactionSummary":  map[string]interface{}{"totalRedactions": 0, "categories": map[string]int{}},
                        "feedback":          []string{},
                        "llmEnhanced":       false,
                        "fileSize":          0,
                        "createdAt":         "2026-05-04T00:00:00Z",
                })
        }))
        defer srv.Close()

        c := NewClient(WithBaseURL(srv.URL))
        res, err := c.ScoreReport(context.Background(), &ScoreReportInput{RawText: "test"})
        if err != nil {
                t.Fatalf("ScoreReport error: %v", err)
        }
        if res.Recommendation != nil {
                t.Errorf("Recommendation = %+v, want nil", res.Recommendation)
        }
}

func TestAPIErrorOnNon2xx(t *testing.T) {
        srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                w.Header().Set("Content-Type", "application/json")
                w.WriteHeader(http.StatusTooManyRequests)
                w.Write([]byte(`{"error":"rate limit exceeded"}`))
        }))
        defer srv.Close()

        c := NewClient(WithBaseURL(srv.URL))
        _, err := c.QueryStats(context.Background())
        if err == nil {
                t.Fatal("expected error")
        }
        apiErr, ok := err.(*APIError)
        if !ok {
                t.Fatalf("err type = %T, want *APIError (msg=%v)", err, err)
        }
        if apiErr.StatusCode != http.StatusTooManyRequests {
                t.Errorf("StatusCode = %d, want 429", apiErr.StatusCode)
        }
        if apiErr.Message != "rate limit exceeded" {
                t.Errorf("Message = %q", apiErr.Message)
        }
        if !strings.Contains(apiErr.Error(), "429") {
                t.Errorf("Error() = %q", apiErr.Error())
        }
}

// Compile-time assertion that the multipart writer is the one we expect, so a
// breaking stdlib change shows up here.
var _ = multipart.NewWriter
