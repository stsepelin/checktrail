//go:build integration

package buildprofiles

import "testing"

func TestCombinedValues(t *testing.T) {
	if got := add(add(1, 2), add(3, 4)); got != 10 {
		t.Fatalf("combined values = %d, want 10", got)
	}
}
