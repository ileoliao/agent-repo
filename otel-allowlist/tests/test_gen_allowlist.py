import os
import random
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import gen_allowlist  # noqa: E402

SCRIPT = os.path.join(ROOT, "gen_allowlist.py")
DATA = os.path.join(HERE, "testdata")


def run(*args):
    return subprocess.run([sys.executable, SCRIPT, *args], capture_output=True, text=True)


def random_names(n, seed=7):
    r, alpha = random.Random(seed), "abcdefghijklmnopqrstuvwxyz0123456789-._"
    names = set()
    while len(names) < n:
        names.add(r.choice("abcdefghijklmnopqrstuvwxyz") + "".join(r.choice(alpha) for _ in range(r.randint(3, 30))))
    return sorted(names)


def test_regex_accepts_exactly_the_list():
    names = random_names(1000)
    allowed, rx = set(names), re.compile(gen_allowlist.allowlist_regex(names))
    r, alpha = random.Random(3), "abcdefghijklmnopqrstuvwxyz0123456789-._A"
    for _ in range(100_000):
        s = list(r.choice(names))
        op = r.randrange(4)
        if op == 1:
            s[r.randrange(len(s))] = r.choice(alpha)
        elif op == 2:
            s = s[: r.randrange(len(s))]
        elif op == 3:
            s.append(r.choice(alpha))
        s = "".join(s)
        assert (rx.fullmatch(s) is not None) == (s in allowed), s


def test_names_that_prefix_each_other():
    names = ["svc", "svc-a", "svc-ab", "svc.b"]
    rx = re.compile(gen_allowlist.allowlist_regex(names))
    for n in names:
        assert rx.fullmatch(n)
    for n in ["sv", "svc-", "svc-abc", "svcXb", "SVC", "svc-b"]:
        assert not rx.fullmatch(n), n


def test_output_is_sorted_whatever_the_input_order():
    # Sorting is what keeps Go's regexp fast on long lists (see bench/).
    assert gen_allowlist.allowlist_regex(["svc-b", "api", "svc-a"]) == "^(?:api|svc-a|svc-b)$"


def test_output_has_no_quotes_newline_or_backslash():
    pattern = gen_allowlist.allowlist_regex(["lending.batch", "payments-api"])
    assert pattern == "^(?:lending[.]batch|payments-api)$"
    assert "\\" not in pattern and "'" not in pattern and '"' not in pattern


def test_build_verify_check(tmp_path):
    services, regex = tmp_path / "services.txt", tmp_path / "allowlist.regex"
    services.write_text("# comment\npayments-api  # inline comment\n\nlending.batch\n")
    assert run("build", str(services), str(regex)).returncode == 0
    assert regex.read_text() == "^(?:lending[.]batch|payments-api)$"
    assert run("verify", str(services), str(regex)).returncode == 0
    assert run("check", str(regex), "lending.batch").returncode == 0
    assert run("check", str(regex), "lendingXbatch").returncode == 1


def test_verify_rejects_a_hand_edited_regex(tmp_path):
    services, regex = tmp_path / "services.txt", tmp_path / "allowlist.regex"
    services.write_text("payments-api\nsvc-a\n")
    regex.write_text("^(?:payments-api)$")
    result = run("verify", str(services), str(regex))
    assert result.returncode != 0 and "out of date" in result.stderr


def test_rejects_invalid_or_empty_lists(tmp_path):
    bad, empty = tmp_path / "bad.txt", tmp_path / "empty.txt"
    bad.write_text("payments api\n")
    empty.write_text("# nothing\n")
    assert "invalid service name" in run("build", str(bad), str(tmp_path / "x")).stderr
    assert "no services" in run("build", str(empty), str(tmp_path / "x")).stderr


def test_testdata_is_up_to_date():
    services = os.path.join(DATA, "services_1000.txt")
    regex = os.path.join(DATA, "allowlist_1000.regex")
    assert run("verify", services, regex).returncode == 0
