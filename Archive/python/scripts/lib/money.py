"""Shared helpers for validating and formatting fiat money values.

Catalog and future commerce skills store prices as integer minor units plus a
currency code. This module centralizes the supported v1 fiat currencies and the
logic that turns stored integers into user-facing display strings.
"""

from __future__ import annotations

from decimal import Decimal


SUPPORTED_FIAT_CURRENCY_DECIMALS: dict[str, int] = {
    "USD": 2,
    "CNY": 2,
    "JPY": 0,
    "HKD": 2,
    "SGD": 2,
    "KRW": 0,
    "EUR": 2,
}


def normalize_currency_code(value: object) -> str:
    """Normalize a currency code into the uppercase 3-letter runtime form.

    Args:
        value: Raw currency value provided by a caller.

    Returns:
        Uppercase string form of the currency code. Empty input becomes `""`.
    """
    return str(value or "").strip().upper()


def validate_supported_currency(value: object) -> str:
    """Validate that a currency code is part of the v1 supported fiat list.

    Args:
        value: Raw currency value supplied by the caller.

    Returns:
        Normalized uppercase currency code when supported.

    Raises:
        ValueError: If the currency is empty or unsupported in v1.
    """
    currency = normalize_currency_code(value)
    if not currency:
        raise ValueError("params.currency is required")
    if currency not in SUPPORTED_FIAT_CURRENCY_DECIMALS:
        supported = ", ".join(sorted(SUPPORTED_FIAT_CURRENCY_DECIMALS))
        raise ValueError(f"Unsupported currency: {currency}. Supported values: {supported}")
    return currency


def currency_decimal_places(currency: object) -> int:
    """Return the configured decimal precision for a supported fiat currency.

    Args:
        currency: Currency code that should already be normalized or user input
            that can be normalized to a supported currency.

    Returns:
        Integer count of display decimal places.

    Raises:
        ValueError: If the currency is unsupported.
    """
    normalized = validate_supported_currency(currency)
    return SUPPORTED_FIAT_CURRENCY_DECIMALS[normalized]


def format_minor_amount(amount_minor: object, currency: object) -> str:
    """Convert an integer minor-unit amount into a stable display string.

    Args:
        amount_minor: Stored integer amount in currency minor units.
        currency: Fiat currency code used to interpret the stored integer.

    Returns:
        Human-readable string in the form `CODE amount`, for example
        `USD 19.99` or `JPY 1200`.

    Raises:
        ValueError: If the amount is not a non-negative integer or if the
            currency is unsupported.
    """
    if isinstance(amount_minor, bool) or not isinstance(amount_minor, int):
        raise ValueError("amount_minor must be an integer")
    if amount_minor < 0:
        raise ValueError("amount_minor must be non-negative")

    normalized = validate_supported_currency(currency)
    decimals = SUPPORTED_FIAT_CURRENCY_DECIMALS[normalized]
    if decimals == 0:
        return f"{normalized} {amount_minor}"

    divisor = Decimal(10) ** decimals
    display_value = Decimal(amount_minor) / divisor
    return f"{normalized} {display_value:.{decimals}f}"
