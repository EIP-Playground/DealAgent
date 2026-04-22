import { handleCatalog } from "./catalog.js";
import { handleCrm } from "./crm.js";
import { handleInventory } from "./inventory.js";
import { handleOnboarding } from "./onboarding.js";
import { handleOrders } from "./orders.js";
import { handlePayments } from "./payments.js";
import { handleSellerBi } from "./seller_bi.js";

export type SkillHandler = (
  context: Record<string, unknown>,
) => Record<string, unknown>;

const HANDLERS: Record<string, SkillHandler> = {
  catalog: handleCatalog,
  crm: handleCrm,
  inventory: handleInventory,
  onboarding: handleOnboarding,
  orders: handleOrders,
  payments: handlePayments,
  "seller-bi": handleSellerBi,
};

export function availableSkills(): string[] {
  return Object.keys(HANDLERS).sort();
}

export function dispatchSkill(
  skillName: string,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const handler = HANDLERS[skillName];
  if (!handler) {
    throw new Error(`Unsupported skill: ${skillName}`);
  }
  return handler(context);
}
