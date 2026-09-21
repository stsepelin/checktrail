package arithmetic

import "testing"

func TestAdd(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name        string
		left, right int
		want        int
	}{
		{name: "positive", left: 2, right: 3, want: 5},
		{name: "negative", left: -2, right: 3, want: 1},
		{name: "zero", left: 0, right: 0, want: 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := add(tc.left, tc.right); got != tc.want {
				t.Fatalf("add(%d, %d) = %d; want %d", tc.left, tc.right, got, tc.want)
			}
		})
	}
}
