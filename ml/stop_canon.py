"""
Agency-aware stop-name canonicalization for the Python ML code.

Mirrors functions/lib/ml_utils.js canonicalizeStop() (ML features and labels) and
functions/lib/predict_v3.js _canonicalizeStop() (grading, as finalization.js grades). Both pick the
first stops-library entry at the trip's agency, and fall back to the first entry at any agency when
the agency is unknown or has no stop by that name. Without the agency step, LA Metro's "Union Station
Patsaouras Bus Plaza" (alias "Union Station") captured TTC/GO Union Station trips (GitHub #405).

Agency aliases are read from js/shared/agency-aliases.js, the one list the web app and the Cloud
Functions share, so this file never drifts from it.
"""

import os
import re

_ALIASES_JS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "js", "shared", "agency-aliases.js")


def _load_agency_aliases(path=_ALIASES_JS):
    with open(path, encoding="utf-8") as f:
        src = f.read()
    body = src[src.index("AGENCY_ALIASES = {"):]
    body = body[:body.index("};")]
    aliases = dict(re.findall(r"^\s*'([^']+)'\s*:\s*'([^']+)'", body, re.M))
    if not aliases:
        raise RuntimeError(f"no agency aliases found in {path}")
    return aliases


AGENCY_ALIASES = _load_agency_aliases()


def canonical_agency(name):
    """agency-aliases.js canonicalAgency(): canonical stored name, else the trimmed input."""
    if name is None:
        return name
    trimmed = str(name).strip()
    return AGENCY_ALIASES.get(trimmed.lower(), trimmed)


def agency_key(agency):
    return canonical_agency(agency).lower()


def _present(v):
    """Truthy and not a pandas NaN."""
    return bool(v) and not (isinstance(v, float) and v != v)


def ml_norm(s):
    """ml_utils.js canonicalizeStop's string steps."""
    s = str(s).strip().lower()
    s = re.sub(r"\s+and\s+", "/", s)
    s = re.sub(r"\s*[/&@]\s*", "/", s)
    return re.sub(r"\s+at\s+", "/", s)


def v3_norm(s):
    """predict_v3.js _normStopName (no " and " step)."""
    s = str(s).strip().lower()
    s = re.sub(r"\s*[/&@]\s*", "/", s)
    return re.sub(r"\s+at\s+", "/", s)


class StopIndex:
    """Normalized name/alias -> [(canonical, agency keys)] in library order."""

    def __init__(self, lib, norm):
        self.norm = norm
        self.index = {}
        for s in lib or []:
            name = s.get("name") if s else None
            if not name:
                continue
            agencies = {agency_key(a) for a in [s.get("agency"), *(s.get("agencies") or [])] if _present(a)}
            entry = (norm(name), agencies)
            seen = set()
            for c in [name, *(s.get("aliases") or [])]:
                if not c:
                    continue
                key = norm(c)
                if key in seen:
                    continue
                seen.add(key)
                self.index.setdefault(key, []).append(entry)
        self._cache = {}

    def canon(self, name, agency=None):
        """Canonical form of a name; None/empty names are the caller's business."""
        ck = (name, agency if _present(agency) else None)
        hit = self._cache.get(ck)
        if hit is not None:
            return hit
        key = self.norm(name)
        entries = self.index.get(key)
        out = key
        if entries:
            out = entries[0][0]
            if _present(agency):
                want = agency_key(agency)
                for canonical, agencies in entries:
                    if want in agencies:
                        out = canonical
                        break
        self._cache[ck] = out
        return out


_ML_INDEX = {}


def ml_index(lib):
    """StopIndex(lib, ml_norm), cached per library object (the library is never mutated in place)."""
    hit = _ML_INDEX.get(id(lib))
    if hit is None or hit[0] is not lib:
        hit = (lib, StopIndex(lib, ml_norm))
        _ML_INDEX[id(lib)] = hit
    return hit[1]
