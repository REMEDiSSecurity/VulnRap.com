// Package vulnrap is the official Go client for the VulnRap API
// (https://vulnrap.com).
//
// The VulnRap API runs the same multi-engine consensus pipeline that powers
// vulnrap.com — sloppiness scoring, similarity matching, and PII
// auto-redaction — over plain HTTP. No API key is required.
//
// Basic usage:
//
//	c := vulnrap.NewClient()
//	res, err := c.ScoreReport(ctx, &vulnrap.ScoreReportInput{
//	    RawText:     "Found a path traversal in /api/files...",
//	    ContentMode: vulnrap.ContentModeFull,
//	})
//	if err != nil {
//	    log.Fatal(err)
//	}
//	fmt.Println(res.SlopScore, res.SlopTier)
//
// All methods take a context.Context as their first argument and return an
// error. No method panics.
package vulnrap

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"runtime"
	"strconv"
	"time"
)

// DefaultBaseURL is the production VulnRap API root.
const DefaultBaseURL = "https://vulnrap.com/api"

// Version is the SDK version (semver). Bumped on releases.
const Version = "0.1.0"

// Client is the VulnRap HTTP client. The zero value is not usable; construct
// one with NewClient.
type Client struct {
	baseURL    string
	httpClient *http.Client
	userAgent  string
}

// Option configures a Client.
type Option func(*Client)

// WithBaseURL overrides the API root. Useful for staging deployments and
// httptest servers in tests.
func WithBaseURL(u string) Option {
	return func(c *Client) { c.baseURL = u }
}

// WithHTTPClient overrides the http.Client used for requests. Use this to
// inject custom transports, timeouts, or retry middleware.
func WithHTTPClient(h *http.Client) Option {
	return func(c *Client) { c.httpClient = h }
}

// WithUserAgent overrides the User-Agent header sent on every request.
func WithUserAgent(ua string) Option {
	return func(c *Client) { c.userAgent = ua }
}

// NewClient returns a Client wired to the production API. Use the With*
// options to override the base URL, HTTP client, or user agent.
func NewClient(opts ...Option) *Client {
	c := &Client{
		baseURL:    DefaultBaseURL,
		httpClient: &http.Client{Timeout: 60 * time.Second},
		userAgent:  fmt.Sprintf("vulnrap-go/%s (%s; %s)", Version, runtime.GOOS, runtime.GOARCH),
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// ScoreReportInput selects the report content for ScoreReport. Exactly one of
// RawText, ReportURL, or File must be provided.
type ScoreReportInput struct {
	// RawText is the plain-text vulnerability report body.
	RawText string
	// ReportURL is an HTTPS URL the server will fetch the report from
	// (GitHub raw, Gist, GitLab, Pastebin, etc.).
	ReportURL string
	// File is a streamable report payload (.txt, .md, .pdf).
	File io.Reader
	// FileName is the original filename for File. Required when File is set.
	FileName string

	// ContentMode controls server-side storage. Defaults to ContentModeFull.
	ContentMode ContentMode
	// ShowInFeed lists the report in the public recent reports feed.
	ShowInFeed bool
	// SkipLLM disables the LLM dimensions of the score, making the call
	// purely heuristic and faster.
	SkipLLM bool
	// SkipRedaction disables PII auto-redaction. The server forces SkipLLM
	// to true when this is set, to avoid leaking unredacted text to the
	// upstream LLM provider.
	SkipRedaction bool
}

// TestYourselfInput selects the report content for TestYourself. Exactly one
// of RawText, ReportURL, or File must be provided.
type TestYourselfInput struct {
	RawText       string
	ReportURL     string
	File          io.Reader
	FileName      string
	SkipLLM       bool
	SkipRedaction bool
}

// ScoreReport submits a vulnerability report for analysis and stores it on
// the server. The returned ReportAnalysis contains a DeleteToken that is only
// surfaced once — keep it if you might want to delete the row later.
func (c *Client) ScoreReport(ctx context.Context, input *ScoreReportInput) (*ReportAnalysis, error) {
	if input == nil {
		return nil, fmt.Errorf("vulnrap: ScoreReport: input is required")
	}
	body, contentType, err := buildReportForm(reportFormInput{
		rawText:       input.RawText,
		reportURL:     input.ReportURL,
		file:          input.File,
		fileName:      input.FileName,
		contentMode:   input.ContentMode,
		setShowInFeed: true,
		showInFeed:    input.ShowInFeed,
		setStorage:    true,
		skipLLM:       input.SkipLLM,
		skipRedaction: input.SkipRedaction,
	})
	if err != nil {
		return nil, err
	}
	var out ReportAnalysis
	if err := c.do(ctx, http.MethodPost, "/reports", contentType, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// LookupReport fetches a previously submitted report by its numeric ID.
func (c *Client) LookupReport(ctx context.Context, id int) (*ReportAnalysis, error) {
	if id <= 0 {
		return nil, fmt.Errorf("vulnrap: LookupReport: id must be positive, got %d", id)
	}
	var out ReportAnalysis
	if err := c.do(ctx, http.MethodGet, "/reports/"+strconv.Itoa(id), "", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// QueryStats fetches aggregate platform statistics.
func (c *Client) QueryStats(ctx context.Context) (*PlatformStats, error) {
	var out PlatformStats
	if err := c.do(ctx, http.MethodGet, "/stats", "", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// TestYourself runs the full analysis pipeline on a report without storing
// anything server-side. Ideal for PSIRT teams validating incoming reports.
func (c *Client) TestYourself(ctx context.Context, input *TestYourselfInput) (*CheckResult, error) {
	if input == nil {
		return nil, fmt.Errorf("vulnrap: TestYourself: input is required")
	}
	body, contentType, err := buildReportForm(reportFormInput{
		rawText:       input.RawText,
		reportURL:     input.ReportURL,
		file:          input.File,
		fileName:      input.FileName,
		setStorage:    true,
		skipLLM:       input.SkipLLM,
		skipRedaction: input.SkipRedaction,
	})
	if err != nil {
		return nil, err
	}
	var out CheckResult
	if err := c.do(ctx, http.MethodPost, "/reports/check", contentType, body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ---- internals ----

type reportFormInput struct {
	rawText       string
	reportURL     string
	file          io.Reader
	fileName      string
	contentMode   ContentMode
	setShowInFeed bool
	showInFeed    bool
	setStorage    bool
	skipLLM       bool
	skipRedaction bool
}

// buildReportForm builds the multipart body shared by /reports and
// /reports/check. It enforces the "exactly one source" precondition so
// callers get a clear error before any HTTP call is made.
func buildReportForm(in reportFormInput) (io.Reader, string, error) {
	sources := 0
	if in.rawText != "" {
		sources++
	}
	if in.reportURL != "" {
		sources++
	}
	if in.file != nil {
		sources++
	}
	if sources == 0 {
		return nil, "", fmt.Errorf("vulnrap: one of RawText, ReportURL, or File is required")
	}
	if sources > 1 {
		return nil, "", fmt.Errorf("vulnrap: only one of RawText, ReportURL, or File may be set")
	}
	if in.file != nil && in.fileName == "" {
		return nil, "", fmt.Errorf("vulnrap: FileName is required when File is set")
	}

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)

	switch {
	case in.rawText != "":
		if err := mw.WriteField("rawText", in.rawText); err != nil {
			return nil, "", err
		}
	case in.reportURL != "":
		if err := mw.WriteField("reportUrl", in.reportURL); err != nil {
			return nil, "", err
		}
	case in.file != nil:
		fw, err := mw.CreateFormFile("file", in.fileName)
		if err != nil {
			return nil, "", err
		}
		if _, err := io.Copy(fw, in.file); err != nil {
			return nil, "", err
		}
	}

	mode := in.contentMode
	if mode == "" {
		mode = ContentModeFull
	}
	if err := mw.WriteField("contentMode", string(mode)); err != nil {
		return nil, "", err
	}
	if in.setShowInFeed {
		if err := mw.WriteField("showInFeed", strconv.FormatBool(in.showInFeed)); err != nil {
			return nil, "", err
		}
	}
	if in.setStorage {
		if err := mw.WriteField("skipLlm", strconv.FormatBool(in.skipLLM)); err != nil {
			return nil, "", err
		}
		if err := mw.WriteField("skipRedaction", strconv.FormatBool(in.skipRedaction)); err != nil {
			return nil, "", err
		}
	}
	if err := mw.Close(); err != nil {
		return nil, "", err
	}
	return &buf, mw.FormDataContentType(), nil
}

// do sends a request and decodes a JSON response into out (when non-nil).
// Non-2xx responses are returned as *APIError.
func (c *Client) do(ctx context.Context, method, path, contentType string, body io.Reader, out interface{}) error {
	endpoint, err := joinURL(c.baseURL, path)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("Accept", "application/json")
	if c.userAgent != "" {
		req.Header.Set("User-Agent", c.userAgent)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("vulnrap: %s %s: %w", method, endpoint, err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("vulnrap: read response body: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		apiErr := &APIError{StatusCode: resp.StatusCode, Body: respBody}
		var parsed struct {
			Error string `json:"error"`
		}
		if err := json.Unmarshal(respBody, &parsed); err == nil && parsed.Error != "" {
			apiErr.Message = parsed.Error
		}
		return apiErr
	}

	if out == nil {
		return nil
	}
	if err := json.Unmarshal(respBody, out); err != nil {
		return fmt.Errorf("vulnrap: decode response: %w", err)
	}
	return nil
}

// joinURL appends path to base while preserving the existing base path
// (e.g. "https://vulnrap.com/api" + "/reports" -> "https://vulnrap.com/api/reports").
func joinURL(base, path string) (string, error) {
	u, err := url.Parse(base)
	if err != nil {
		return "", fmt.Errorf("vulnrap: invalid base URL %q: %w", base, err)
	}
	if path == "" {
		return u.String(), nil
	}
	if u.Path == "" || u.Path == "/" {
		u.Path = path
	} else {
		// Strip a trailing slash on base, then ensure path starts with one.
		basePath := u.Path
		for len(basePath) > 0 && basePath[len(basePath)-1] == '/' {
			basePath = basePath[:len(basePath)-1]
		}
		if path[0] != '/' {
			path = "/" + path
		}
		u.Path = basePath + path
	}
	return u.String(), nil
}
