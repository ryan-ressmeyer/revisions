package server

import (
	"encoding/json"
	"errors"
	"maps"
	"net/http"
)

const maxJSONBody = 8 << 20

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// writeError writes {"error": {"code", "message", ...extra}}. message is shown
// to the user.
func writeError(w http.ResponseWriter, status int, code, message string, extra ...map[string]any) {
	body := map[string]any{}
	for _, e := range extra {
		maps.Copy(body, e)
	}
	body["code"], body["message"] = code, message
	writeJSON(w, status, map[string]any{"error": body})
}

// readJSON decodes a request body of at most 8 MiB into v. On failure it
// writes the error response and returns false.
func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxJSONBody)).Decode(v)
	if err == nil {
		return true
	}
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "The request is larger than 8 MiB.")
	} else {
		writeError(w, http.StatusBadRequest, "bad_json", "The request body is not valid JSON.")
	}
	return false
}
