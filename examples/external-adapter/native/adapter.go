package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type request struct {
	ProtocolVersion   int             `json:"protocolVersion"`
	Identity          json.RawMessage `json:"identity"`
	CheckID           string          `json:"checkId"`
	SourceFingerprint string          `json:"sourceFingerprint"`
	Root              string          `json:"root"`
	Project           string          `json:"project"`
	Scope             []string        `json:"scope"`
}

type checkedFile struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}

type finding struct {
	RuleID  string `json:"ruleId"`
	Level   string `json:"level"`
	Message string `json:"message"`
	File    string `json:"file"`
	Line    int    `json:"line"`
}

func run() (int, error) {
	if len(os.Args) != 2 {
		return 2, fmt.Errorf("expected a protocol request file")
	}
	content, err := os.ReadFile(os.Args[1])
	if err != nil {
		return 2, fmt.Errorf("read protocol request: %w", err)
	}
	var input request
	if err := json.Unmarshal(content, &input); err != nil {
		return 2, fmt.Errorf("decode protocol request: %w", err)
	}
	if input.ProtocolVersion != 1 {
		return 2, fmt.Errorf("unsupported protocol version")
	}
	files := make([]checkedFile, 0, len(input.Scope))
	findings := make([]finding, 0)
	for _, file := range input.Scope {
		content, err := os.ReadFile(filepath.Join(input.Root, input.Project, file))
		if err != nil {
			return 2, fmt.Errorf("read scoped input: %w", err)
		}
		for index, line := range strings.Split(string(content), "\n") {
			line = strings.TrimSuffix(line, "\r")
			if strings.HasSuffix(line, " ") || strings.HasSuffix(line, "\t") {
				findings = append(findings, finding{RuleID: "trailing-whitespace", Level: "error", Message: "Remove trailing spaces or tabs", File: file, Line: index + 1})
			}
		}
		files = append(files, checkedFile{Path: file, Status: "checked"})
	}
	result := map[string]any{
		"protocolVersion": 1, "identity": input.Identity, "checkId": input.CheckID,
		"sourceFingerprint": input.SourceFingerprint, "files": files, "findings": findings,
		"findingsComplete": true, "tools": []map[string]string{{"name": "go", "version": runtime.Version()}},
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		return 2, fmt.Errorf("write protocol result: %w", err)
	}
	if len(findings) > 0 {
		return 1, nil
	}
	return 0, nil
}

func main() {
	code, err := run()
	if err != nil {
		slog.Error("adapter failed", "error", err)
	}
	os.Exit(code)
}
