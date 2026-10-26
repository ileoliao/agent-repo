from datetime import datetime, timezone, date
from decimal import Decimal
from airflow.sdk import dag, task, Variable

A_RV = {"s": "你好，世界", "d": {"a": 1, "b": [1, 2, {"c": None}]}, "l": [1, 2.5, True, None, "x"], "i": 42, "f": 3.14, "b": True, "n": None}
A_META = {"k": "v", "nested": {"x": [1, [2, 3]]}, "cn": "中文"}
A_NAMES = ["a", "b", "中"]
B_RV = [1, 2.5, "中文", None, True, {"k": [1, 2]}, [[1], [2, [3]]]]
B_WHEN = datetime(2024, 9, 30, 12, 0, 0, tzinfo=timezone.utc)
C_RV = 5
D_DT = datetime(2024, 9, 30, 8, 30, 15, tzinfo=timezone.utc)
D_DATE = date(2024, 9, 30)
D_DEC = Decimal("1.50")
D_TUP = (1, "a", 2.5)


@dag(dag_id="xcom_migrate_test", schedule=None, start_date=datetime(2024, 1, 1), catchup=False)
def xcom_migrate_test():
    @task
    def producer_a(ti=None):
        ti.xcom_push(key="meta", value=A_META)
        ti.xcom_push(key="count", value=7)
        ti.xcom_push(key="names", value=A_NAMES)
        ti.xcom_push(key="note", value="备注 note")
        return A_RV

    @task
    def producer_b(ti=None):
        ti.xcom_push(key="when", value=B_WHEN)
        ti.xcom_push(key="when_str", value=B_WHEN.isoformat())
        ti.xcom_push(key="empty_list", value=[])
        ti.xcom_push(key="empty_dict", value={})
        return B_RV

    @task
    def producer_c(ti=None):
        ti.xcom_push(key="flag", value=False)
        ti.xcom_push(key="nothing", value=None)
        ti.xcom_push(key="ratio", value=0.5)
        ti.xcom_push(key="numstr", value="7")
        return C_RV

    @task
    def producer_d(ti=None):
        ti.xcom_push(key="s7", value="7")
        ti.xcom_push(key="sTrue", value="True")
        ti.xcom_push(key="sNone", value="None")
        ti.xcom_push(key="none", value=None)
        ti.xcom_push(key="dt", value=D_DT)
        ti.xcom_push(key="date", value=D_DATE)
        ti.xcom_push(key="dec", value=D_DEC)
        ti.xcom_push(key="tup", value=D_TUP)
        ti.xcom_push(key="set", value={3, 1, 2})
        ti.xcom_push(key="nested", value={"when": D_DT, "t": (1, 2), "l": [D_DATE]})
        return D_TUP

    @task
    def fails_alone():
        if Variable.get("should_fail", "1") == "1":
            raise ValueError("fails_alone forced failure")

    def check(ti):
        def strict(got, exp, what):
            assert got == exp and type(got) is type(exp), (what, repr(got), type(got))
        strict(ti.xcom_pull(task_ids="producer_a"), A_RV, "a.rv")
        rv = ti.xcom_pull(task_ids="producer_a")
        assert type(rv["i"]) is int and type(rv["f"]) is float and type(rv["b"]) is bool and rv["n"] is None
        strict(ti.xcom_pull(task_ids="producer_a", key="meta"), A_META, "a.meta")
        strict(ti.xcom_pull(task_ids="producer_a", key="count"), 7, "a.count")
        strict(ti.xcom_pull(task_ids="producer_a", key="names"), A_NAMES, "a.names")
        strict(ti.xcom_pull(task_ids="producer_a", key="note"), "备注 note", "a.note")
        strict(ti.xcom_pull(task_ids="producer_b"), B_RV, "b.rv")
        strict(ti.xcom_pull(task_ids="producer_b", key="when_str"), B_WHEN.isoformat(), "b.when_str")
        strict(ti.xcom_pull(task_ids="producer_b", key="empty_list"), [], "b.empty_list")
        strict(ti.xcom_pull(task_ids="producer_b", key="empty_dict"), {}, "b.empty_dict")
        w = ti.xcom_pull(task_ids="producer_b", key="when")
        strict(w, B_WHEN.isoformat(), "b.when (downgraded)")
        strict(ti.xcom_pull(task_ids="producer_d", key="s7"), "7", "d.s7")
        strict(ti.xcom_pull(task_ids="producer_d", key="sTrue"), "True", "d.sTrue")
        strict(ti.xcom_pull(task_ids="producer_d", key="sNone"), "None", "d.sNone")
        assert ti.xcom_pull(task_ids="producer_d", key="none") is None
        strict(ti.xcom_pull(task_ids="producer_d", key="dt"), D_DT.isoformat(), "d.dt (downgraded)")
        strict(ti.xcom_pull(task_ids="producer_d", key="date"), D_DATE.isoformat(), "d.date (downgraded)")
        strict(ti.xcom_pull(task_ids="producer_d", key="dec"), "1.5", "d.dec (downgraded)")
        strict(ti.xcom_pull(task_ids="producer_d", key="tup"), [1, "a", 2.5], "d.tup (downgraded)")
        strict(ti.xcom_pull(task_ids="producer_d", key="set"), [1, 2, 3], "d.set (downgraded)")
        strict(ti.xcom_pull(task_ids="producer_d", key="nested"), {"when": D_DT.isoformat(), "t": [1, 2], "l": [D_DATE.isoformat()]}, "d.nested")
        strict(ti.xcom_pull(task_ids="producer_d"), [1, "a", 2.5], "d.rv (downgraded)")
        strict(ti.xcom_pull(task_ids="producer_c"), C_RV, "c.rv")
        strict(ti.xcom_pull(task_ids="producer_c", key="flag"), False, "c.flag")
        assert ti.xcom_pull(task_ids="producer_c", key="nothing") is None
        strict(ti.xcom_pull(task_ids="producer_c", key="ratio"), 0.5, "c.ratio")
        strict(ti.xcom_pull(task_ids="producer_c", key="numstr"), "7", "c.numstr")
        multi = list(ti.xcom_pull(task_ids=["producer_a", "producer_b", "producer_c"]))
        assert multi == [A_RV, B_RV, C_RV] and [type(x) for x in multi] == [dict, list, int], multi
        multi_k = list(ti.xcom_pull(task_ids=["producer_a", "producer_c"], key="count" if False else "return_value"))
        assert multi_k == [A_RV, C_RV]
        print("XCHECK ALL OK")

    @task
    def after_fail(ti=None):
        check(ti)

    @task
    def consumer(ti=None):
        check(ti)

    a, b, c, d = producer_a(), producer_b(), producer_c(), producer_d()
    fa = fails_alone()
    [a, b, c, d] >> fa
    fa >> after_fail()
    [a, b, c, d, fa] >> consumer()


xcom_migrate_test()
