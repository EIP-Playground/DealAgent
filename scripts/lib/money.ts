export const SUPPORTED_FIAT_CURRENCY_DECIMALS: Record<string, number> = {
  USD: 2,
  CNY: 2,
  JPY: 0,
  HKD: 2,
  SGD: 2,
  KRW: 0,
  EUR: 2,
};

export function normalizeCurrencyCode(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

export function validateSupportedCurrency(value: unknown): string {
  const currency = normalizeCurrencyCode(value);
  if (!currency) {
    throw new Error("params.currency is required");
  }
  if (!(currency in SUPPORTED_FIAT_CURRENCY_DECIMALS)) {
    const supported = Object.keys(SUPPORTED_FIAT_CURRENCY_DECIMALS).sort().join(", ");
    throw new Error(`Unsupported currency: ${currency}. Supported values: ${supported}`);
  }
  return currency;
}

export function currencyDecimalPlaces(currency: unknown): number {
  const normalized = validateSupportedCurrency(currency);
  return SUPPORTED_FIAT_CURRENCY_DECIMALS[normalized]!;
}

export function formatMinorAmount(amountMinor: unknown, currency: unknown): string {
  if (typeof amountMinor !== "number" || !Number.isInteger(amountMinor)) {
    throw new Error("amount_minor must be an integer");
  }
  if (amountMinor < 0) {
    throw new Error("amount_minor must be non-negative");
  }

  const normalized = validateSupportedCurrency(currency);
  const decimals = SUPPORTED_FIAT_CURRENCY_DECIMALS[normalized]!;
  if (decimals === 0) {
    return `${normalized} ${amountMinor}`;
  }

  const divisor = 10 ** decimals;
  const whole = Math.floor(amountMinor / divisor);
  const fraction = String(amountMinor % divisor).padStart(decimals, "0");
  return `${normalized} ${whole}.${fraction}`;
}
