"""Verschiebt LOCOMO (3 Gespraeche) und LongMemEval-oracle (100 Fragen, nach Typ
geschichtet) um ganze Jahre ins Jahr 2026, damit kein mehrjaehriger Decay wirkt.
Jahreszahlen 2015-2025 in Dialog, Frage und Musterantwort werden mit demselben
Versatz verschoben; Wochentage in LME-Datumsangaben werden neu berechnet."""
import json, re, datetime, collections
TODAY = datetime.date(2026, 11, 23)
YEAR = re.compile(r'\b(20(1[5-9]|2[0-5]))\b')
def shift_text(s, d):
    return YEAR.sub(lambda m: str(int(m.group(1)) + d), s) if isinstance(s, str) else s
def deep(o, d):
    if isinstance(o, str): return shift_text(o, d)
    if isinstance(o, list): return [deep(x, d) for x in o]
    if isinstance(o, dict): return {k: (v if k in ('dia_id','question_id','sample_id','img_url','haystack_session_ids','answer_session_ids') else deep(v, d)) for k, v in o.items()}
    return o
# LOCOMO
loc = json.load(open('locomo10.orig.json'))
pick = ['conv-44', 'conv-47', 'conv-50']
def conv_shift(c):
    conv = c['conversation']
    last = max(datetime.datetime.strptime(conv[k].split(' on ')[1], '%d %B, %Y').date() for k in conv if k.endswith('_date_time'))
    d = 2026 - last.year
    return d if last.replace(year=last.year + d) <= TODAY else d - 1
out = []
for c in loc:
    if c['sample_id'] in pick:
        d = conv_shift(c); n = deep(c, d); n['_yearShift'] = d; out.append(n)
for c in out:
    conv = c['conversation']
    for k in [k for k in conv if k.endswith('_date_time')]:
        d = datetime.datetime.strptime(conv[k].split(' on ')[1], '%d %B, %Y').date()
        assert d <= TODAY, (c['sample_id'], conv[k])
json.dump(out, open('locomo10.json', 'w'), ensure_ascii=False)
print('locomo', [(c['sample_id'], c['_yearShift'], len(c['qa'])) for c in out])
# LongMemEval
lme = json.load(open('longmemeval_oracle.orig.json'))
quota = {'temporal-reasoning': 27, 'multi-session': 27, 'knowledge-update': 16, 'single-session-user': 14, 'single-session-assistant': 10, 'single-session-preference': 6}
taken = collections.Counter(); sel = []
for it in lme:
    t = it['question_type']
    if taken[t] < quota[t]: taken[t] += 1; sel.append(it)
LMED = re.compile(r'^(\d{4})/(\d{2})/(\d{2}) \(\w{3}\) (\d{2}:\d{2})$')
def lme_date(s, d):
    y, mo, da, hm = LMED.match(s).groups()
    nd = datetime.date(int(y) + d, int(mo), min(int(da), 28) if (mo == '02' and da == '29') else int(da))
    return nd, f"{nd:%Y/%m/%d} ({nd:%a}) {hm}"
res = []
for it in sel:
    qd = LMED.match(it['question_date']).groups()
    d = 2026 - int(qd[0])
    if datetime.date(2026, int(qd[1]), int(qd[2])) > TODAY: d -= 1
    n = deep(it, d)
    nd, n['question_date'] = lme_date(it['question_date'], d)
    n['haystack_dates'] = [lme_date(x, d)[1] for x in it['haystack_dates']]
    assert nd <= TODAY
    n['_yearShift'] = d
    res.append(n)
json.dump(res, open('longmemeval_oracle.json', 'w'), ensure_ascii=False)
print('lme', len(res), dict(taken), 'shifts', collections.Counter(x['_yearShift'] for x in res))
print('sample', res[0]['question_date'], res[0]['haystack_dates'][:2], '|', res[0]['answer'])
