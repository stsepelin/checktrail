import type { ContractBundle } from "../src/contract-schema.js";
export function contractFixture(): ContractBundle {
  return {
    schemaVersion: 1,
    format: "contract-samples",
    capturedAt: "2026-09-18T00:00:00.000Z",
    contracts: [
      {
        id: "catalog-response",
        producer: { name: "catalog-api", sourceFingerprint: "a".repeat(64) },
        consumer: { name: "catalog-web", sourceFingerprint: "b".repeat(64) },
        complete: true,
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          required: ["items"],
          additionalProperties: false,
          properties: {
            items: {
              type: "array",
              minItems: 1,
              items: { $ref: "#/$defs/item" },
            },
          },
          $defs: {
            item: {
              type: "object",
              required: ["id", "quantity"],
              additionalProperties: false,
              properties: {
                id: { type: "string", minLength: 1 },
                quantity: { type: "integer", minimum: 0 },
              },
            },
          },
        },
        samples: [
          {
            name: "two-items",
            payload: {
              items: [
                { id: "book", quantity: 2 },
                { id: "pen", quantity: 0 },
              ],
            },
          },
        ],
      },
    ],
  };
}
