import { kotlinNativeSource } from "./kotlin-native.js";
// Preserve the baseline observer. The opt-in cohort resolves Java symbols and
// observes Kotlin/script frontend participation; Java emission is a second task.
export const kotlinExtensionsNativeSource = kotlinNativeSource
  .replace(
    "for(String file:requested){if(sources.put(file,new Source(file))!=null)",
    'for(String file:requested){if(!file.endsWith(".kt")&&!file.endsWith(".kts"))continue;if(sources.put(file,new Source(file))!=null)',
  )
  .replace(
    "args.setDisableDefaultScriptingPlugin(true);args.setDisableStandardScript(true);",
    "args.setDisableDefaultScriptingPlugin(false);args.setDisableStandardScript(false);args.setAllowAnyScriptsInSourceRoots(true);",
  );
