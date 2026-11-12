// Package host is the seam between Revisions and a Git host. Everything that
// is specific to GitHub sits behind Host; internal/host/github is the only
// implementation. See "Host seam" in specs/architecture.md.
package host

import (
	"context"
	"errors"
)

var (
	ErrBadURL        = errors.New("not a repository, branch, commit, or pull-request URL")
	ErrNotConfigured = errors.New("sign-in is not configured: no OAuth client ID")
	ErrUnauthorized  = errors.New("the host rejected the token")
	ErrNotFound      = errors.New("not found on the host, or not visible to this account")
)

// Error is any other failure answer from the host's API.
type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return e.Message }

// Repo names a repository on the host.
type Repo struct{ Owner, Name string }

// RefKind says what a shared URL points at.
type RefKind string

const (
	RefDefault RefKind = "default" // the repository root: its default branch
	RefBranch  RefKind = "branch"
	RefCommit  RefKind = "commit"
	RefPull    RefKind = "pull"
)

// Ref is the target of a shared URL. Name is the branch name or the commit
// SHA; Number is the pull-request number.
type Ref struct {
	Kind   RefKind
	Name   string
	Number int
}

// DeviceCode is a started device-flow sign-in.
type DeviceCode struct {
	DeviceCode      string // secret; stays on the server
	UserCode        string
	VerificationURI string
	ExpiresIn       int // seconds
	Interval        int // seconds between polls
}

// Poll statuses.
const (
	PollPending = "pending"
	PollOK      = "ok"
	PollExpired = "expired"
	PollDenied  = "denied"
)

// Poll is one answer to "has the user entered the code yet?". Token is set
// when Status is PollOK. Interval is non-zero when the host asks for slower
// polling.
type Poll struct {
	Status   string
	Token    string
	Interval int
}

// User is the signed-in account.
type User struct {
	ID        int64
	Login     string
	Name      string
	AvatarURL string
}

// RepoInfo is what Revisions needs to know about a repository.
type RepoInfo struct {
	DefaultBranch string
	Push          bool // the account may push to the repository's branches
}

// PullRequest is one pull request. SameRepo is false when the head branch
// lives in a fork.
type PullRequest struct {
	Number   int    `json:"number"`
	Title    string `json:"title"`
	State    string `json:"state"` // "open", "closed", or "merged"
	HeadSHA  string `json:"headSha"`
	HeadRef  string `json:"headRef"`
	URL      string `json:"url"`
	SameRepo bool   `json:"-"`
}

// NewPull describes a pull request to open from branch Head into Base.
type NewPull struct{ Title, Body, Head, Base string }

// Host is one Git host.
type Host interface {
	// Name is the host segment of a repository id, for example "github.com".
	Name() string
	// ParseURL reads a shared URL. It returns ErrBadURL for anything else.
	ParseURL(raw string) (Repo, Ref, error)

	// StartDevice begins a device-flow sign-in. It returns ErrNotConfigured
	// when no OAuth client ID is set.
	StartDevice(ctx context.Context) (DeviceCode, error)
	PollDevice(ctx context.Context, deviceCode string) (Poll, error)

	User(ctx context.Context, token string) (User, error)
	Repository(ctx context.Context, token string, repo Repo) (RepoInfo, error)
	PullRequest(ctx context.Context, token string, repo Repo, number int) (PullRequest, error)
	// PullRequests lists the open pull requests.
	PullRequests(ctx context.Context, token string, repo Repo) ([]PullRequest, error)
	CreatePullRequest(ctx context.Context, token string, repo Repo, pull NewPull) (PullRequest, error)

	CloneURL(repo Repo) string
	// GitAuth returns the header Git must send to URLs under baseURL.
	GitAuth(token string) (baseURL, header string)
	// CommitEmail is the no-reply address for commits by user.
	CommitEmail(user User) string
}
