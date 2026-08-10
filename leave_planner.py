#!/usr/bin/env python3
"""Leave Planner (v2 of the PTOB Planner).

Two leave types:
  * PTOB (B) -- accrued paid time off, shown green.
      - 6.7692 hours accrue every two-week period; 8.000 hours after nine
        years of employment (hire date is configurable in the app).
      - The balance is calculated on every other Sunday (period Sundays).
      - Anchor: 135.92 hours as of Sunday, July 26, 2026.
      - Balance is capped at 240 hours (320 after nine years).
  * Parental leave (NR) -- shown pink.
      - Up to 12 weeks (480 hours) per benefit year, starting at the
        child's birth date (set it at the bottom of the app).
      - Taken in 1-hour increments; cannot go negative.
      - Expires one year after the birth date.

Neither leave type can be placed on weekends or holidays.

Run:  python leave_planner.py           (opens http://localhost:8765)
Data: saved to leave_data.json next to this file.  On first run the 1.0
      PTOB-Planner's pto_data.json is migrated automatically.
"""

import argparse
import calendar
import json
import threading
import webbrowser
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ANCHOR_DATE = date(2026, 7, 26)      # a period Sunday
ANCHOR_BALANCE = 135.92
ACCRUAL_BASE = 6.7692                # hours accrued per two-week period
ACCRUAL_AFTER_9YRS = 8.0             # rate after nine years of employment
CAP_BASE = 240.0
CAP_AFTER_9YRS = 320.0
MAX_BALANCE = CAP_AFTER_9YRS         # bound for manual balance edits
DEFAULT_HIRE_DATE = date(2018, 11, 13)   # 9-year mark: Nov 13, 2027
PARENTAL_TOTAL = 480.0               # 12 weeks x 40 h per benefit year
MAX_DAY_HOURS = 8.0                  # combined B + NR limit per day
PERIOD_DAYS = 14
PROJECTION_MONTHS = 36               # how far the server projects ahead

# Holidays as marked (light green) on the 2026-2030 pay calendars.
BUILTIN_HOLIDAYS = {
    "2026-01-01": "New Year's Day",
    "2026-01-19": "Martin Luther King Jr. Day",
    "2026-05-25": "Memorial Day",
    "2026-07-03": "Independence Day (observed)",
    "2026-09-07": "Labor Day",
    "2026-11-26": "Thanksgiving",
    "2026-12-25": "Christmas Day",
    "2027-01-01": "New Year's Day",
    "2027-01-18": "Martin Luther King Jr. Day",
    "2027-05-31": "Memorial Day",
    "2027-07-05": "Independence Day (observed)",
    "2027-09-06": "Labor Day",
    "2027-11-25": "Thanksgiving",
    "2027-12-24": "Christmas Day (observed)",
    "2027-12-31": "New Year's Day (observed)",
    "2028-01-17": "Martin Luther King Jr. Day",
    "2028-05-29": "Memorial Day",
    "2028-07-04": "Independence Day",
    "2028-09-04": "Labor Day",
    "2028-11-23": "Thanksgiving",
    "2028-12-25": "Christmas Day",
    "2029-01-01": "New Year's Day",
    "2029-01-15": "Martin Luther King Jr. Day",
    "2029-05-28": "Memorial Day",
    "2029-07-04": "Independence Day",
    "2029-09-03": "Labor Day",
    "2029-11-22": "Thanksgiving",
    "2029-12-25": "Christmas Day",
    "2030-01-01": "New Year's Day",
    "2030-01-14": "Holiday (per 2030 pay calendar)",
    "2030-05-27": "Memorial Day",
    "2030-07-04": "Independence Day",
    "2030-09-02": "Labor Day",
    "2030-11-28": "Thanksgiving",
    "2030-12-25": "Christmas Day",
}

DATA_FILE = Path(__file__).with_name("leave_data.json")
LEGACY_DATA_FILE = Path(__file__).with_name("pto_data.json")   # 1.0 planner
_lock = threading.Lock()


# ---------------------------------------------------------------- data store

def load_data() -> dict:
    """Return {'entries': {date: {b, nr, label}}, 'holidays': {date: name},
    'removedHolidays': [date], ...}.  b = PTOB hours, nr = parental hours."""
    data = {"entries": {}, "holidays": {}, "removedHolidays": [],
            "anchor": None, "hireDate": None, "birthDate": None}
    # migrate from the 1.0 planner's file the first time
    src = DATA_FILE if DATA_FILE.exists() else LEGACY_DATA_FILE
    if src.exists():
        try:
            raw = json.loads(src.read_text(encoding="utf-8"))
            if raw.get("hireDate"):
                data["hireDate"] = str(raw["hireDate"])
            if raw.get("birthDate"):
                data["birthDate"] = str(raw["birthDate"])
            a = raw.get("anchor")
            if isinstance(a, dict) and "date" in a and "balance" in a:
                data["anchor"] = {"date": str(a["date"]),
                                  "balance": float(a["balance"])}
            for k, v in raw.get("entries", {}).items():
                if isinstance(v, dict) and ("b" in v or "nr" in v):
                    data["entries"][k] = {"b": float(v.get("b", 0)),
                                          "nr": float(v.get("nr", 0)),
                                          "label": str(v.get("label", ""))}
                elif isinstance(v, dict):   # 1.0 format: {hours, label}
                    data["entries"][k] = {"b": float(v.get("hours", 0)),
                                          "nr": 0.0,
                                          "label": str(v.get("label", ""))}
                else:                       # oldest format: bare number
                    data["entries"][k] = {"b": float(v), "nr": 0.0, "label": ""}
            data["holidays"] = {k: str(v) for k, v in raw.get("holidays", {}).items()}
            data["removedHolidays"] = list(raw.get("removedHolidays", []))
        except (ValueError, OSError):
            pass
    return data


def effective_birth(data: dict):
    b = data.get("birthDate")
    if b:
        try:
            return date.fromisoformat(b)
        except ValueError:
            pass
    return None


def save_data(data: dict) -> None:
    DATA_FILE.write_text(
        json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")


def add_years(d: date, n: int) -> date:
    try:
        return d.replace(year=d.year + n)
    except ValueError:                       # Feb 29 -> Feb 28
        return d.replace(year=d.year + n, day=d.day - 1)


def effective_hire(data: dict) -> date:
    h = data.get("hireDate")
    if h:
        try:
            return date.fromisoformat(h)
        except ValueError:
            pass
    return DEFAULT_HIRE_DATE


def effective_anchor(data: dict):
    """The projection's starting point: the built-in anchor, or the user's
    edited balance (stored on a period-Sunday grid date)."""
    a = data.get("anchor")
    if a:
        try:
            return date.fromisoformat(a["date"]), float(a["balance"])
        except (ValueError, KeyError, TypeError):
            pass
    return ANCHOR_DATE, ANCHOR_BALANCE


def merged_holidays(data: dict) -> dict:
    out = {}
    for d, name in BUILTIN_HOLIDAYS.items():
        if d not in data["removedHolidays"]:
            out[d] = {"name": name, "builtin": True}
    for d, name in data["holidays"].items():
        out[d] = {"name": name, "builtin": False}
    return out


# ---------------------------------------------------------------- calculator

def add_months(d: date, months: int) -> date:
    y = d.year + (d.month - 1 + months) // 12
    m = (d.month - 1 + months) % 12 + 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def compute_projection(entries: dict, today: date,
                       anchor_date: date = ANCHOR_DATE,
                       anchor_balance: float = ANCHOR_BALANCE,
                       hire_date: date = DEFAULT_HIRE_DATE,
                       birth_date: date = None) -> list:
    """Balance at every period Sunday from the anchor to ~36 months out.

    PTOB: usage in each 14-day window (S-13 .. S) is subtracted, the accrual
    added, then the cap applied; rate and cap step up at the nine-year mark.
    Parental (NR): rows carry the remaining parental balance (480 h from the
    birth date, gone one year later); it never goes below zero.
    """
    end = add_months(today, PROJECTION_MONTHS)
    nine_years = add_years(hire_date, 9)
    expiry = add_years(birth_date, 1) if birth_date else None
    b_hours, nr_hours = {}, {}
    for dstr, e in entries.items():
        try:
            d = date.fromisoformat(dstr)
            b_hours[d] = float(e.get("b", 0))
            nr_hours[d] = float(e.get("nr", 0))
        except (ValueError, AttributeError):
            continue

    def nr_remaining(as_of: date):
        if not birth_date or as_of < birth_date:
            return None
        if as_of >= expiry:
            return 0.0
        used = sum(h for d, h in nr_hours.items() if birth_date <= d <= as_of)
        return round(max(0.0, PARENTAL_TOTAL - used), 2)

    rows = [{
        "date": anchor_date.isoformat(),
        "used": 0.0, "accrued": 0.0, "lost": 0.0,
        "balance": anchor_balance,
        "cap": CAP_AFTER_9YRS if anchor_date >= nine_years else CAP_BASE,
        "nrUsed": 0.0, "nrRemaining": nr_remaining(anchor_date),
        "overdrawn": False,
    }]
    balance = anchor_balance
    sunday = anchor_date + timedelta(days=PERIOD_DAYS)
    while sunday <= end:
        senior = sunday >= nine_years
        rate = ACCRUAL_AFTER_9YRS if senior else ACCRUAL_BASE
        cap = CAP_AFTER_9YRS if senior else CAP_BASE
        window_start = sunday - timedelta(days=PERIOD_DAYS - 1)
        used = round(sum(h for d, h in b_hours.items()
                         if window_start <= d <= sunday), 2)
        nr_used = round(sum(h for d, h in nr_hours.items()
                            if window_start <= d <= sunday), 2)
        after_use = balance - used
        pre_cap = after_use + rate
        lost = max(0.0, pre_cap - cap)
        balance = min(pre_cap, cap)
        rows.append({
            "date": sunday.isoformat(),
            "used": used,
            "accrued": rate,
            "lost": round(lost, 2),
            "balance": round(balance, 2),
            "cap": cap,
            "nrUsed": nr_used,
            "nrRemaining": nr_remaining(sunday),
            "overdrawn": after_use < 0 or balance < 0,
        })
        sunday += timedelta(days=PERIOD_DAYS)
    return rows


def state_payload() -> dict:
    with _lock:
        data = load_data()
    today = date.today()
    anchor_date, anchor_balance = effective_anchor(data)
    hire = effective_hire(data)
    birth = effective_birth(data)
    return {
        "anchor": anchor_date.isoformat(),
        "anchorBalance": anchor_balance,
        "anchorEdited": data.get("anchor") is not None,
        "accrual": ACCRUAL_BASE,
        "periodDays": PERIOD_DAYS,
        "cap": CAP_BASE,
        "hireDate": hire.isoformat(),
        "nineYearDate": add_years(hire, 9).isoformat(),
        "birthDate": birth.isoformat() if birth else None,
        "parentalExpiry": add_years(birth, 1).isoformat() if birth else None,
        "parentalTotal": PARENTAL_TOTAL,
        "today": today.isoformat(),
        "entries": data["entries"],
        "holidays": merged_holidays(data),
        "projection": compute_projection(data["entries"], today,
                                         anchor_date, anchor_balance,
                                         hire, birth),
    }


# ---------------------------------------------------------------- web server

class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: bytes, ctype: str, extra=None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, status: int = 200) -> None:
        self._send(status, json.dumps(obj).encode(), "application/json")

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length))

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/" or path.startswith("/index"):
            html = PAGE.replace("__STATIC_STATE__", "null")
            self._send(200, html.encode(), "text/html; charset=utf-8")
        elif path == "/export":
            html = PAGE.replace("__STATIC_STATE__", json.dumps(state_payload()))
            self._send(200, html.encode(), "text/html; charset=utf-8",
                       {"Content-Disposition":
                        'attachment; filename="leave_plan_snapshot.html"'})
        elif path == "/api/state":
            self._json(state_payload())
        else:
            self._send(404, b"not found", "text/plain")

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/api/entry":
            self._post_entry()
        elif path == "/api/holiday":
            self._post_holiday()
        elif path == "/api/anchor":
            self._post_anchor()
        elif path == "/api/hiredate":
            self._post_hiredate()
        elif path == "/api/birthdate":
            self._post_birthdate()
        else:
            self._send(404, b"not found", "text/plain")

    def _post_entry(self):
        try:
            body = self._read_body()
            raw_dates = body["dates"] if "dates" in body else [body["date"]]
            days = [date.fromisoformat(x) for x in raw_dates]
            hours = float(body.get("hours", 0))
            label = str(body.get("label", "")).strip()[:80]
            leave = str(body.get("leaveType", "B")).upper()
            clear = bool(body.get("clear", False))
        except (ValueError, KeyError, TypeError):
            self._json({"ok": False, "error": "Bad request."}, 400)
            return
        if leave not in ("B", "NR"):
            self._json({"ok": False, "error": "Unknown leave type."}, 400)
            return
        if not (0 <= hours <= MAX_DAY_HOURS):
            self._json({"ok": False,
                        "error": f"Hours must be 0-{MAX_DAY_HOURS:g} — a day "
                                 "holds at most 8 h of leave."}, 400)
            return
        if leave == "NR" and not clear and hours != int(hours):
            self._json({"ok": False, "error": "Parental leave is taken in "
                                              "1-hour increments."}, 400)
            return
        with _lock:
            data = load_data()
            anchor_date, _ = effective_anchor(data)
            hols = merged_holidays(data)
            skipped = [d.isoformat() for d in days if d <= anchor_date]
            valid = [d for d in days if d > anchor_date]
            hol_skipped = []
            if not clear and (hours > 0 or label):
                # leave (and labels) never lands on weekends or holidays
                hol_skipped = [d.isoformat() for d in valid
                               if d.isoformat() in hols or d.weekday() >= 5]
                valid = [d for d in valid
                         if d.isoformat() not in hols and d.weekday() < 5]
            if not valid:
                msg = ("Selected day(s) are weekends/holidays — "
                       "they never receive leave."
                       if hol_skipped else
                       f"Dates on or before {anchor_date} are already "
                       "reflected in the starting balance.")
                self._json({"ok": False, "error": msg}, 400)
                return
            window_skipped, unfilled = [], 0
            clamped, full_skipped = 0, 0
            nr_fill = {}
            if leave == "NR" and not clear and hours > 0:
                birth = effective_birth(data)
                if not birth:
                    self._json({"ok": False, "error":
                                "Set the child's birth date (bottom of the "
                                "page) before saving parental leave."}, 400)
                    return
                expiry = add_years(birth, 1)
                # days outside the birth..expiry window are skipped, not fatal
                window_skipped = [d.isoformat() for d in valid
                                  if d < birth or d >= expiry]
                valid = [d for d in valid if birth <= d < expiry]
                if not valid:
                    self._json({"ok": False, "error":
                                f"Parental leave runs {birth} to {expiry} — "
                                "no selected day falls inside that window."},
                               400)
                    return
                # fill days in order until the 480 h pool runs dry — the
                # balance can never go negative
                sel = {d.isoformat() for d in valid}
                other_nr = sum(e.get("nr", 0)
                               for k, e in data["entries"].items()
                               if k not in sel)
                budget = PARENTAL_TOTAL - other_nr
                for day in sorted(valid):
                    key = day.isoformat()
                    cur_b = data["entries"].get(key, {}).get("b", 0.0)
                    room = int(MAX_DAY_HOURS - cur_b)  # 8 h/day combined
                    if room < 1:
                        full_skipped += 1
                        continue
                    give = min(hours, int(budget), room)   # whole hours only
                    if give >= 1:
                        nr_fill[key] = give
                        budget -= give
                        if give < hours:
                            clamped += 1
                    else:
                        unfilled += 1
                if not nr_fill:
                    self._json({"ok": False, "error":
                                "Nothing to book — the selected day(s) are "
                                "full or no parental leave remains."}, 400)
                    return
            for day in valid:
                key = day.isoformat()
                if clear:
                    data["entries"].pop(key, None)
                    continue
                if leave == "NR" and hours > 0 and key not in nr_fill:
                    continue                # pool ran dry / day already full
                e = data["entries"].get(key, {"b": 0.0, "nr": 0.0, "label": ""})
                if leave == "B":
                    give = min(hours, MAX_DAY_HOURS - e["nr"])  # 8 h/day
                    if hours > 0 and give <= 0:
                        full_skipped += 1
                        continue
                    if hours > 0 and give < hours:
                        clamped += 1
                    e["b"] = round(max(0.0, give), 2) if hours > 0 else 0.0
                else:
                    e["nr"] = float(nr_fill.get(key, 0)) if hours > 0 else 0.0
                e["label"] = label
                if e["b"] <= 0 and e["nr"] <= 0 and not e["label"]:
                    data["entries"].pop(key, None)
                else:
                    data["entries"][key] = e
            save_data(data)
        self._json({"ok": True, "skipped": skipped,
                    "holidaySkipped": hol_skipped,
                    "windowSkipped": window_skipped,
                    "unfilled": unfilled,
                    "clamped": clamped,
                    "fullSkipped": full_skipped})

    def _post_holiday(self):
        try:
            body = self._read_body()
            raw_dates = body["dates"] if "dates" in body else [body["date"]]
            days = [date.fromisoformat(x) for x in raw_dates]
            name = str(body.get("name", "")).strip()[:80]
            remove = bool(body.get("remove", False))
        except (ValueError, KeyError, TypeError):
            self._json({"ok": False, "error": "Bad request."}, 400)
            return
        with _lock:
            data = load_data()
            for day in days:
                key = day.isoformat()
                if remove:
                    data["holidays"].pop(key, None)
                    if key in BUILTIN_HOLIDAYS and key not in data["removedHolidays"]:
                        data["removedHolidays"].append(key)
                else:
                    data["holidays"][key] = name or "Holiday"
                    if key in data["removedHolidays"]:
                        data["removedHolidays"].remove(key)
            save_data(data)
        self._json({"ok": True})

    def _post_anchor(self):
        try:
            body = self._read_body()
            balance = float(body["balance"])
            when = (date.fromisoformat(body["date"])
                    if body.get("date") else None)
        except (ValueError, KeyError, TypeError):
            self._json({"ok": False, "error": "Bad request."}, 400)
            return
        if not (-MAX_BALANCE <= balance <= MAX_BALANCE):
            self._json({"ok": False,
                        "error": f"Balance must be between -{MAX_BALANCE:g} "
                                 f"and {MAX_BALANCE:g}."}, 400)
            return
        today = date.today()
        if when is None:
            # snap to the most recent period Sunday on the accrual grid
            periods = max(0, (today - ANCHOR_DATE).days // PERIOD_DAYS)
            when = ANCHOR_DATE + timedelta(days=periods * PERIOD_DAYS)
        if (when - ANCHOR_DATE).days % PERIOD_DAYS != 0:
            self._json({"ok": False,
                        "error": "Date must be a period Sunday on the "
                                 "accrual calendar."}, 400)
            return
        if when > today:
            self._json({"ok": False,
                        "error": "Date can't be in the future."}, 400)
            return
        with _lock:
            data = load_data()
            data["anchor"] = {"date": when.isoformat(),
                              "balance": round(balance, 2)}
            save_data(data)
        self._json({"ok": True, "date": when.isoformat()})

    def _post_hiredate(self):
        try:
            when = date.fromisoformat(self._read_body()["date"])
        except (ValueError, KeyError, TypeError):
            self._json({"ok": False, "error": "Bad request."}, 400)
            return
        with _lock:
            data = load_data()
            data["hireDate"] = when.isoformat()
            save_data(data)
        self._json({"ok": True})

    def _post_birthdate(self):
        try:
            raw = self._read_body().get("date") or ""
            when = date.fromisoformat(raw) if raw else None
        except (ValueError, TypeError):
            self._json({"ok": False, "error": "Bad request."}, 400)
            return
        with _lock:
            data = load_data()
            data["birthDate"] = when.isoformat() if when else None
            save_data(data)
        self._json({"ok": True})

    def log_message(self, *args):  # keep the console quiet
        pass


# ------------------------------------------------------------------ the page

PAGE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Leave Planner</title>
<script>
  window.STATIC_STATE = __STATIC_STATE__;
  document.documentElement.dataset.theme =
      localStorage.getItem("ptoTheme") || "dark";
</script>
<style>
  :root {
    color-scheme: light;
    --page:        #f9f9f7;
    --surface:     #fcfcfb;
    --ink:         #0b0b0b;
    --ink-2:       #52514e;
    --muted:       #898781;
    --grid:        #e1e0d9;
    --axis:        #c3c2b7;
    --border:      rgba(11,11,11,0.10);
    --series:      #2a78d6;
    --leave-b:     #008300;   /* PTOB (B): green */
    --leave-nr:    #d55181;   /* Parental (NR): pink */
    --critical:    #d03b3b;
    --warning:     #b97f00;
    --hol-bg:      #e2f2e0;
    --hol-ink:     #006300;
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --page:        #0d0d0d;
    --surface:     #1a1a19;
    --ink:         #ffffff;
    --ink-2:       #c3c2b7;
    --muted:       #898781;
    --grid:        #2c2c2a;
    --axis:        #383835;
    --border:      rgba(255,255,255,0.10);
    --series:      #3987e5;
    --leave-b:     #0ca30c;   /* PTOB (B): green, stepped for dark */
    --leave-nr:    #e87ba4;   /* Parental (NR): pink, stepped for dark */
    --critical:    #e66767;
    --warning:     #fab219;
    --hol-bg:      #1c2e1a;
    --hol-ink:     #0ca30c;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px;
    background: var(--page); color: var(--ink);
    font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  h1 { font-size: 20px; margin: 0; }
  .titlebar { display: flex; align-items: center; gap: 10px; margin-bottom: 2px; }
  .titlebar .spacer { flex: 1; }
  .sub { color: var(--ink-2); margin: 0 0 16px; font-size: 13px; }
  .wrap { max-width: 1180px; margin: 0 auto; }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
           gap: 12px; margin-bottom: 16px; }
  .tile { background: var(--surface); border: 1px solid var(--border);
          border-radius: 10px; padding: 12px 14px; }
  .tile .label { color: var(--muted); font-size: 12px; }
  .tile .value { font-size: 24px; font-weight: 600; margin-top: 2px; }
  .tile .note  { color: var(--ink-2); font-size: 12px; margin-top: 2px; }
  .tile .value.bad  { color: var(--critical); }
  .tile .value.editable { cursor: pointer; }
  .tile .value.editable:hover { color: var(--series); }
  .tile input {
    width: 120px; font: inherit; font-size: 20px; font-weight: 600;
    background: var(--page); color: var(--ink);
    border: 1px solid var(--series); border-radius: 7px; padding: 2px 6px;
  }

  .cols { display: grid; grid-template-columns: minmax(400px, 480px) 1fr;
          gap: 16px; align-items: start; }
  @media (max-width: 940px) { .cols { grid-template-columns: 1fr; } }

  .card { background: var(--surface); border: 1px solid var(--border);
          border-radius: 10px; padding: 14px; }
  .card h2 { font-size: 14px; margin: 0 0 10px; }

  /* ---- calendar ---- */
  .cal-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .cal-head .month { font-weight: 600; flex: 1; text-align: center; }
  button {
    background: var(--surface); color: var(--ink);
    border: 1px solid var(--border); border-radius: 7px;
    padding: 5px 10px; font: inherit; cursor: pointer;
  }
  button:hover { border-color: var(--muted); }
  button.primary { background: var(--series); border-color: var(--series); color: #fff; }
  .dow { display: grid; grid-template-columns: repeat(7, 1fr); text-align: center;
         color: var(--muted); font-size: 11px; margin-bottom: 4px; }
  .grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 3px;
          user-select: none; touch-action: pan-y; }
  .day {
    min-height: 76px; border: 1px solid transparent; border-radius: 7px;
    padding: 3px 5px; cursor: pointer; font-size: 12px;
    min-width: 0; overflow: hidden;
  }
  .day:hover { border-color: var(--muted); }
  .day .num { color: var(--ink-2); }
  .day.out .num { opacity: 0.5; }
  .day.altperiod { background: color-mix(in srgb, var(--grid) 35%, transparent); }
  .day.holiday { background: var(--hol-bg); }
  .day.today { border-color: var(--series); }
  .day.past .num { color: var(--muted); }
  .day.selected { outline: 2px solid var(--series); }
  .pto { display: block; width: fit-content; background: var(--series); color: #fff;
         border-radius: 999px; padding: 0 7px; font-size: 11px; margin-top: 2px; }
  .pto.b  { background: var(--leave-b); }
  .pto.nr { background: var(--leave-nr); color: #1a1a19; }
  button.saveb  { background: var(--leave-b); border-color: var(--leave-b); color: #fff; }
  button.savenr { background: var(--leave-nr); border-color: var(--leave-nr); color: #1a1a19; }
  .lbl { display: block; font-size: 10px; color: var(--ink-2); line-height: 1.25;
         overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .holname { display: block; font-size: 10px; color: var(--hol-ink); line-height: 1.25;
             overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .accr { display: block; font-size: 10px; color: var(--muted); line-height: 1.25;
          margin-top: 1px; }
  .accr b { color: var(--ink-2); font-weight: 600; }
  .accr.overdrawn b { color: var(--critical); }

  /* ---- editor ---- */
  .editor { border-top: 1px solid var(--grid); margin-top: 10px; padding-top: 10px; }
  .editor .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
                 margin-bottom: 6px; }
  .editor input[type=number] {
    width: 80px; padding: 5px 8px; font: inherit;
    background: var(--page); color: var(--ink);
    border: 1px solid var(--border); border-radius: 7px;
  }
  .editor input[type=text] {
    flex: 1; min-width: 140px; padding: 5px 8px; font: inherit;
    background: var(--page); color: var(--ink);
    border: 1px solid var(--border); border-radius: 7px;
  }
  .editor .hint { color: var(--muted); font-size: 12px; }
  .editor .err { color: var(--critical); font-size: 12px; }
  .editor .holinfo { color: var(--hol-ink); font-size: 12px; }

  /* ---- chart ---- */
  .chart-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .chart-head h2 { flex: 1; margin: 0; }
  select { background: var(--surface); color: var(--ink); font: inherit;
           border: 1px solid var(--border); border-radius: 7px; padding: 4px 8px; }
  #chartbox { position: relative; }
  #tooltip {
    position: absolute; pointer-events: none; display: none; z-index: 5;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; padding: 8px 10px; font-size: 12px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.18); min-width: 150px; max-width: 240px;
  }
  #tooltip .t-date { color: var(--muted); margin-bottom: 3px; }
  #tooltip .t-bal  { font-size: 15px; font-weight: 600; }
  #tooltip .t-line { color: var(--ink-2); }
  #tooltip .t-line.lost { color: var(--warning); }
  #tooltip .t-line.od   { color: var(--critical); font-weight: 600; }
  #tooltip .t-line.nr   { color: var(--leave-nr); }
  .legend-note { color: var(--muted); font-size: 12px; margin-top: 4px; }
  svg text { font: 11px system-ui, -apple-system, "Segoe UI", sans-serif;
             font-variant-numeric: tabular-nums; fill: var(--muted); }
  svg .dlabel { fill: var(--ink-2); font-weight: 600; }
  svg .hover-target { cursor: pointer; }

  /* ---- hire-date footer ---- */
  .foot { margin-top: 16px; display: flex; gap: 12px; align-items: center;
          flex-wrap: wrap; font-size: 13px; }
  .foot input[type=date] {
    font: inherit; padding: 4px 8px; margin-left: 6px;
    background: var(--page); color: var(--ink);
    border: 1px solid var(--border); border-radius: 7px;
  }
  .foot #hireInfo { color: var(--muted); font-size: 12px; }

  /* ---- mobile-only adjustments (desktop is untouched) ---- */
  .touch-hint { display: none; }
  .mobile-tip { display: none; color: var(--muted); font-size: 11px;
                margin: 2px 0 6px; }
  #rangeHint { display: none; color: var(--series); font-size: 12px;
               margin: 4px 0 6px; }
  @media (max-width: 700px) {
    body { padding: 12px; }
    h1 { font-size: 18px; }
    .titlebar { flex-wrap: wrap; }
    /* declutter: hide explanatory text; the mobile tip covers the gestures */
    .sub, .legend-note, .editor .hint { display: none; }
    /* metrics are secondary on a phone: move them below calendar + chart */
    .wrap { display: flex; flex-direction: column; }
    .tiles { order: 3; margin-bottom: 0; margin-top: 12px;
             grid-template-columns: repeat(2, 1fr); gap: 8px; }
    .foot { order: 4; }
    .tile { padding: 9px 10px; }
    .tile .value { font-size: 19px; }
    .cols { gap: 12px; }
    .card { padding: 10px; }
    .day { min-height: 58px; padding: 2px 3px; font-size: 11px; }
    .pto { font-size: 10px; padding: 0 5px; }
    .accr, .lbl, .holname { font-size: 9px; }
  }
  @media (pointer: coarse) {
    button { padding: 8px 12px; }
    .grid { -webkit-touch-callout: none; }
    .touch-hint { display: inline; }
    .mobile-tip { display: block; }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="titlebar">
    <h1>Leave Planner</h1>
    <div class="spacer"></div>
    <button id="themeBtn" title="Toggle light/dark">Theme</button>
    <button id="unitsBtn" title="Display in hours or days (8 h = 1 d)"></button>
    <button id="saveBtn" title="Download a standalone snapshot of this page">Save snapshot</button>
  </div>
  <p class="sub"><b style="color:var(--leave-b)">PTOB (B), green</b>:
     6.7692 h accrue every two weeks, 8.000 h after nine years
     (balance posts every other Sunday); cap 240 h, 320 h after nine years;
     <span id="subAnchor"></span> &middot;
     <b style="color:var(--leave-nr)">Parental (NR), pink</b>:
     480 h (12 weeks) from the child's birth date, 1-h increments,
     expires one year after birth &middot;
     weekends &amp; holidays never receive leave; calendar shading
     alternates by pay period.
     Click a day &mdash; or click and drag &mdash; then Save.
     <span class="touch-hint">On touch: long-press a day to start a range,
     then tap the last day.</span></p>

  <div class="tiles" id="tiles"></div>

  <div class="cols">
    <div class="card">
      <div class="cal-head">
        <button id="prev" title="Previous month">&#8249;</button>
        <div class="month" id="monthLabel"></div>
        <button id="todayBtn">Today</button>
        <button id="next" title="Next month">&#8250;</button>
      </div>
      <div class="dow"><span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span></div>
      <div class="mobile-tip">Tap a day &middot; hold to start a range</div>
      <div id="rangeHint">Range started &mdash; tap the last day of the range.</div>
      <div class="grid" id="calGrid"></div>
      <div class="editor" id="editor" style="display:none">
        <div class="row"><strong id="edDate"></strong>
          <span class="holinfo" id="edHolInfo"></span></div>
        <div class="row">
          <input type="number" id="edHours" min="0" max="8" step="0.25"> h/day
          <input type="text" id="edLabel" maxlength="80"
                 placeholder="Label (e.g. Hawaii trip)">
        </div>
        <div class="row">
          <button class="saveb" id="edSaveB">Save (PTOB)</button>
          <button class="savenr" id="edSaveNR">Save (Parent)</button>
          <button id="edClear">Clear</button>
        </div>
        <div class="row">
          <button id="edHoliday">Mark as holiday</button>
          <button id="edUnholiday">Remove holiday</button>
          <span class="hint">holiday name comes from the label box</span>
        </div>
        <div class="hint">Each Save applies the h/day amount as that leave
          type; a day can hold both, up to 8 h combined. Parental leave is
          whole hours only. Clear removes everything on the selected days.
          Weekends and holidays are always skipped.</div>
        <div class="err" id="edErr"></div>
      </div>
    </div>

    <div class="card">
      <div class="chart-head">
        <h2>Projected balance</h2>
        <label>Horizon
          <select id="horizon">
            <option value="6">6 months</option>
            <option value="12" selected>12 months</option>
            <option value="18">18 months</option>
            <option value="24">24 months</option>
          </select>
        </label>
      </div>
      <div id="chartbox">
        <svg id="chart" width="100%" height="340"></svg>
        <div id="tooltip"></div>
      </div>
      <div class="legend-note"><b style="color:var(--leave-b)">Green</b> = PTOB
        balance at each period Sunday; dashed line = its cap (steps up at the
        9-year mark); red points = overdrawn.
        <b style="color:var(--leave-nr)">Pink</b> = parental leave remaining,
        from birth until the red dotted line one year later.
        Click a point to jump the calendar there.</div>
    </div>
  </div>

  <div class="card foot">
    <label>Hire date <input type="date" id="hireDate"></label>
    <label>Child's birth date <input type="date" id="birthDate"></label>
    <button id="birthClear" title="Remove birth date">&#10005;</button>
    <span id="hireInfo"></span>
  </div>
</div>

<script>
"use strict";
let STATE = null;
let viewYear, viewMonth;          // calendar month being shown
let selection = new Set();        // ISO dates currently selected
let dragging = false, dragAnchor = null, dragMoved = false;
// touch-only range selection (long-press to start, tap to finish)
let touchRange = {active: false, anchor: null};
let suppressOpen = false, longPressTimer = null, lastPointerType = "mouse";
const IS_STATIC = !!window.STATIC_STATE;

const $ = id => document.getElementById(id);
const fmtH = v => (Math.round(v * 100) / 100).toLocaleString("en-US",
                  {minimumFractionDigits: 2, maximumFractionDigits: 2});
// display units: all math stays in hours; "d" only converts what is shown
let UNITS = localStorage.getItem("ptoUnits") || "h";
const HRS_PER_DAY = 8;
const cv = v => UNITS === "d" ? v / HRS_PER_DAY : v;
const fmtU = v => fmtH(cv(v));
const unitSuffix = () => UNITS;
const iso = d => d.toISOString().slice(0, 10);
const parseISO = s => { const [y,m,dd] = s.split("-").map(Number);
                        return new Date(Date.UTC(y, m - 1, dd)); };
const fmtDate = s => parseISO(s).toLocaleDateString("en-US",
                  {timeZone:"UTC", weekday:"short", month:"short", day:"numeric", year:"numeric"});
const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
                  .replace(/"/g, "&quot;");
const PERIOD_EPOCH = Date.UTC(2026, 6, 26);   // a period Sunday (grid anchor)
const isWeekend = ds => { const dow = parseISO(ds).getUTCDay();
                          return dow === 0 || dow === 6; };
// which two-week pay period a date falls in (periods end on grid Sundays)
const periodIndex = ds => Math.floor(
    ((parseISO(ds).getTime() - PERIOD_EPOCH) / 86400000 + 13) / 14);

async function fetchState() {
  STATE = IS_STATIC ? window.STATIC_STATE
                    : await (await fetch("/api/state")).json();
  STATE.projByDate = {};
  for (const row of STATE.projection) STATE.projByDate[row.date] = row;
}

function entryB(ds)  { const e = STATE.entries[ds]; return e ? (e.b  || 0) : 0; }
function entryNR(ds) { const e = STATE.entries[ds]; return e ? (e.nr || 0) : 0; }

// parental hours remaining as of a date (null before birth / no birth set)
function nrRemainingAt(ds) {
  if (!STATE.birthDate || ds < STATE.birthDate) return null;
  if (ds >= STATE.parentalExpiry) return 0;
  let used = 0;
  for (const [d, e] of Object.entries(STATE.entries))
    if (d >= STATE.birthDate && d <= ds) used += e.nr || 0;
  return Math.max(0, STATE.parentalTotal - used);
}

/* ------------------------------------------------ summary tiles */
function renderTiles() {
  $("subAnchor").textContent = "anchor " + fmtU(STATE.anchorBalance) + " " +
      unitSuffix() + " on " +
      fmtDate(STATE.anchor) + (STATE.anchorEdited ? " (edited)" : "");
  const today = STATE.today;
  const proj = STATE.projection;
  let current = proj[0], next = null;
  for (const row of proj) {
    if (row.date <= today) current = row;
    else if (!next) next = row;
  }
  const horizonMonths = +$("horizon").value;
  const endD = parseISO(today); endD.setUTCMonth(endD.getUTCMonth() + horizonMonths);
  const shown = proj.filter(r => r.date <= iso(endD));
  const lost = shown.reduce((a, r) => a + r.lost, 0);
  const firstOver = shown.find(r => r.overdrawn);
  const futureDays = Object.entries(STATE.entries)
      .filter(([d, e]) => d > today && (e.b > 0 || e.nr > 0));
  const plannedFuture = futureDays.reduce((a, [, e]) => a + (e.b || 0), 0);

  const tiles = [
    {label: "Current balance", value: fmtU(current.balance) + " " + unitSuffix(),
     note: "as of " + fmtDate(current.date) +
           (IS_STATIC ? "" : " · click value to edit")},
    {label: "Next accrual",
     value: "+" + fmtU(next ? next.accrued : STATE.accrual) + " " + unitSuffix(),
     note: next ? "posts " + fmtDate(next.date) : ""},
    {label: "Planned PTO (future)", value: fmtU(plannedFuture) + " " + unitSuffix(),
     note: futureDays.length + " day(s) marked"},
    {label: "Lost to cap", value: fmtU(lost) + " " + unitSuffix(),
     note: "next " + horizonMonths + " months", bad: lost > 0},
  ];
  if (STATE.birthDate && today < STATE.parentalExpiry) {
    // count every planned parental day, past and future
    let booked = 0;
    for (const e of Object.values(STATE.entries)) booked += e.nr || 0;
    const rem = Math.max(0, STATE.parentalTotal - booked);
    tiles.push({label: "Parental leave left",
                value: fmtU(rem) + " " + unitSuffix(),
                note: "after planned days · expires " + fmtDate(STATE.parentalExpiry),
                bad: rem <= 0});
  }
  if (firstOver) tiles.push({label: "Overdrawn",
                             value: fmtU(firstOver.balance) + " " + unitSuffix(),
                             note: "period of " + fmtDate(firstOver.date), bad: true});
  $("tiles").innerHTML = tiles.map(t =>
    `<div class="tile"><div class="label">${t.label}</div>` +
    `<div class="value${t.bad ? " bad" : ""}">${t.value}</div>` +
    `<div class="note">${t.note}</div></div>`).join("");
  if (!IS_STATIC) {
    const balVal = $("tiles").children[0].querySelector(".value");
    balVal.classList.add("editable");
    balVal.title = "Click to edit the current balance";
    balVal.addEventListener("click", () => editBalance(balVal, current.balance));
  }
}

function editBalance(div, current) {
  if (div.querySelector("input")) return;
  div.classList.remove("editable");
  // period Sundays on the accrual grid, most recent first, back ~1 year
  const latest = [...STATE.projection].filter(r => r.date <= STATE.today).pop();
  const sundays = [];
  const d = parseISO(latest ? latest.date : STATE.anchor);
  for (let i = 0; i < 27; i++) {
    sundays.push(iso(d));
    d.setUTCDate(d.getUTCDate() - 14);
  }
  const opts = sundays.map((s, i) =>
      `<option value="${s}"${i === 0 ? " selected" : ""}>as of ${fmtDate(s)}</option>`).join("");
  div.innerHTML = `<input type="number" step="0.01" min="-320" max="320"
                    value="${current}"> h<br>
                   <select style="font-size:13px;font-weight:400;margin-top:4px">${opts}</select>`;
  const inp = div.querySelector("input");
  const sel = div.querySelector("select");
  inp.focus(); inp.select();
  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const v = parseFloat(inp.value);
    if (isNaN(v)) { renderTiles(); return; }
    const out = await post("/api/anchor", {balance: v, date: sel.value});
    if (out && out.ok) await refresh(); else renderTiles();
  };
  inp.addEventListener("keydown", e => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { done = true; renderTiles(); }
  });
  sel.addEventListener("keydown", e => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") { done = true; renderTiles(); }
  });
  // commit only when focus leaves the whole editor (input + select)
  div.addEventListener("focusout", e => {
    if (!div.contains(e.relatedTarget)) commit();
  });
}

/* ------------------------------------------------ calendar */
function renderCalendar() {
  const label = new Date(Date.UTC(viewYear, viewMonth, 1))
      .toLocaleDateString("en-US", {timeZone:"UTC", month: "long", year: "numeric"});
  $("monthLabel").textContent = label;

  const first = new Date(Date.UTC(viewYear, viewMonth, 1));
  const start = new Date(first);
  start.setUTCDate(1 - first.getUTCDay());          // back to Sunday
  const cells = [];
  const d = new Date(start);
  for (let i = 0; i < 42; i++) {
    const ds = iso(d);
    const inMonth = d.getUTCMonth() === viewMonth;
    const cls = ["day"];
    if (!inMonth) cls.push("out");
    if (((periodIndex(ds) % 2) + 2) % 2 === 1) cls.push("altperiod");
    if (STATE.holidays[ds]) cls.push("holiday");
    if (ds === STATE.today) cls.push("today");
    if (ds < STATE.today) cls.push("past");
    if (selection.has(ds)) cls.push("selected");
    let inner = `<span class="num">${d.getUTCDate()}</span>`;
    const e = STATE.entries[ds];
    if (e && e.b > 0)
      inner += `<span class="pto b" title="PTOB">${fmtU(e.b)}${unitSuffix()}</span>`;
    if (e && e.nr > 0)
      inner += `<span class="pto nr" title="Parental leave">${fmtU(e.nr)}${unitSuffix()}</span>`;
    if (e && e.label) inner += `<span class="lbl" title="${esc(e.label)}">${esc(e.label)}</span>`;
    if (STATE.holidays[ds])
      inner += `<span class="holname">${esc(STATE.holidays[ds].name)}</span>`;
    const row = STATE.projByDate[ds];
    if (row) {
      const od = row.overdrawn ? " overdrawn" : "";
      inner += `<span class="accr${od}">bal <b>${fmtU(row.balance)}</b></span>`;
    }
    cells.push(`<div class="${cls.join(" ")}" data-date="${ds}">${inner}</div>`);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  $("calGrid").innerHTML = cells.join("");
  for (const el of $("calGrid").children) {
    el.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      e.preventDefault();
      lastPointerType = e.pointerType;
      const ds = el.dataset.date;
      if (touchRange.active) {             // second tap completes the range
        selectRange(touchRange.anchor, ds);
        touchRange.active = false;
        $("rangeHint").style.display = "none";
        updateSelectionClasses();
        dragging = true;                   // pointerup opens the editor
        return;
      }
      dragging = true; dragMoved = false;
      dragAnchor = ds;
      selection = new Set([ds]);
      updateSelectionClasses();
      if (e.pointerType === "touch") {     // long-press starts range mode
        clearTimeout(longPressTimer);
        longPressTimer = setTimeout(() => {
          touchRange = {active: true, anchor: ds};
          suppressOpen = true;
          $("rangeHint").style.display = "block";
          if (navigator.vibrate) navigator.vibrate(15);
        }, 450);
      }
    });
    el.addEventListener("pointerenter", () => {
      if (!dragging || el.dataset.date === dragAnchor) return;
      dragMoved = true;
      selectRange(dragAnchor, el.dataset.date);
      updateSelectionClasses();
    });
  }
}

function updateSelectionClasses() {
  for (const el of $("calGrid").children)
    el.classList.toggle("selected", selection.has(el.dataset.date));
}

function selectRange(a, b) {
  if (b < a) [a, b] = [b, a];
  selection = new Set();
  const d = parseISO(a), end = parseISO(b);
  while (d <= end) { selection.add(iso(d)); d.setUTCDate(d.getUTCDate() + 1); }
}

function openEditor() {
  const dates = [...selection].sort();
  if (!dates.length) return;
  $("editor").style.display = "";
  if (dates.length === 1) {
    $("edDate").textContent = fmtDate(dates[0]);
    const hol = STATE.holidays[dates[0]];
    $("edHolInfo").textContent = hol ? "Holiday: " + hol.name : "";
  } else {
    $("edDate").textContent = dates.length + " days: " +
        fmtDate(dates[0]) + " – " + fmtDate(dates[dates.length - 1]);
    const hols = dates.filter(d => STATE.holidays[d]).length;
    $("edHolInfo").textContent = hols ? hols + " holiday(s) in range" : "";
  }
  const existingB = new Set(dates.map(d => entryB(d)));
  const existingNR = new Set(dates.map(d => entryNR(d)));
  const uniform = existingB.size === 1 && [...existingB][0] > 0 ? [...existingB][0]
                : existingNR.size === 1 && [...existingNR][0] > 0 ? [...existingNR][0]
                : 0;
  $("edHours").value = uniform > 0 ? uniform : 8;   // default to a full day
  const existingL = new Set(dates.map(d => (STATE.entries[d] || {}).label || ""));
  $("edLabel").value = existingL.size === 1 ? [...existingL][0] : "";
  $("edErr").textContent = "";
  // focusing the input pops up the keyboard on touch devices — skip it there
  if (lastPointerType !== "touch") $("edLabel").focus();
}

function datesToSave(addingContent) {
  let dates = [...selection].sort();
  let holSkipped = 0;
  if (addingContent) {   // PTO/labels never land on weekends or holidays
    dates = dates.filter(d => !isWeekend(d));
    const n = dates.length;
    dates = dates.filter(d => !STATE.holidays[d]);
    holSkipped = n - dates.length;
  }
  return {dates, holSkipped};
}

async function post(url, body) {
  if (IS_STATIC) {
    $("edErr").textContent = "This is a static snapshot — run leave_planner.py to edit.";
    return null;
  }
  const res = await fetch(url, {
    method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body),
  });
  return res.json();
}

async function saveLeave(leaveType) {
  const hours = parseFloat($("edHours").value) || 0;
  const label = $("edLabel").value.trim();
  const {dates, holSkipped} = datesToSave(hours > 0 || label);
  if (!dates.length) {
    $("edErr").textContent =
        "Weekends and holidays never receive leave — nothing to save.";
    return;
  }
  if (leaveType === "NR" && hours > 0) {
    if (!STATE.birthDate) {
      $("edErr").textContent =
          "Set the child's birth date (bottom of the page) first.";
      return;
    }
    if (hours !== Math.round(hours)) {
      $("edErr").textContent = "Parental leave is taken in 1-hour increments.";
      return;
    }
  }
  const out = await post("/api/entry", {dates, hours, label, leaveType});
  if (!out) return;
  if (!out.ok) { $("edErr").textContent = out.error || "Save failed."; return; }
  const notes = [];
  if (holSkipped) notes.push(holSkipped + " holiday(s) skipped");
  if (out.windowSkipped && out.windowSkipped.length)
    notes.push(out.windowSkipped.length + " day(s) outside the parental window skipped");
  if (out.unfilled)
    notes.push(out.unfilled + " day(s) left unfilled — parental leave exhausted");
  if (out.clamped)
    notes.push(out.clamped + " day(s) reduced to fit the 8 h/day limit");
  if (out.fullSkipped)
    notes.push(out.fullSkipped + " day(s) already at 8 h skipped");
  if (out.skipped && out.skipped.length)
    notes.push(out.skipped.length + " day(s) on/before the anchor date skipped");
  // informational notes stay quiet on small screens; real errors still show
  $("edErr").textContent =
      window.matchMedia("(max-width: 700px)").matches ? "" : notes.join("; ");
  await refresh();
}

async function clearDays() {
  const dates = [...selection].sort();
  if (!dates.length) return;
  $("edLabel").value = "";
  const out = await post("/api/entry", {dates, hours: 0, label: "", clear: true});
  if (!out) return;
  if (!out.ok) { $("edErr").textContent = out.error || "Clear failed."; return; }
  $("edErr").textContent = "";
  await refresh();
}

async function setHoliday(remove) {
  const dates = [...selection].sort();
  if (!dates.length) return;
  const out = await post("/api/holiday",
      {dates, name: $("edLabel").value.trim(), remove});
  if (!out) return;
  if (!out.ok) { $("edErr").textContent = out.error || "Save failed."; return; }
  $("edErr").textContent = "";
  await refresh();
  openEditor();
}

/* ------------------------------------------------ line chart */
function periodLabels(row) {
  // labels of entries inside the 14-day window ending on this period Sunday
  const end = parseISO(row.date);
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - 13);
  const s0 = iso(start), s1 = row.date;
  const groups = {};
  for (const [d, e] of Object.entries(STATE.entries)) {
    const h = (e.b || 0) + (e.nr || 0);
    if (d >= s0 && d <= s1 && h > 0 && e.label)
      groups[e.label] = (groups[e.label] || 0) + h;
  }
  return Object.entries(groups);
}

function renderChart() {
  const svg = $("chart");
  const box = $("chartbox");
  const isNarrow = window.matchMedia("(max-width: 700px)").matches;
  const isCoarse = window.matchMedia("(pointer: coarse)").matches;
  const W = box.clientWidth || 700, H = isNarrow ? 260 : 340;
  const tapR = isCoarse ? 16 : 11;
  const M = {top: 22, right: 76, bottom: 30, left: 48};
  svg.setAttribute("height", H);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  const horizonMonths = +$("horizon").value;
  const endD = parseISO(STATE.today);
  endD.setUTCMonth(endD.getUTCMonth() + horizonMonths);
  const rows = STATE.projection.filter(r => r.date <= iso(endD));
  if (rows.length < 2) { svg.innerHTML = ""; return; }

  const t0 = parseISO(rows[0].date).getTime();
  const t1 = parseISO(rows[rows.length - 1].date).getTime();
  // data sits to the right of the y-axis: inset the plot area
  const plotL = M.left + 14, plotR = W - M.right;
  const minBal = Math.min(0, ...rows.map(r => r.balance));
  const yMin = Math.min(0, Math.floor(minBal / 60) * 60);
  const maxCap = Math.max(...rows.map(r => r.cap || 240));
  // if the parental window overlaps the horizon, make room for 480 h
  const parentalVisible = STATE.birthDate &&
      STATE.birthDate <= rows[rows.length - 1].date &&
      STATE.parentalExpiry >= rows[0].date;
  const yMax = (parentalVisible ? Math.max(maxCap, STATE.parentalTotal) : maxCap) + 10;
  const x = t => plotL + (t - t0) / (t1 - t0) * (plotR - plotL);
  const y = v => M.top + (yMax - v) / (yMax - yMin) * (H - M.top - M.bottom);
  const axisU = v => Math.round(cv(v) * 100) / 100;

  let s = "";
  // y gridlines + labels (multiples of 60 from yMin up to the cap)
  for (let v = yMin; v <= yMax - 10; v += 60) {
    s += `<line x1="${M.left}" x2="${W - M.right}" y1="${y(v)}" y2="${y(v)}"
           stroke="var(--grid)" stroke-width="1"/>`;
    s += `<text x="${M.left - 8}" y="${y(v) + 4}" text-anchor="end">${axisU(v)}</text>`;
  }
  // cap line (dashed; steps up when the 9-year rate/cap bump lands)
  let capD = `M ${M.left} ${y(rows[0].cap || 240)}`;
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i].cap || 240) !== (rows[i - 1].cap || 240)) {
      const xs = x(parseISO(rows[i].date).getTime());
      capD += ` H ${xs} V ${y(rows[i].cap || 240)}`;
    }
  }
  capD += ` H ${W - M.right}`;
  s += `<path d="${capD}" fill="none" stroke="var(--axis)"
         stroke-width="1.5" stroke-dasharray="5 4"/>`;
  // x ticks: true month boundaries (the 1st), evenly thinned to the width.
  // The year is attached to the first rendered label of each new year, so
  // the rollover stays visible no matter which months survive thinning.
  const months = [];
  {
    const d = parseISO(rows[0].date);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);        // first 1st-of-month in range
    while (d.getTime() <= t1) {
      months.push(new Date(d));
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
  }
  const maxLabels = Math.max(4, Math.floor((plotR - plotL) / 46));
  const step = Math.ceil(months.length / maxLabels);
  let prevYear = null, lastTickX = -Infinity;
  months.forEach((dt, i) => {
    if (i % step) return;
    const px = x(dt.getTime());
    if (px - lastTickX < 40) return;      // safety net; rare with even ticks
    lastTickX = px;
    const yr = dt.getUTCFullYear();
    const lbl = dt.toLocaleDateString("en-US", {timeZone:"UTC", month: "short"}) +
        (yr !== prevYear ? " '" + String(yr).slice(2) : "");
    prevYear = yr;
    s += `<line x1="${px}" x2="${px}" y1="${H - M.bottom}" y2="${H - M.bottom + 4}"
           stroke="var(--axis)" stroke-width="1"/>`;
    s += `<text x="${px}" y="${H - 8}" text-anchor="middle">${lbl}</text>`;
  });
  // zero baseline + y axis
  s += `<line x1="${M.left}" x2="${W - M.right}" y1="${y(0)}" y2="${y(0)}"
         stroke="var(--axis)" stroke-width="1"/>`;
  s += `<line x1="${M.left}" x2="${M.left}" y1="${M.top}" y2="${H - M.bottom}"
         stroke="var(--axis)" stroke-width="1"/>`;
  // today marker
  const tNow = parseISO(STATE.today).getTime();
  if (tNow >= t0 && tNow <= t1) {
    s += `<line x1="${x(tNow)}" x2="${x(tNow)}" y1="${M.top}" y2="${H - M.bottom}"
           stroke="var(--axis)" stroke-width="1" stroke-dasharray="2 3"/>`;
    s += `<text x="${x(tNow)}" y="${M.top - 6}" text-anchor="middle">today</text>`;
  }
  // parental leave line (pink): from birth, down as taken, dead at +1 year
  if (parentalVisible) {
    const bT = parseISO(STATE.birthDate).getTime();
    const eT = parseISO(STATE.parentalExpiry).getTime();
    const seg = [];
    const startT = Math.max(bT, t0);
    seg.push([x(startT), y(nrRemainingAt(iso(new Date(startT))))]);
    for (const r of rows) {
      const rT = parseISO(r.date).getTime();
      if (rT > startT && rT < Math.min(eT, t1) && r.nrRemaining !== null)
        seg.push([x(rT), y(r.nrRemaining)]);
    }
    const endT = Math.min(eT, t1);
    const endVal = nrRemainingAt(iso(new Date(endT - 86400000)));
    seg.push([x(endT), y(Math.max(0, endVal ?? 0))]);
    s += `<polyline fill="none" stroke="var(--leave-nr)" stroke-width="2"
           stroke-linejoin="round" points="${seg.map(p => p.join(",")).join(" ")}"/>`;
    if (eT <= t1) {
      // expiry: red dotted line where the remaining balance becomes zero
      s += `<line x1="${x(eT)}" x2="${x(eT)}" y1="${M.top}" y2="${H - M.bottom}"
             stroke="var(--critical)" stroke-width="1.5" stroke-dasharray="2 4"/>`;
    }
  }
  // PTOB series line (green)
  const pts = rows.map(r => [x(parseISO(r.date).getTime()), y(r.balance)]);
  s += `<polyline fill="none" stroke="var(--leave-b)" stroke-width="2"
         stroke-linejoin="round" points="${pts.map(p => p.join(",")).join(" ")}"/>`;
  // crosshair (moved on hover)
  s += `<line id="xhair" x1="0" x2="0" y1="${M.top}" y2="${H - M.bottom}"
         stroke="var(--muted)" stroke-width="1" visibility="hidden"/>`;
  // points + invisible hover targets
  rows.forEach((r, i) => {
    const [px, py] = pts[i];
    const c = r.overdrawn ? "var(--critical)" : "var(--leave-b)";
    s += `<circle cx="${px}" cy="${py}" r="3" fill="${c}"
           stroke="var(--surface)" stroke-width="2"/>`;
    s += `<circle cx="${px}" cy="${py}" r="${tapR}" fill="transparent"
           data-i="${i}" class="hover-target"/>`;
  });
  // pink line points: same hover/click behavior as the green line
  if (parentalVisible) {
    rows.forEach((r, i) => {
      if (r.nrRemaining === null || r.nrRemaining === undefined) return;
      if (r.date < STATE.birthDate || r.date >= STATE.parentalExpiry) return;
      const px = x(parseISO(r.date).getTime()), py = y(r.nrRemaining);
      s += `<circle cx="${px}" cy="${py}" r="3" fill="var(--leave-nr)"
             stroke="var(--surface)" stroke-width="2"/>`;
      s += `<circle cx="${px}" cy="${py}" r="${tapR}" fill="transparent"
             data-i="${i}" class="hover-target"/>`;
    });
  }
  // direct label on last point
  const last = rows[rows.length - 1];
  s += `<text class="dlabel" fill="var(--leave-b)" x="${pts[pts.length - 1][0] + 6}"
         y="${pts[pts.length - 1][1] + 4}">${fmtU(last.balance)}</text>`;
  svg.innerHTML = s;

  const tip = $("tooltip");
  const xhair = svg.querySelector("#xhair");
  for (const el of svg.querySelectorAll(".hover-target")) {
    el.addEventListener("mouseenter", () => {
      const r = rows[+el.dataset.i];
      const px = pts[+el.dataset.i][0];
      xhair.setAttribute("x1", px); xhair.setAttribute("x2", px);
      xhair.setAttribute("visibility", "visible");
      let html = `<div class="t-date">${fmtDate(r.date)}</div>` +
                 `<div class="t-bal">${fmtU(r.balance)} ${unitSuffix()}</div>`;
      if (r.accrued) html += `<div class="t-line">+${fmtU(r.accrued)} ${unitSuffix()} accrued</div>`;
      if (r.used)    html += `<div class="t-line">&minus;${fmtU(r.used)} ${unitSuffix()} PTOB used</div>`;
      if (r.nrUsed)  html += `<div class="t-line nr">&minus;${fmtU(r.nrUsed)} ${unitSuffix()} parental used</div>`;
      if (r.nrRemaining !== null && r.nrRemaining !== undefined)
        html += `<div class="t-line nr">parental left: ${fmtU(r.nrRemaining)} ${unitSuffix()}</div>`;
      for (const [lbl, h] of periodLabels(r))
        html += `<div class="t-line">&bull; ${esc(lbl)}: ${fmtU(h)} ${unitSuffix()}</div>`;
      if (r.lost)    html += `<div class="t-line lost">&#9888; ${fmtU(r.lost)} ${unitSuffix()} lost to cap</div>`;
      if (r.overdrawn) html += `<div class="t-line od">&#9888; overdrawn</div>`;
      tip.innerHTML = html;
      tip.style.display = "block";
      const bw = box.clientWidth;
      const anchorY = +el.getAttribute("cy");   // hovered point (green or pink)
      tip.style.left = Math.min(px + 14, bw - tip.offsetWidth - 4) + "px";
      tip.style.top = Math.max(anchorY - tip.offsetHeight - 12, 0) + "px";
    });
    el.addEventListener("mouseleave", () => {
      tip.style.display = "none";
      xhair.setAttribute("visibility", "hidden");
    });
    el.addEventListener("click", () => {
      // jump the calendar to this period Sunday
      const r = rows[+el.dataset.i];
      const dt = parseISO(r.date);
      viewYear = dt.getUTCFullYear();
      viewMonth = dt.getUTCMonth();
      selection = new Set([r.date]);
      renderCalendar();
    });
  }
}

/* ------------------------------------------------ wiring */
function renderHire() {
  $("hireDate").value = STATE.hireDate;
  $("birthDate").value = STATE.birthDate || "";
  let info = "9-year mark " + fmtDate(STATE.nineYearDate) +
      ": accrual 6.7692 → 8.000 h/period, cap 240 → 320 h";
  info += STATE.birthDate
      ? " · parental leave: 480 h from " + fmtDate(STATE.birthDate) +
        " until " + fmtDate(STATE.parentalExpiry)
      : " · set a birth date to enable parental leave";
  $("hireInfo").textContent = info;
}

async function refresh() {
  await fetchState();
  renderTiles();
  renderCalendar();
  renderChart();
  renderHire();
}

document.addEventListener("pointerup", () => {
  clearTimeout(longPressTimer);
  if (!dragging) return;
  dragging = false;
  if (suppressOpen) { suppressOpen = false; return; }
  openEditor();
});
document.addEventListener("pointercancel", () => {
  clearTimeout(longPressTimer);
  dragging = false;
});
$("calGrid").addEventListener("contextmenu", e => {
  if (lastPointerType === "touch") e.preventDefault();
});
window.addEventListener("resize", () => STATE && renderChart());
$("horizon").addEventListener("change", () => { renderTiles(); renderChart(); });
$("prev").addEventListener("click", () => {
  viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; } renderCalendar();
});
$("next").addEventListener("click", () => {
  viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; } renderCalendar();
});
$("todayBtn").addEventListener("click", () => {
  const t = parseISO(STATE.today);
  viewYear = t.getUTCFullYear(); viewMonth = t.getUTCMonth(); renderCalendar();
});
$("edSaveB").addEventListener("click", () => saveLeave("B"));
$("edSaveNR").addEventListener("click", () => saveLeave("NR"));
$("edClear").addEventListener("click", clearDays);
$("edHours").addEventListener("keydown", e => {
  if (e.key === "Enter") saveLeave("B");
});
$("edLabel").addEventListener("keydown", e => {
  if (e.key === "Enter") saveLeave("B");
});
$("edHoliday").addEventListener("click", () => setHoliday(false));
$("edUnholiday").addEventListener("click", () => setHoliday(true));
$("themeBtn").addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = cur;
  localStorage.setItem("ptoTheme", cur);
});
function updateUnitsBtn() {
  $("unitsBtn").textContent = UNITS === "h" ? "Units: hours" : "Units: days";
}
$("unitsBtn").addEventListener("click", () => {
  UNITS = UNITS === "h" ? "d" : "h";
  localStorage.setItem("ptoUnits", UNITS);
  updateUnitsBtn();
  renderTiles(); renderCalendar(); renderChart();
});
updateUnitsBtn();
if (IS_STATIC) {
  $("saveBtn").style.display = "none";
} else {
  $("saveBtn").addEventListener("click", () => { window.location = "/export"; });
}
$("hireDate").addEventListener("change", async () => {
  const v = $("hireDate").value;
  if (!v) { renderHire(); return; }
  const out = await post("/api/hiredate", {date: v});
  if (out && out.ok) await refresh(); else renderHire();
});
$("birthDate").addEventListener("change", async () => {
  const out = await post("/api/birthdate", {date: $("birthDate").value});
  if (out && out.ok) await refresh(); else renderHire();
});
$("birthClear").addEventListener("click", async () => {
  const out = await post("/api/birthdate", {date: ""});
  if (out && out.ok) await refresh();
});

(async () => {
  await fetchState();
  const t = parseISO(STATE.today);
  viewYear = t.getUTCFullYear(); viewMonth = t.getUTCMonth();
  renderTiles(); renderCalendar(); renderChart(); renderHire();
})();
</script>
</body>
</html>
"""


def main():
    ap = argparse.ArgumentParser(description="Leave planner (PTOB + parental)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true",
                    help="don't open a browser window")
    args = ap.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://localhost:{args.port}"
    print(f"Leave planner running at {url}  (Ctrl+C to stop)")
    print(f"Data file: {DATA_FILE}")
    if not args.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
