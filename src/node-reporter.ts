export default async function* reporter(
  events: AsyncIterable<unknown>,
): AsyncGenerator<string> {
  for await (const event of events) {
    yield `${JSON.stringify(event, (_key: string, value: unknown) =>
      value instanceof Error
        ? {
            name: value.name,
            message: value.message,
            stack: value.stack,
            ...("code" in value && typeof value.code === "string"
              ? { code: value.code }
              : {}),
            ...("failureType" in value && typeof value.failureType === "string"
              ? { failureType: value.failureType }
              : {}),
            ...(value.cause instanceof Error
              ? {
                  cause: {
                    name: value.cause.name,
                    ...("code" in value.cause &&
                    typeof value.cause.code === "string"
                      ? { code: value.cause.code }
                      : {}),
                  },
                }
              : {}),
          }
        : value,
    )}\n`;
  }
}
