"""Deterministic confidentiality rules for native PLUR1BUS memory outputs."""
from __future__ import annotations

import re
from unicodedata import normalize

SENSITIVITY_LEVELS = ("banal", "personal", "confidential")
_CONFIDENTIAL = (
    re.compile(r'\b(?:krankheit\w*|krankenhaus\w*|krankschreibung\w*|krankgeschrieben|diagnose\w*|diagnostiziert|therapie\w*|therapeut\w*|psychiat\w*|psycholog\w*|depression\w*|depressiv\w*|angststörung\w*|panikattacke\w*|burn-?out|medikament\w*|antidepressiv\w*|arzttermin\w*|ärztin|hausarzt|hausärzt\w*|facharzt|op-termin|krebs|tumor\w*|chemo\w*|schwanger\w*|fehlgeburt|abtreibung|suchtkrank\w*|abhängigkeit|alkoholiker\w*|entzugsklinik|blutdruck|diabetes|diabetiker\w*|schmerzmittel|befund\w*|reha-?klinik|psychose|suizid\w*|selbstmord\w*)\b', re.I),
    re.compile(r'\b(?:illness|diagnos(?:is|ed)|therapist|therapy|psychiatr\w*|depression|depressed|anxiety disorder|panic attack|medication|prescription|hospitali[sz]ed|surgery|cancer|tumou?r|chemotherapy|pregnan\w*|miscarriage|abortion|addiction|rehab|suicid\w*|self-harm)\b', re.I),
    re.compile(r'\b(?:gehalt|einkommen|kontostand|schulden|kredit|kredite|darlehen|hypothek|insolvenz|pleite|steuererklärung|steuernachzahlung|steuerschulden|steuerbescheid|finanzamt|mahnung\w*|inkasso|pfändung\w*|bafög|bürgergeld|hartz|unterhalt|unterhaltszahlung\w*|erbschaft|kontonummer)\b', re.I),
    re.compile(r'\b(?:salary|bank balance|debts?|loan|mortgage|bankrupt\w*|tax return|tax debt|collection agency|alimony|inheritance|account number)\b', re.I),
    re.compile(r'\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b'),
    re.compile(r'\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}\b'),
    re.compile(r'\b(?:affäre|fremdgegangen|fremdgehen|betrogen|trennung|scheidung|geschieden|liebeskummer|sex|sexuell\w*|intim\w*|beziehungskrise|eifersucht|eifersüchtig|ehekrise|seitensprung|schluss gemacht)\b', re.I),
    re.compile(r'\b(?:affair|cheated|cheating|breakup|break-up|divorce[ds]?|sexual\w*|sex life|intimate|jealous\w*|marriage crisis)\b', re.I),
    re.compile(r'\bstreit mit (?:meine[mnr]?|der|dem|den) (?:mutter|vater|eltern|bruder|schwester|sohn|tochter|familie|mann|frau|ex)\b', re.I),
    re.compile(r'\b(?:familienstreit|kontaktabbruch|sorgerecht|jugendamt|enterbt|häusliche gewalt|misshandl\w*|missbrauch\w*)\b', re.I),
    re.compile(r'\b(?:custody battle|child protective|domestic violence|abused|estranged from)\b', re.I),
    re.compile(r'\b(?:passwort|kennwort|password|passcode|pin|geheimzahl|zugangsdaten|login|api[- ]?key|token|secret)\s*(?:ist|lautet|is|:|=)\s*\S{4,}', re.I),
    re.compile(r'\b(?:sk|pk|ghp|gho|xox[bp])[-_][A-Za-z0-9]{16,}\b'),
    re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----'),
    re.compile(r'\b(?:seed phrase|recovery code|wiederherstellungscode)\b', re.I),
    re.compile(r'\b[A-ZÄÖÜ](?:[^\W\d_]|[.-])+(?:straße|strasse|str\.|weg|gasse|allee|platz|ring|damm)\s+\d+[a-z]?\b'),
    re.compile(r'\b(?:wohnadresse|meine adresse|ich wohne in der|home address)\b', re.I),
    re.compile(r'\b(?:geburtsdatum|ausweisnummer|personalausweisnummer|reisepassnummer|sozialversicherungsnummer|steuer-?id|social security number|passport number)\b', re.I),
    re.compile(r'\b(?:anwalt|anwältin|rechtsanwalt|rechtsanwältin|klage|klagen|verklagt|verklagen|vor gericht|gerichtstermin|amtsgericht|landgericht|arbeitsgericht|familiengericht|strafanzeige|anzeige erstattet|vorstrafe\w*|bewährung|staatsanwalt\w*|abmahnung\w*|kündigungsschutz\w*|aufhebungsvertrag)\b', re.I),
    re.compile(r'\b(?:lawyer|attorney|lawsuit|sued|court hearing|criminal record|probation|prosecutor|police report)\b', re.I),
)
_PERSONAL = (
    re.compile(r'\b(?:ich|mein(?:e[mnrs]?)?|mir|mich|wir|unser(?:e[mnrs]?)?)\b', re.I),
    re.compile(r'\b(?:i|my|me|we|our)\b', re.I),
    re.compile(r'\b(?:mama|papa|mutter|vater|bruder|schwester|kinder?|sohn|tochter|freundin|freund|frau|mann|oma|opa|familie|mother|father|brother|sister|kids?|son|daughter|girlfriend|boyfriend|wife|husband|family)\b', re.I),
    re.compile(r'\b(?:gefühl\w*|müde|traurig|glücklich|gestresst|urlaub|abendessen|frühstück|geburtstag|hobby|zuhause|wohnung|feeling|tired|sad|happy|stressed|vacation|dinner|breakfast|birthday|at home)\b', re.I),
)


def classify_sensitivity(text: str) -> str:
    """Classify memory text without requesting a model or writing state."""
    text = normalize("NFC", text)
    if any(pattern.search(text) for pattern in _CONFIDENTIAL):
        return "confidential"
    return "personal" if sum(bool(pattern.search(text)) for pattern in _PERSONAL) >= 2 else "banal"


def is_confidential(text: str, recorded: object = None) -> bool:
    """Respect a persisted verdict and retain the confidentiality rule floor."""
    return recorded == "confidential" or classify_sensitivity(text) == "confidential"
