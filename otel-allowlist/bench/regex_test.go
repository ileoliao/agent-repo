// Checks the generated regex with Go's regexp (RE2, the engine the Collector's IsMatch uses)
// and shows why the generator sorts the list: Go's parser merges common prefixes of adjacent
// alternatives, so a sorted ^(a|b|...)$ matches in about constant time, an unsorted one does not.
//
//	go test -v .                      equivalence check
//	go test -run XXX -bench . .       benchmarks
package bench

import (
	"bufio"
	"math/rand"
	"os"
	"regexp"
	"strings"
	"testing"
)

const (
	servicesFile = "../tests/testdata/services_1000.txt"
	regexFile    = "../tests/testdata/allowlist_1000.regex"
)

func load(t testing.TB) ([]string, map[string]bool) {
	f, err := os.Open(servicesFile)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var names []string
	set := map[string]bool{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(strings.SplitN(sc.Text(), "#", 2)[0])
		if line != "" {
			names = append(names, line)
			set[line] = true
		}
	}
	return names, set
}

func generated(t testing.TB) *regexp.Regexp {
	raw, err := os.ReadFile(regexFile)
	if err != nil {
		t.Fatal(err)
	}
	return regexp.MustCompile(string(raw))
}

func unsorted(names []string) *regexp.Regexp {
	q := append([]string(nil), names...)
	rand.New(rand.NewSource(1)).Shuffle(len(q), func(i, j int) { q[i], q[j] = q[j], q[i] })
	for i, n := range q {
		q[i] = strings.ReplaceAll(n, ".", "[.]")
	}
	return regexp.MustCompile("^(?:" + strings.Join(q, "|") + ")$")
}

func TestRE2MatchesExactlyTheList(t *testing.T) {
	names, set := load(t)
	re := generated(t)
	r := rand.New(rand.NewSource(3))
	alpha := "abcdefghijklmnopqrstuvwxyz0123456789-._A"
	for i := 0; i < 300000; i++ {
		b := []byte(names[r.Intn(len(names))])
		switch r.Intn(4) {
		case 1:
			b[r.Intn(len(b))] = alpha[r.Intn(len(alpha))]
		case 2:
			b = b[:r.Intn(len(b))]
		case 3:
			b = append(b, alpha[r.Intn(len(alpha))])
		}
		if s := string(b); re.MatchString(s) != set[s] {
			t.Fatalf("%q: regex=%v list=%v", s, re.MatchString(s), set[s])
		}
	}
}

var sink bool

func BenchmarkSorted1000(b *testing.B) {
	names, _ := load(b)
	re, key := generated(b), names[len(names)/2]
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		sink = re.MatchString(key)
	}
}

func BenchmarkUnsorted1000(b *testing.B) {
	names, _ := load(b)
	re, key := unsorted(names), names[len(names)/2]
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		sink = re.MatchString(key)
	}
}
