"""
Route Normalization for ML / Analytics

This module provides a per-agency configurable system for normalizing route labels.

The goal is to remove hard-coded TTC assumptions from the normalization logic
and allow different agencies to have different normalization rules.

Core idea:
- Raw route text in trips is never mutated.
- A normalized version is derived for training and analytics.
- Normalization behavior is controlled by registering policies per agency.

Public API:
    normalize_route_for_ml(route, agency=None, primary_agency=None)
    register_policy(agency, policy)
    configure_policies(policy_dict)
    configure_from_dict(name_dict)
    load_policies_from_file(path)
    load_policies()                    # Recommended: auto-loads policies.json/yaml if present

Recommended usage:
    from ml.route_normalization import load_policies, normalize_route_for_ml

    load_policies()   # Looks for policies.json / policies.yaml next to this module,
                      # or falls back to sensible defaults.

    normalized = normalize_route_for_ml("506a", agency="TTC")

    # When you have the user's current primary agency (derived from recent trips):
    normalized = normalize_route_for_ml("506a", agency="TTC", primary_agency=user_default_agency)

See ml/policies.example.json for a documented starter configuration (use "PRIMARY" for the user's current default agency derived from recent trips).
    normalized = normalize_route_for_ml("18c", agency="MiWay")  # -> "18C"
"""

import json
import os
import re
from dataclasses import dataclass
from typing import Protocol


class RouteNormalizationPolicy(Protocol):
    """Interface for a route normalization policy."""

    def normalize(self, route: str) -> str:
        """Return the normalized version of the route string."""
        ...


# --------------------------------------------------------------------------- #
# Built-in Policies
# --------------------------------------------------------------------------- #

@dataclass
class TTCCollapsePolicy:
    """
    TTC-specific policy: aggressively collapse variants to the base route number.

    Examples:
        506, 506a, 506B, 506 West → "506"
    """

    def normalize(self, route: str) -> str:
        route_str = str(route).strip()
        match = re.match(r"^(\d+)", route_str)
        return match.group(1) if match else route_str


@dataclass
class DefaultPreservePolicy:
    """
    Default policy for most agencies.

    Only does light normalization:
    - Uppercases trailing letters (18c → 18C)
    - Uppercases single-letter routes (k → K)
    """

    def normalize(self, route: str) -> str:
        route_str = str(route).strip()

        compact = re.match(r"^(\d+)([a-zA-Z]+)$", route_str)
        if compact:
            return f"{compact.group(1)}{compact.group(2).upper()}"

        if re.match(r"^[A-Za-z]$", route_str):
            return route_str.upper()

        return route_str


@dataclass
class StrictPreservePolicy:
    """
    Very minimal normalization — only strips whitespace and uppercases
    single-letter routes. Almost everything else is left as-is.
    """

    def normalize(self, route: str) -> str:
        route_str = str(route).strip()
        if re.match(r"^[A-Za-z]$", route_str):
            return route_str.upper()
        return route_str


@dataclass
class UpperPolicy:
    """Simple policy that uppercases the entire route after basic cleaning."""

    def normalize(self, route: str) -> str:
        route_str = str(route).strip()
        # Still do basic compact normalization first
        compact = re.match(r"^(\d+)([a-zA-Z]+)$", route_str)
        if compact:
            route_str = f"{compact.group(1)}{compact.group(2).upper()}"
        return route_str.upper()


# --------------------------------------------------------------------------- #
# Registry + Configuration
# --------------------------------------------------------------------------- #

_POLICY_REGISTRY: dict[str, RouteNormalizationPolicy] = {}

_default_policy: RouteNormalizationPolicy = DefaultPreservePolicy()


def agency_id(agency: str | None) -> str | None:
    """Return a stable, display-name-independent agency key."""
    if agency is None:
        return None
    value = re.sub(r"[^a-z0-9]+", "_", str(agency).strip().lower()).strip("_")
    return value or None


def scoped_route_key(route: str | None, agency: str | None, primary_agency: str | None = None) -> str | None:
    """Return the model identity for a route without cross-agency collisions."""
    normalized = normalize_route_for_ml(route, agency, primary_agency)
    key = agency_id(agency)
    if normalized is None or not key:
        return None
    return f"{key}::{normalized}"


_POLICY_NAME_TO_CLASS: dict[str, type[RouteNormalizationPolicy]] = {
    "collapse": TTCCollapsePolicy,
    "preserve_variant": DefaultPreservePolicy,
    "strict_preserve": StrictPreservePolicy,
    "upper": UpperPolicy,
}


def register_policy(agency: str, policy: RouteNormalizationPolicy) -> None:
    """Register or override the normalization policy for a specific agency."""
    _POLICY_REGISTRY[agency] = policy


def configure_policies(policies: dict[str, RouteNormalizationPolicy]) -> None:
    """
    Replace or extend the current policy registry.

    Use this when you have actual policy instances (e.g. at application startup).
    """
    _POLICY_REGISTRY.update(policies)


def configure_from_dict(config: dict[str, str]) -> None:
    """
    Configure policies using simple string names.

    This is the recommended way to configure normalization from code or config.

    Example (caller supplies whatever agencies it cares about):
        {
            "MyAgency": "collapse",
            "DEFAULT": "preserve_variant"
        }
    """
    global _default_policy

    policies: dict[str, RouteNormalizationPolicy] = {}

    for agency, policy_name in config.items():
        policy_cls = _POLICY_NAME_TO_CLASS.get(policy_name.lower())
        if policy_cls is None:
            valid = ", ".join(sorted(_POLICY_NAME_TO_CLASS.keys()))
            raise ValueError(f"Unknown policy name: {policy_name!r}. Valid options: {valid}")

        policy_instance = policy_cls()

        if agency.upper() == "DEFAULT":
            _default_policy = policy_instance
        else:
            policies[agency] = policy_instance

    if policies:
        configure_policies(policies)


def load_policies_from_file(path: str) -> None:
    """
    Load policy configuration from a JSON or YAML file and apply it.

    Supported formats:
    - .json
    - .yaml / .yml (requires PyYAML)

    The file should contain a mapping of agency -> policy name.
    """
    import os

    ext = os.path.splitext(path)[1].lower()

    with open(path, "r") as f:
        if ext in (".yaml", ".yml"):
            try:
                import yaml  # type: ignore
            except ImportError:
                raise ImportError(
                    "PyYAML is required to load .yaml/.yml files. "
                    "Install it with: pip install pyyaml"
                )
            config = yaml.safe_load(f)
        else:
            config = json.load(f)

    if not isinstance(config, dict):
        raise ValueError(f"Config file must contain a mapping, got {type(config)}")

    configure_from_dict(config)


def load_policies(config_path: str | None = None) -> None:
    """
    Convenience helper to load policies.

    - If `config_path` is given, loads from that file.
    - Otherwise looks for `policies.json`, `policies.yaml`, or `policies.yml`
      next to this module.
    - Falls back to the built-in default configuration if no file is found.
    """
    import os

    if config_path:
        load_policies_from_file(config_path)
        return

    base_dir = os.path.dirname(__file__)
    for name in ["policies.json", "policies.yaml", "policies.yml"]:
        full_path = os.path.join(base_dir, name)
        if os.path.exists(full_path):
            load_policies_from_file(full_path)
            return

    # No config file found — use sensible defaults
    configure_from_dict(get_default_config())


def get_policy_for_agency(agency: str | None, primary_agency: str | None = None) -> RouteNormalizationPolicy:
    """
    Internal helper used by normalize_route_for_ml.

    If `primary_agency` is provided and `agency` matches it, the policy
    registered under the special key "PRIMARY" (if present) will be used.
    This allows the collapse (or other) policy to follow the user's current
    dynamically determined primary/default agency (based on recent trips)
    without hardcoding any specific agency strings in config.
    """
    if not agency:
        return _default_policy

    agency_str = str(agency).strip()
    primary_str = str(primary_agency).strip() if primary_agency else None

    if primary_str and agency_str == primary_str:
        if "PRIMARY" in _POLICY_REGISTRY:
            return _POLICY_REGISTRY["PRIMARY"]

    return _POLICY_REGISTRY.get(agency_str, _default_policy)


def list_available_policies() -> list[str]:
    """Return the list of valid policy names usable with configure_from_dict / load_policies_from_file."""
    return sorted(_POLICY_NAME_TO_CLASS.keys())


def reset_policies() -> None:
    """Reset the policy registry and default policy to a clean neutral state."""
    global _default_policy
    _POLICY_REGISTRY.clear()
    _default_policy = DefaultPreservePolicy()


def get_default_config() -> dict[str, str]:
    """
    Return the baseline configuration used when no policies file is supplied.
    Only the universal DEFAULT policy is defined here; every agency receives
    this behavior unless the caller explicitly configures otherwise.
    """
    return {
        "DEFAULT": "preserve_variant",
    }


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #

def normalize_route_for_ml(route, agency=None, primary_agency=None):
    """
    Normalize route labels for training and analytics.

    This function does NOT modify the original route string stored in trips.

    Args:
        route: The raw route string from a trip.
        agency: The agency the route belongs to.
        primary_agency: Optional. The user's current primary/default agency
            (typically computed from their most recent trips). When provided
            and matching `agency`, the special "PRIMARY" policy from config
            (if present) is used. This lets the collapse behavior follow the
            dynamically determined primary agency without hardcoding names.

    Returns:
        A normalized string suitable for use as a feature or label.
    """
    if route is None:
        return route

    route_str = str(route).strip()
    if not route_str:
        return route_str

    policy = get_policy_for_agency(agency, primary_agency)
    return policy.normalize(route_str)
