"""Shared skill dispatch helpers used by both prod and local test entrypoints.

This module keeps the mapping from skill names to Python handler functions so
CLI entrypoints stay thin and consistent.
"""

from __future__ import annotations

from typing import Any, Callable

from scripts.lib.catalog import handle_catalog
from scripts.lib.crm import handle_crm
from scripts.lib.inventory import handle_inventory
from scripts.lib.onboarding import handle_onboarding
from scripts.lib.orders import handle_orders
from scripts.lib.payments import handle_payments
from scripts.lib.seller_bi import handle_seller_bi


SkillHandler = Callable[[dict[str, Any]], dict[str, Any]]

HANDLERS: dict[str, SkillHandler] = {
    "catalog": handle_catalog,
    "crm": handle_crm,
    "inventory": handle_inventory,
    "onboarding": handle_onboarding,
    "orders": handle_orders,
    "payments": handle_payments,
    "seller-bi": handle_seller_bi,
}


def available_skills() -> list[str]:
    """Return the sorted list of registered skill names.

    Args:
        None.

    Returns:
        List of CLI-safe skill names that entrypoint scripts can expose.
    """
    return sorted(HANDLERS)


def dispatch_skill(skill_name: str, context: dict[str, Any]) -> dict[str, Any]:
    """Resolve a registered skill handler and execute it with normalized context.

    Args:
        skill_name: Registered skill key, for example `onboarding`.
        context: Host-normalized payload passed to the selected skill.

    Returns:
        JSON-serializable result returned by the chosen skill handler.

    Raises:
        ValueError: If the skill name is not registered in `HANDLERS`.
    """
    try:
        handler = HANDLERS[skill_name]
    except KeyError as exc:
        raise ValueError(f"Unsupported skill: {skill_name}") from exc
    return handler(context)
