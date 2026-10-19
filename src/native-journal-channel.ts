import {
  NativeAttemptWriter,
  type NativeJournalContext,
} from "./native-attempt-storage.js";
export const nativeJournalEnvironmentName = "CHECKTRAIL_NATIVE_JOURNAL_CONTEXT";
let writer: NativeAttemptWriter | undefined;
let initialized = false;
let initializationFailure: Error | undefined;
/** Strip the exact reserved identifier, including Windows case aliases. */
export function withoutNativeJournalContext(
  input: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([key]) => key.toUpperCase() !== nativeJournalEnvironmentName,
    ),
  );
}
export function nativeJournalContextEnvironment(
  context: NativeJournalContext,
): Record<string, string> {
  return { [nativeJournalEnvironmentName]: JSON.stringify(context) };
}
/** One held writer per wrapper process. This is an evidence channel, never trust. */
export function currentNativeJournalWriter(): NativeAttemptWriter | undefined {
  if (initializationFailure) throw initializationFailure;
  if (initialized) return writer;
  const values = Object.entries(process.env).filter(
    ([key]) => key.toUpperCase() === nativeJournalEnvironmentName,
  );
  for (const [key] of values) delete process.env[key];
  if (values.length === 0) {
    initialized = true;
    return undefined;
  }
  initialized = true;
  let opened: NativeAttemptWriter;
  try {
    if (
      values.length !== 1 ||
      typeof values[0]![1] !== "string" ||
      values[0]![1]!.length > 4096
    )
      throw Error("Native journal context unavailable");
    opened = new NativeAttemptWriter(JSON.parse(values[0]![1]!));
  } catch {
    initializationFailure = Error("Native journal context unavailable");
    throw initializationFailure;
  }
  writer = opened;
  process.once("exit", () => {
    try {
      opened.close();
    } catch {
      /* Missing end remains incomplete to the collector. */
    }
  });
  return writer;
}
