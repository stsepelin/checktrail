import { item } from "@synthetic/catalog-domain";

export function quantityLabel(quantity: number): string {
  return item(quantity).quantity.toFixed(0);
}
