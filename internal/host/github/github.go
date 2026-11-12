// Package github implements host.Host against the GitHub REST API and the
// OAuth device flow.
package github

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/ryan-ressmeyer/revisions/internal/host"
)

// ClientID identifies the Revisions OAuth App to GitHub. This line is its one
// home: the release build compiles it in as it stands. It is public, not a
// secret, because the device flow needs no client secret.
// REVISIONS_GITHUB_CLIENT_ID overrides it. An empty ID, built in or from the
// override, turns sign-in off: it answers not_configured and the sign-in
// screen says why.
var ClientID = "Ov23licX8bUtKeJ9Xh2J"

// Host talks to one GitHub. Create it with New.
type Host struct {
	web      string // clone URLs: <web>/<owner>/<name>.git
	api      string
	oauth    string // device-flow endpoints: <oauth>/login/...
	clientID string
	client   *http.Client
}

// New reads the base URLs and client ID from the environment:
// REVISIONS_GITHUB_URL, REVISIONS_GITHUB_API_URL, REVISIONS_GITHUB_CLIENT_ID.
func New() *Host {
	env := func(name, fallback string) string {
		if v := os.Getenv(name); v != "" {
			return strings.TrimRight(v, "/")
		}
		return fallback
	}
	h := &Host{
		web:      env("REVISIONS_GITHUB_URL", "https://github.com"),
		api:      env("REVISIONS_GITHUB_API_URL", "https://api.github.com"),
		clientID: ClientID,
		client:   &http.Client{Timeout: 30 * time.Second},
	}
	if id, ok := os.LookupEnv("REVISIONS_GITHUB_CLIENT_ID"); ok {
		h.clientID = id
	}
	// GitHub serves the device flow from its web address. When that is not an
	// HTTP address (tests point it at a directory of bare repositories), the
	// API address serves it.
	h.oauth = h.web
	if !strings.HasPrefix(h.web, "http://") && !strings.HasPrefix(h.web, "https://") {
		h.oauth = h.api
	}
	return h
}

// Name is the host segment of every repository id. It stays github.com, with
// no port, whatever the base URLs are.
func (h *Host) Name() string { return "github.com" }

var shaPattern = regexp.MustCompile(`^[0-9a-fA-F]{7,64}$`)

func (h *Host) ParseURL(raw string) (host.Repo, host.Ref, error) {
	bad := func() (host.Repo, host.Ref, error) { return host.Repo{}, host.Ref{}, host.ErrBadURL }
	raw = strings.TrimSpace(raw)
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return bad()
	}
	if name := strings.ToLower(u.Host); name != "github.com" && name != "www.github.com" {
		return bad()
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) < 2 || parts[0] == "" {
		return bad()
	}
	repo := host.Repo{Owner: parts[0], Name: strings.TrimSuffix(parts[1], ".git")}
	rest := parts[2:]
	switch {
	case repo.Name == "":
		return bad()
	case len(rest) == 0:
		return repo, host.Ref{Kind: host.RefDefault}, nil
	case rest[0] == "tree" && len(rest) > 1:
		// A branch name may contain slashes, so the whole remainder is the name.
		return repo, host.Ref{Kind: host.RefBranch, Name: strings.Join(rest[1:], "/")}, nil
	case rest[0] == "commit" && len(rest) == 2 && shaPattern.MatchString(rest[1]):
		return repo, host.Ref{Kind: host.RefCommit, Name: strings.ToLower(rest[1])}, nil
	case rest[0] == "pull" && len(rest) >= 2:
		if n, err := strconv.Atoi(rest[1]); err == nil && n > 0 {
			return repo, host.Ref{Kind: host.RefPull, Number: n}, nil
		}
	}
	return bad()
}

func (h *Host) CloneURL(repo host.Repo) string {
	return h.web + "/" + repo.Owner + "/" + repo.Name + ".git"
}

func (h *Host) GitAuth(token string) (baseURL, header string) {
	return h.web + "/", "Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte("x-access-token:"+token))
}

func (h *Host) CommitEmail(user host.User) string {
	return strconv.FormatInt(user.ID, 10) + "+" + user.Login + "@users.noreply.github.com"
}

// do sends one request and decodes a JSON answer into out. A failure status
// becomes ErrUnauthorized, ErrNotFound, or a *host.Error with GitHub's message.
func (h *Host) do(req *http.Request, out any) error {
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "revisions")
	resp, err := h.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		return host.ErrUnauthorized
	case resp.StatusCode == http.StatusNotFound:
		return host.ErrNotFound
	case resp.StatusCode >= 300:
		var failure struct{ Message string }
		json.Unmarshal(body, &failure)
		if failure.Message == "" {
			failure.Message = "GitHub answered " + resp.Status
		}
		return &host.Error{Status: resp.StatusCode, Message: failure.Message}
	}
	return json.Unmarshal(body, out)
}

// call calls the REST API as the token's account.
func (h *Host) call(ctx context.Context, token, method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		data, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, h.api+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return h.do(req, out)
}

// oauthPost posts a form to a device-flow endpoint.
func (h *Host) oauthPost(ctx context.Context, path string, form url.Values, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, h.oauth+path, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return h.do(req, out)
}

// oauthError is the failure half of a device-flow answer, which GitHub sends
// with status 200.
type oauthError struct {
	Error       string `json:"error"`
	Description string `json:"error_description"`
}

func (e oauthError) err() error {
	message := e.Description
	if message == "" {
		message = "GitHub refused the sign-in: " + e.Error
	}
	return &host.Error{Status: http.StatusBadGateway, Message: message}
}

func (h *Host) StartDevice(ctx context.Context) (host.DeviceCode, error) {
	if h.clientID == "" {
		return host.DeviceCode{}, host.ErrNotConfigured
	}
	var answer struct {
		oauthError
		DeviceCode      string `json:"device_code"`
		UserCode        string `json:"user_code"`
		VerificationURI string `json:"verification_uri"`
		ExpiresIn       int    `json:"expires_in"`
		Interval        int    `json:"interval"`
	}
	form := url.Values{"client_id": {h.clientID}, "scope": {"repo"}}
	if err := h.oauthPost(ctx, "/login/device/code", form, &answer); err != nil {
		return host.DeviceCode{}, err
	}
	if answer.Error != "" || answer.DeviceCode == "" {
		return host.DeviceCode{}, answer.err()
	}
	return host.DeviceCode{
		DeviceCode: answer.DeviceCode, UserCode: answer.UserCode, VerificationURI: answer.VerificationURI,
		ExpiresIn: answer.ExpiresIn, Interval: answer.Interval,
	}, nil
}

func (h *Host) PollDevice(ctx context.Context, deviceCode string) (host.Poll, error) {
	var answer struct {
		oauthError
		AccessToken string `json:"access_token"`
		Interval    int    `json:"interval"`
	}
	form := url.Values{
		"client_id":   {h.clientID},
		"device_code": {deviceCode},
		"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
	}
	if err := h.oauthPost(ctx, "/login/oauth/access_token", form, &answer); err != nil {
		return host.Poll{}, err
	}
	switch answer.Error {
	case "":
		if answer.AccessToken == "" {
			return host.Poll{}, answer.err()
		}
		return host.Poll{Status: host.PollOK, Token: answer.AccessToken}, nil
	case "authorization_pending":
		return host.Poll{Status: host.PollPending}, nil
	case "slow_down":
		return host.Poll{Status: host.PollPending, Interval: max(answer.Interval, 5)}, nil
	case "expired_token":
		return host.Poll{Status: host.PollExpired}, nil
	case "access_denied":
		return host.Poll{Status: host.PollDenied}, nil
	}
	return host.Poll{}, answer.err()
}

func (h *Host) User(ctx context.Context, token string) (host.User, error) {
	var answer struct {
		ID        int64  `json:"id"`
		Login     string `json:"login"`
		Name      string `json:"name"`
		AvatarURL string `json:"avatar_url"`
	}
	err := h.call(ctx, token, http.MethodGet, "/user", nil, &answer)
	return host.User{ID: answer.ID, Login: answer.Login, Name: answer.Name, AvatarURL: answer.AvatarURL}, err
}

func repoPath(repo host.Repo) string {
	return "/repos/" + url.PathEscape(repo.Owner) + "/" + url.PathEscape(repo.Name)
}

func (h *Host) Repository(ctx context.Context, token string, repo host.Repo) (host.RepoInfo, error) {
	var answer struct {
		DefaultBranch string `json:"default_branch"`
		Permissions   struct {
			Push bool `json:"push"`
		} `json:"permissions"`
	}
	err := h.call(ctx, token, http.MethodGet, repoPath(repo), nil, &answer)
	return host.RepoInfo{DefaultBranch: answer.DefaultBranch, Push: answer.Permissions.Push}, err
}

// pull is GitHub's pull-request object, reduced to what Revisions reads.
type pull struct {
	Number   int     `json:"number"`
	Title    string  `json:"title"`
	State    string  `json:"state"`
	MergedAt *string `json:"merged_at"`
	HTMLURL  string  `json:"html_url"`
	Head     struct {
		Ref  string `json:"ref"`
		SHA  string `json:"sha"`
		Repo *struct {
			FullName string `json:"full_name"`
		} `json:"repo"` // null when the fork was deleted
	} `json:"head"`
	Base struct {
		Repo struct {
			FullName string `json:"full_name"`
		} `json:"repo"`
	} `json:"base"`
}

func (p pull) toHost() host.PullRequest {
	state := p.State
	if p.MergedAt != nil {
		state = "merged"
	}
	return host.PullRequest{
		Number: p.Number, Title: p.Title, State: state, HeadSHA: p.Head.SHA, HeadRef: p.Head.Ref, URL: p.HTMLURL,
		SameRepo: p.Head.Repo != nil && strings.EqualFold(p.Head.Repo.FullName, p.Base.Repo.FullName),
	}
}

func (h *Host) PullRequest(ctx context.Context, token string, repo host.Repo, number int) (host.PullRequest, error) {
	var answer pull
	err := h.call(ctx, token, http.MethodGet, fmt.Sprintf("%s/pulls/%d", repoPath(repo), number), nil, &answer)
	return answer.toHost(), err
}

// ponytail: the first 100 open pull requests, no paging. Follow the Link
// header when a manuscript repository has more than that open at once.
func (h *Host) PullRequests(ctx context.Context, token string, repo host.Repo) ([]host.PullRequest, error) {
	var answer []pull
	if err := h.call(ctx, token, http.MethodGet, repoPath(repo)+"/pulls?state=open&per_page=100", nil, &answer); err != nil {
		return nil, err
	}
	pulls := make([]host.PullRequest, len(answer))
	for i, p := range answer {
		pulls[i] = p.toHost()
	}
	return pulls, nil
}

func (h *Host) CreatePullRequest(ctx context.Context, token string, repo host.Repo, in host.NewPull) (host.PullRequest, error) {
	var answer pull
	body := map[string]string{"title": in.Title, "body": in.Body, "head": in.Head, "base": in.Base}
	err := h.call(ctx, token, http.MethodPost, repoPath(repo)+"/pulls", body, &answer)
	return answer.toHost(), err
}
