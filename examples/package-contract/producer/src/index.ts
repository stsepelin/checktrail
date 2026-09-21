export interface CatalogItem {
  quantity: number;
}

export function item(quantity: number): CatalogItem {
  return { quantity };
}
