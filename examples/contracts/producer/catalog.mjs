export function catalog() {
  return {
    items: [
      { id: "book", quantity: 2 },
      { id: "pen", quantity: 0 },
    ],
  };
}

export function legacyCatalog() {
  return { items: [{ id: "book", quantity: "2" }] };
}
