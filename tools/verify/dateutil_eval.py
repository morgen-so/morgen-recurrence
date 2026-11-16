"""Evaluates fixture cases with python-dateutil (the library rrule.js ports).

Usage: python -I dateutil_eval.py <out.json> <fixtures.json>...
Writes {case id: {"got": ...} | {"error": msg} | {"hang": true}}.
UNTIL is read as a floating time, like the fixtures.
"""
import json
import signal
import sys
from datetime import datetime

from dateutil.rrule import rrulestr


class Timeout(Exception):
    pass


def on_alarm(*_):
    raise Timeout()


signal.signal(signal.SIGALRM, on_alarm)
P = datetime.fromisoformat
fmt = lambda d: d.isoformat()


def run(c):
    rule = rrulestr("RRULE:" + c["rrule"].replace("Z;", ";").rstrip("Z"), dtstart=P(c["dtstart"]))
    q = c["query"]
    limit = q.get("limit") or 10**9
    inc = bool(q.get("inc"))
    m = q["method"]
    if m in ("all", "between"):
        out = []
        it = iter(rule) if m == "all" else rule.xafter(P(q["after"]), inc=inc)
        end = None if m == "all" else P(q["before"])
        for d in it:
            if end is not None and (d > end or (not inc and d == end)):
                break
            if len(out) >= limit:
                break
            out.append(fmt(d))
        return out
    d = rule.before(P(q["dt"]), inc=inc) if m == "before" else rule.after(P(q["dt"]), inc=inc)
    return fmt(d) if d else None


res = {}
for path in sys.argv[2:]:
    for c in json.load(open(path))["cases"]:
        try:
            signal.alarm(3)
            res[c["id"]] = {"got": run(c)}
        except Timeout:
            res[c["id"]] = {"hang": True}
        except Exception as e:  # noqa: BLE001
            res[c["id"]] = {"error": f"{type(e).__name__}: {e}"[:200]}
        finally:
            signal.alarm(0)
json.dump(res, open(sys.argv[1], "w"))
print(f"dateutil {__import__('dateutil').__version__}: {len(res)} cases -> {sys.argv[1]}")
