#!/usr/bin/env python3
"""Generate the OTel Collector allowlist regex from services.txt.

  gen_allowlist.py build services.txt allowlist.regex   # generate + self-check
  gen_allowlist.py verify services.txt allowlist.regex  # CI: regenerate and compare
  gen_allowlist.py check allowlist.regex <service>      # will this service pass?
"""
import re
import sys

NAME = re.compile(r"[A-Za-z0-9._-]+")


def load(path):
    names = set()
    for no, line in enumerate(open(path, encoding="utf-8"), 1):
        s = line.split("#", 1)[0].strip()
        if not s:
            continue
        if not NAME.fullmatch(s):
            sys.exit(f"{path}:{no}: invalid service name {s!r}")
        names.add(s)
    if not names:
        sys.exit(f"{path}: no services")
    return sorted(names)


def allowlist_regex(names):
    # Sorted on purpose: Go's regexp parser (used by OTTL IsMatch) merges common prefixes
    # of adjacent alternatives, so a sorted list matches in ~1-2 us whatever its size;
    # the same list unsorted takes ~40 us at 1000 services and grows with every name.
    # '.' becomes [.] so the file has no backslashes to escape in YAML or OTTL strings.
    return "^(?:" + "|".join(n.replace(".", "[.]") for n in sorted(names)) + ")$"


def self_check(names, pattern):
    rx, allowed = re.compile(pattern), set(names)
    for n in names:
        if not rx.fullmatch(n):
            sys.exit(f"self-check failed: {n} does not match")
        for v in (n + "x", n[:-1], n.swapcase(), "x" + n):
            if v not in allowed and rx.fullmatch(v):
                sys.exit(f"self-check failed: {v} matches but is not listed")


def read_regex(path):
    s = open(path, encoding="utf-8").read()
    if not (s.startswith("^") and s.endswith("$")):
        sys.exit(f"{path}: not a generated allowlist")
    return s


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "build" and len(argv) == 4:
        names = load(argv[2])
        pattern = allowlist_regex(names)
        self_check(names, pattern)
        # raw text, no quotes, no trailing newline: ${file:} pastes it into the OTTL string as is
        open(argv[3], "w", encoding="utf-8").write(pattern)
        print(f"{len(names)} services -> {argv[3]} ({len(pattern)} chars)")
    elif cmd == "verify" and len(argv) == 4:
        names = load(argv[2])
        if read_regex(argv[3]) != allowlist_regex(names):
            sys.exit(f"{argv[3]} is out of date: rebuild it from {argv[2]}")
        self_check(names, read_regex(argv[3]))
        print(f"OK: {argv[3]} matches {argv[2]} ({len(names)} services)")
    elif cmd == "check" and len(argv) == 4:
        ok = re.fullmatch(read_regex(argv[2]), argv[3]) is not None
        print(f"{argv[3]}: {'ALLOWED' if ok else 'BLOCKED'}")
        sys.exit(0 if ok else 1)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
