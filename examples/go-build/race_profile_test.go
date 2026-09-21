//go:build race && integration

package buildprofiles

import "testing"

func TestRaceProfileSelection(t *testing.T) {
	if got := add(4, 5); got != 9 {
		t.Fatalf("add(4, 5) = %d, want 9", got)
	}
}
