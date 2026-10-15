// Selected byte identities observed in the pinned Linux ARM64 runtime.
// These are component pins, not a whole container or license audit.
export const fantomasPackagePin = {
  url: "https://api.nuget.org/v3-flatcontainer/fantomas/8.0.7/fantomas.8.0.7.nupkg",
  version: "8.0.7",
  bytes: 7093840,
  sha256: "cbf317a4583d7547666195fcada160fff695a1a6f4a7062701b01ee75d5d8971",
} as const;
export const fsharpFormatterPins = [
  {
    file: "FSharp.Core.dll",
    bytes: 2396976,
    sha256: "4a626d62bb15815b6404567aa1bd37d9f2208e8e3c99c3c346d0efcfca72af6c",
  },
  {
    file: "Fantomas.Core.dll",
    bytes: 1951232,
    sha256: "69738cba70e9e820d399b28b7ffb284063cbe3082a295b8f081369b192c68fbc",
  },
  {
    file: "Fantomas.FCS.dll",
    bytes: 6706176,
    sha256: "0274b668420330d6633b9a41acdeaf2b774cddab6c03a23ab750e20863552ff4",
  },
] as const;
export const fsharpSdkPins = [
  {
    file: "dotnet",
    bytes: 72680,
    sha256: "223e3218077f4c3a59c0763f5ae40708645738a1294c67a6d830fb1789994621",
  },
  {
    file: "host/fxr/10.0.12/libhostfxr.so",
    bytes: 311304,
    sha256: "d617e6d801ecdf6ff7fe75115d3d65939573220dc68f8827a7d27bc863dd9be8",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/Microsoft.CSharp.dll",
    bytes: 18216,
    sha256: "ae0ecd8f42ea3efacc2612ade56f29feea9a123fce9faa455126ec9f4a4540cf",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/Microsoft.VisualBasic.Core.dll",
    bytes: 59216,
    sha256: "7a7e44d7ac1f870e0b7d8f3f7598cca79e35cab12e77c58ed46e9b6b3c78bcfb",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/Microsoft.VisualBasic.dll",
    bytes: 17192,
    sha256: "e192508adde6a758138a5a8e28998dccb64e7f45eaf30d8ab3564f87749028b1",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/Microsoft.Win32.Primitives.dll",
    bytes: 16168,
    sha256: "ab197dec717c52f5a72c8f2366c33e2fc5149bfa7cf49acd59bbfb563defcd05",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/Microsoft.Win32.Registry.dll",
    bytes: 21288,
    sha256: "e8eb7f780b9ceca6dae35e74a11fa85e26a1b8b4a7edd5237cccc6b63b4e4b7a",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.AppContext.dll",
    bytes: 15144,
    sha256: "d9dd9fa44e019f27172d6b2662e2b6038f48c270912ac8aae53d4d909da7e9be",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Buffers.dll",
    bytes: 15144,
    sha256: "a1a35f5524e2f831d08ca55f702fbddcb8c6dfecd264f0f563d81a1c8b8280bd",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Collections.Concurrent.dll",
    bytes: 27432,
    sha256: "27b446a401163baa325f9cd82f787dfd32d0e205011093e0ab3057e5da609555",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Collections.Immutable.dll",
    bytes: 75048,
    sha256: "d4145735395753187965a6f0a8bf6bb6f301563c4d4080249614b8487b0604ac",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Collections.NonGeneric.dll",
    bytes: 22864,
    sha256: "99adf08652a16e5af30797b98742851b94604aa44bab677ddc38c7826bd529a5",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Collections.Specialized.dll",
    bytes: 25896,
    sha256: "17ef2b9433a1f1e9fc956786067f8d60672437d3feb76af84175f2b3bee4ded1",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Collections.dll",
    bytes: 55080,
    sha256: "130fcdd915c3ff8d8279fefd9a198b784d37693f4c1e96d1f2cff3edc96b638d",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.ComponentModel.Annotations.dll",
    bytes: 31568,
    sha256: "43c467051feafaa27144cc672836f38108377439245833fc8d99de97d3667c37",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.ComponentModel.DataAnnotations.dll",
    bytes: 16720,
    sha256: "d40e8c7062e6b9ce11ba83eab3d26be0eec8066b99970ea88b8e87fb75f411bd",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.ComponentModel.EventBasedAsync.dll",
    bytes: 19240,
    sha256: "b96d6d2f159ee5e192b2406a0ec993c8ad470a847f2e7acd2aa92cbc0a4c6a58",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.ComponentModel.Primitives.dll",
    bytes: 25936,
    sha256: "09a575c38bd010f3131704e9294941ff9740a0ba70be0fd6ab8fa54c44dbfca7",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.ComponentModel.TypeConverter.dll",
    bytes: 104744,
    sha256: "98a3e34140052c828ab7bdb81040421616fa4e6356c27f7970df141ef5681b42",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.ComponentModel.dll",
    bytes: 15656,
    sha256: "8811e7cc4288c435f54b0350afbffcbb13f77618cf9c0d3436cad89a83d29b23",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Configuration.dll",
    bytes: 19240,
    sha256: "3952a72e1f18774f16952b46c20e80ed2bc601a06eca01f33fa924c738022a9c",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Console.dll",
    bytes: 26408,
    sha256: "783e5ea6d049218ec30316598654e031415f0d1ec6ce6932c2d1a9cbd97a77e0",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Core.dll",
    bytes: 23336,
    sha256: "ac23faf1b37fa49f1b117baad951a65609e799a6e669a6df06d3552677e0c086",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Data.Common.dll",
    bytes: 154448,
    sha256: "e563226dce5e8d2f1ecf24b13a37d8948e42208d7b93bc9812475074382f2303",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Data.DataSetExtensions.dll",
    bytes: 15656,
    sha256: "aeeae0755c8c7f6747765cdf82fa43182e320e97f2035e3a0a19f21905e6c113",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Data.dll",
    bytes: 23848,
    sha256: "8bee1d4675fee975b5454e7407827aa3c6d4a2e53b9efb40be5409ac50900edb",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Diagnostics.Contracts.dll",
    bytes: 19752,
    sha256: "4366ccd79a875fb64e38813a81bdf2f61915b4c838cb74572d87919c2e7dee41",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Diagnostics.Debug.dll",
    bytes: 15656,
    sha256: "8b160ffe7518588bf64e13c01c6dcb2ef504d64f38bbf0f198d31e7b698db92c",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Diagnostics.DiagnosticSource.dll",
    bytes: 43304,
    sha256: "6caa24c3fe3819a6f78aedb0e8f718a6bd83eab4d9a786c609a228e330557bb0",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Diagnostics.FileVersionInfo.dll",
    bytes: 16720,
    sha256: "ae73589f3288fc3648a718797361f0ab37606cc18667c8aaebea2787f62736a3",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Diagnostics.Process.dll",
    bytes: 31568,
    sha256: "cd121308cb25b34ebc2549d72da361e56a093b29ef5ab0a85870d13fb91de052",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Diagnostics.StackTrace.dll",
    bytes: 22824,
    sha256: "e287630abe5753b658e64e947616c8bc8291bcd27bfcadc745a33818a43ad30d",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Diagnostics.TextWriterTraceListener.dll",
    bytes: 17704,
    sha256: "2c567ad9a2efe67d171e0ab06d0c7035383508588cae62b3c3d08f579a064595",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Diagnostics.Tools.dll",
    bytes: 15144,
    sha256: "841c5e2b6c171fa9aaff0fc6295f3fbc93dc5dcab44118b62f1c942bb674aff2",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Diagnostics.TraceSource.dll",
    bytes: 27984,
    sha256: "ecfe5b354ea6b7bf3736d8c4b02ae322c766f2bccf260182632a492f3309d883",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Diagnostics.Tracing.dll",
    bytes: 28968,
    sha256: "e0f72905eb1b1cfd6db130e6b2f18424788769d79fae486054a242615d713a50",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Drawing.Primitives.dll",
    bytes: 35616,
    sha256: "8ffda23fafb73bdac7b6c8dfcac1c06894c729f65157e218980db9a4b74c7427",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Drawing.dll",
    bytes: 20304,
    sha256: "585a8da9952d715f8de7a7b1879b59d68ff8608b92f6ed1c5f0e1d251180d3c6",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Dynamic.Runtime.dll",
    bytes: 16168,
    sha256: "c0eac30c791db8c1a2b50b61c50d029f4ddd0eadfdd35433745001688a3e7466",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Formats.Asn1.dll",
    bytes: 26408,
    sha256: "c6f8cb70a20321ac4c93219ccb5264f50d21d7f7cdd0bd61c02360ff87cd38f4",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Formats.Tar.dll",
    bytes: 20264,
    sha256: "c6d0aa4d2e3ed3ab6c1949669d79bfc763fc9e7b04830ab7174d4cc55569757c",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Globalization.Calendars.dll",
    bytes: 15656,
    sha256: "e0f3f3f6e4acc7b6755782fed5cb075ecf70beee4fc5d404579ae99bc0883ef2",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Globalization.Extensions.dll",
    bytes: 15144,
    sha256: "be0390557cc72078a7217cf94fd44b9ab66aa30838c00a92aa78c62469c44aa0",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Globalization.dll",
    bytes: 15696,
    sha256: "66902cffd057673b4b77aa68faf80d33ffa4c94510e61db2a067943cc53b7702",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.IO.Compression.Brotli.dll",
    bytes: 18256,
    sha256: "1401375a39b7ba5e65e0b49274c0168b6c8b7e5455afefd269c1418fd019e997",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.IO.Compression.FileSystem.dll",
    bytes: 15184,
    sha256: "4aeec2c0189f73ba8122f05c0d759008ddae1a8873b167cc8a558d53f2af80e1",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.IO.Compression.ZipFile.dll",
    bytes: 18728,
    sha256: "c34ef5004f535f10adceb66b3f20f743b15656ed4c7dcf5946a8b83a6cdee329",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.IO.Compression.dll",
    bytes: 21800,
    sha256: "ac573888ba94e958243674d82e51e88692e5bea6fd94bb68d87d30c28cdaecf5",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.IO.FileSystem.AccessControl.dll",
    bytes: 20264,
    sha256: "38eb787fd20b30f36e207364387fd34a5c68207baffddf318986216f4b6cc6b1",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.IO.FileSystem.DriveInfo.dll",
    bytes: 17192,
    sha256: "5ce6349a752189b3bcaa553fef38f9c0cdd1fb2e39e7caba67c966f52ef66391",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.IO.FileSystem.Primitives.dll",
    bytes: 15144,
    sha256: "d3b21b8b38e48c6b4d1cb5cfe9adfe4abad7b3353601febd3c7e4027f9ef9c6b",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.IO.FileSystem.Watcher.dll",
    bytes: 20776,
    sha256: "07fc2b07b7d53173c695e60e93f2da4325b68c797c4351fff571923f01f8054c",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.IO.FileSystem.dll",
    bytes: 15656,
    sha256: "c251f33b29382c47b773d907463edd9fe978a06e39efd5670ef3b3b1d4f8c2b7",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.IO.IsolatedStorage.dll",
    bytes: 22312,
    sha256: "6720027218d12697d30640fb97acdb02438649cccb038ffdb3ad80dc27f6f736",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.IO.MemoryMappedFiles.dll",
    bytes: 18256,
    sha256: "028850f2cebbcc3ccb48fcef97751522ea6455c05ff9234686a16cc088fac5a4",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.IO.Pipelines.dll",
    bytes: 20304,
    sha256: "08344a31693477a61b45dff21739bf576c7482b394fab2fa26d2d8ba87b2cb91",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.IO.Pipes.AccessControl.dll",
    bytes: 18216,
    sha256: "80fda558926f7d7a085a6a210596000d281e4af2fb235e4c8dc9cbef8f1a87d0",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.IO.Pipes.dll",
    bytes: 22312,
    sha256: "0b7aaa8fea2a9483857b2ac918814ad1d8ff3303c98d6ef71d4593b16adee9ba",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.IO.UnmanagedMemoryStream.dll",
    bytes: 15696,
    sha256: "ad6a5f859589e1951103a00f45566da079cf87bd8b03f0c6ad985a6f39f19c5a",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.IO.dll",
    bytes: 15656,
    sha256: "388400ccb189b819d6ec5f1ef70710a39641d93ed5b870fc9324866b75dfb78b",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Linq.AsyncEnumerable.dll",
    bytes: 36176,
    sha256: "3367b7d6d2be9d171e158b544979131e8b97328b293d6e77917234a2a7279507",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Linq.Expressions.dll",
    bytes: 63312,
    sha256: "772112c3f1c10fb713ccc3ad62cc313c2cad1cbaf122ef6d25120aa7b65b0447",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Linq.Parallel.dll",
    bytes: 31016,
    sha256: "b4b597374ffebccf8a46793f03d5e6d5e477dfc5047157217d79449f9729e761",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Linq.Queryable.dll",
    bytes: 32040,
    sha256: "5baf83b98f103d9304eac427c4296c9dd501d320b7b5495ed8ede892aaf1076d",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Linq.dll",
    bytes: 33616,
    sha256: "9cb73d57c035503bdc70fdc422dee5bf4f9de97b812cd0dcb379d652c6f91205",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Memory.dll",
    bytes: 57168,
    sha256: "d7e674a1feff0546c9932b0fcffa9d055976736342a4b1904f1f27894f3c0ed6",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Net.Http.Json.dll",
    bytes: 23336,
    sha256: "bf97fcfa0d20adb597878f902b761480fb02fa0f9f81521f16f2455ddc6a1ed2",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Net.Http.dll",
    bytes: 60200,
    sha256: "3ff081221d0adeb99b5cf40788e20dab1d0d706618044b34e68a47529c761601",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Net.HttpListener.dll",
    bytes: 25384,
    sha256: "03ca98abeb9ea2c7e372c31aa460d2a9e526617c22fa97c9d8750977167a9634",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Net.Mail.dll",
    bytes: 32040,
    sha256: "8193e3652b1ecb1aa46258087bb5f44becd72693552da120e1274ef1ad443e53",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Net.NameResolution.dll",
    bytes: 17704,
    sha256: "97e0cc175bf13e4861e1508820f08561b38f28e98ebc9c5addb28c58fa7c344d",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Net.NetworkInformation.dll",
    bytes: 33576,
    sha256: "b90b729446f4ed3fa470b5c96e9c5adecbf4e438eaa91d0548832c58673a4c18",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Net.Ping.dll",
    bytes: 20264,
    sha256: "f623594e3309d40d36a7dd63dcb5251f72eb94eb2e74246805b4a0d23fc8c6b0",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Net.Primitives.dll",
    bytes: 37160,
    sha256: "129e7b324fbc12f8c54b89e6d6706b08455532fb64a8913038add92be2924244",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Net.Quic.dll",
    bytes: 23848,
    sha256: "f9651dcde17f5823c7d42be080059fd9f88aed81d91c64e58f95afca44a2e24a",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Net.Requests.dll",
    bytes: 41256,
    sha256: "d45910c06d2c2fcd6039e8b4076b5878fd195d0fc09d27c4ceb4009ad9491672",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Net.Security.dll",
    bytes: 53544,
    sha256: "c4af7099d2077e34c7074e94efeb57ac5707af128ee6e5e0e75d398b8e5843ba",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Net.ServerSentEvents.dll",
    bytes: 17192,
    sha256: "87ba81cd8fd6ab3a9a3f4dce922849aea832928f52495788d371dda66e57da01",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Net.ServicePoint.dll",
    bytes: 15144,
    sha256: "84fa83cd96e62fda02991b8a8e99fa1c7b3ac08807b04f7486a896cfe6b4a760",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Net.Sockets.dll",
    bytes: 47440,
    sha256: "8b7cebafd550083a8d242dbcfb7501384d17142ad6c2bbb047dd37a524762179",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Net.WebClient.dll",
    bytes: 27944,
    sha256: "e4e6cc79e23892c8e67a4cb594bb304a26a0328507c45dc2d1998bc6836311a0",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Net.WebHeaderCollection.dll",
    bytes: 19240,
    sha256: "c4ee735a52b966f3805cfbd5c172f151ffe013bd70c080f15c2f68be628cd357",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Net.WebProxy.dll",
    bytes: 18216,
    sha256: "42c8eb8bf1563806069e1dd1c6c651159daa5589b7f69ff817cdeab3bd02915f",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Net.WebSockets.Client.dll",
    bytes: 19240,
    sha256: "5ac14d45c1b92e9c831b37591941ea01f3097a39d130bc292506dd099aeb7260",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Net.WebSockets.dll",
    bytes: 23848,
    sha256: "c16043d3ffa90a8fdaf193f0df91f99d6c23518d8432b4caa2d70a92d4c3cfa7",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Net.dll",
    bytes: 17192,
    sha256: "481b38c912f8779b3510cd00f079e45096ea22b6defdaab66780d5ac3ae6986a",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Numerics.Vectors.dll",
    bytes: 58152,
    sha256: "cc06324f279c581d8f76c0c8f6b011cf8d05efd0c95e998d68f9243da124eb52",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Numerics.dll",
    bytes: 15184,
    sha256: "35adc9360421b3b7a3d50399cb2c651c160158d7e8c302907acbce5f61f4a4f7",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.ObjectModel.dll",
    bytes: 23336,
    sha256: "3a591e043cd443761537580084f714392bb3278176c9a19f1be8700a29ef6f56",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Reflection.DispatchProxy.dll",
    bytes: 15656,
    sha256: "0d46dfb9c4ffc27d05a1c089d8f60a1cb365855140a9b30972133208270dd08b",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Reflection.Emit.ILGeneration.dll",
    bytes: 20776,
    sha256: "0201069b706d397c573b9342902613a71879a2701994a48e2821c32d43101ae4",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Reflection.Emit.Lightweight.dll",
    bytes: 19240,
    sha256: "eef97e1049d8dd7ecc695080dd22c199ee8ca82b1cfcb3e33866cf7125dbd1a4",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Reflection.Emit.dll",
    bytes: 44368,
    sha256: "29021699e4128964365a86c22afb3b0a8368da7a3f7463c9c1a8fc0a1402a39f",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Reflection.Extensions.dll",
    bytes: 15144,
    sha256: "ceb1b81e1eb488d87bd43d16dc54450b2a78e0b653c44c988aae2a20abc162bc",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Reflection.Metadata.dll",
    bytes: 122152,
    sha256: "92ec811516b768220cc41fb6a7197f7ba735f97b694716dfd1bfdf274078a90a",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Reflection.Primitives.dll",
    bytes: 21840,
    sha256: "fa52402a7b4096ef109853f6bf03adef0e1de67e3652bb31f413d197f19f9b22",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Reflection.TypeExtensions.dll",
    bytes: 19752,
    sha256: "78178074bdb0f7714c634e4a1b425570264b13b2ca5b9ad6880622bff0bda58e",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Reflection.dll",
    bytes: 16168,
    sha256: "95059346d6271dd6d0322cc321e5fb8cceab662f550c67aee7615059e41739bb",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Resources.Reader.dll",
    bytes: 15144,
    sha256: "20bdb5d302b5e28f6042c9f281cfa3ae2f2358544cc40783052fe5abf6aa859b",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Resources.ResourceManager.dll",
    bytes: 15696,
    sha256: "f709eb5cf16e26679782784c428825019785fcc7085562092425d4999bece03d",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Resources.Writer.dll",
    bytes: 16208,
    sha256: "7e772363e799c78d8d1d37fe1d412723da9350496a6d7bacd37491f2bb777cc4",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Runtime.CompilerServices.Unsafe.dll",
    bytes: 15184,
    sha256: "6e685ec0477b21a688cd38bfcafc673888cdf186c99df3c96fab352e96d6fdc8",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Runtime.CompilerServices.VisualC.dll",
    bytes: 17192,
    sha256: "1e5eb23824055d6af5babb6a7ce47e314f78b0b464466db32b60f543304a9140",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Runtime.Extensions.dll",
    bytes: 17704,
    sha256: "3d7b517d4fd89ee58c53e0f642cc9be42e7a8669b51a85e861dafe118067cbfd",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Runtime.Handles.dll",
    bytes: 15656,
    sha256: "985457a3e6a67e96a445ee0fb69b2d58bcdadc4c964253fb63e2d5061a36b050",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Runtime.InteropServices.JavaScript.dll",
    bytes: 25896,
    sha256: "cb551cc19df1067dd8897d14bf02ecfa63d8ecf96067a21902406791d68ce226",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Runtime.InteropServices.RuntimeInformation.dll",
    bytes: 15656,
    sha256: "c26d9f94329422bd000f28f6c65fdc162bf9397a6d29e418a189d4ca49c5c3ec",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Runtime.InteropServices.dll",
    bytes: 101160,
    sha256: "8ced47e6a2a717c459c3fa13f76a521b35917e123a9b1ee7ed1b5de13db80709",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Runtime.Intrinsics.dll",
    bytes: 466216,
    sha256: "df8f497f64b6a3ac02941fae92e057faddf93f3f135f2f6444f725617c38b619",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Runtime.Loader.dll",
    bytes: 19752,
    sha256: "42884bcdc89ebd4ee509d5fcb4a679b1d7eebd6ddd9b66cb9e118063ddd30482",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Runtime.Numerics.dll",
    bytes: 36136,
    sha256: "4afc84f3e73b63ff6683941fcfda44e8a6aa5227b6afc128dcb979865e23d183",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Runtime.Serialization.Formatters.dll",
    bytes: 23848,
    sha256: "ef24bb5669b54b31da46eb13238fb2b7f880dd780dc9b34a224a69dd59d93af8",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Runtime.Serialization.Json.dll",
    bytes: 20776,
    sha256: "de7eeca7df9f6bb664383fbead141719bd08d88b6aef43c0605528719f607e62",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Runtime.Serialization.Primitives.dll",
    bytes: 19752,
    sha256: "a547b0d205cebe84508c2ddefd56d063c48cdfeae5b0c44bde6bae9f3d72f98a",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Runtime.Serialization.Xml.dll",
    bytes: 39760,
    sha256: "117bcb0dd828eaf6bfad06d8380ba32d32729b45879d907d7023fe73e9655bd9",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Runtime.Serialization.dll",
    bytes: 17192,
    sha256: "d565fc261ca98cbd14833821f777860291e8a0f775de7aee91778a9f6647f6f4",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Runtime.dll",
    bytes: 862504,
    sha256: "10ceaa9b398f512b46def6fd16fb5374c82ac03a7495859adbaaa70868fe70aa",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Security.AccessControl.dll",
    bytes: 37160,
    sha256: "2bd23d6aa92b920dafd374e1ab47ecb597ef3b1cf1652a4ec4944a0defb1a4ac",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Security.Claims.dll",
    bytes: 32552,
    sha256: "693a61dc317ab5a651ef598578a4b55912ac39342a0842fea003761f861b0caf",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Security.Cryptography.Algorithms.dll",
    bytes: 17232,
    sha256: "eb99ae7dbe058a1b015aba6769ce1f65155b7ff51ff9a7203fcf6d7cdea5fef7",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Security.Cryptography.Cng.dll",
    bytes: 16168,
    sha256: "7319f97896d92a7d0729cf28dc6c4d1f797c1520b656ee01a780eec726ec2c16",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Security.Cryptography.Csp.dll",
    bytes: 16208,
    sha256: "4002af141e9cb29875b677841adf64a9681e5672c2595492dcbc161460d4e121",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Security.Cryptography.Encoding.dll",
    bytes: 15656,
    sha256: "994494aec7760f40fade2264aa7c13eebae36360f0b1399a7134bb19c9d58fda",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Security.Cryptography.OpenSsl.dll",
    bytes: 15656,
    sha256: "1a8902bbad1b577a98bec62a8472105dc1e9a253e390f69fbe3d167e93206968",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Security.Cryptography.Primitives.dll",
    bytes: 15656,
    sha256: "194cccea9354bb248e44c954b5373f9069163f8f21524b3ee4b3185fe436bc15",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Security.Cryptography.X509Certificates.dll",
    bytes: 16680,
    sha256: "7439c3b90bc2ee49a9275b28ed29052b4d48b45999ac1b7d25593033b1bb8dd6",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Security.Cryptography.dll",
    bytes: 163112,
    sha256: "a700a7f6c32169e62be879088aa2218bdd5450c3945ed6c6d0acb3d25db0b1bf",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Security.Principal.Windows.dll",
    bytes: 26920,
    sha256: "4b8eab6e832e99e8c08db2b9649f95ae8298e1105deea45a62e7d3b68c6593b7",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Security.Principal.dll",
    bytes: 15144,
    sha256: "1d3e351058be3a33214b23b308fe57f78cd6fd4d8fad448fc84cbbe7376129f9",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Security.SecureString.dll",
    bytes: 15696,
    sha256: "73aac97072b7deefa4de9647bf822162224f1452ad467841b989ff89d4d94595",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Security.dll",
    bytes: 18256,
    sha256: "d8efd304765e859369698efef9b3ca707defa8e142721fe5605d7a2de7d38375",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.ServiceModel.Web.dll",
    bytes: 16680,
    sha256: "ce91013ee3a9a9d69a85e258f7749e6ece488295d7cb66f7c1079f2e8678fc5e",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.ServiceProcess.dll",
    bytes: 15696,
    sha256: "63fc498c9d04e3c4345dfdb8016ad0639d54562dd7d8c707c072792c854df944",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Text.Encoding.CodePages.dll",
    bytes: 15656,
    sha256: "2d66f9ae5e7439756eba063c0df86d6d3a0dc571f4bb07add18c59d6f10138ce",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Text.Encoding.Extensions.dll",
    bytes: 20776,
    sha256: "d6224360b0e91dfe544ec3baf0d5ded78a13349f6378493c96344a310c8caf08",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Text.Encoding.dll",
    bytes: 15696,
    sha256: "5e347db6b4f9b2746d50e1ac85be2d9cc7dc4038fde98ac4295bc7030c83cda9",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Text.Encodings.Web.dll",
    bytes: 26408,
    sha256: "f9f6120753fc9faeaa5b09e10ef309594dbd4c20c8cdf1717eb910455549793a",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Text.Json.dll",
    bytes: 82216,
    sha256: "4133a8597a10eeb99d56a962ff581db9fd3ac85506ee3a20a2d23119c73a4346",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Text.RegularExpressions.dll",
    bytes: 36648,
    sha256: "347c497cf2bd60a298efb59fe47156909ca854fdab4dabb944af7d6f8c270cef",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Threading.AccessControl.dll",
    bytes: 20776,
    sha256: "8449a1ee09edf8bdc69c61605bebec602c7b28a9ca401ca463512e4d369a3b7b",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Threading.Channels.dll",
    bytes: 19240,
    sha256: "c72028e4423fb04f3a644a76e1807e3651191aeb606b8f7b15b3650e4714cdca",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Threading.Overlapped.dll",
    bytes: 18768,
    sha256: "7837d3bd05e28f95749029c832fb1d0ce5bf403a17bef7bf95df522ba93dac3a",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Threading.Tasks.Dataflow.dll",
    bytes: 32040,
    sha256: "5d605d4c470c38bc37a04d58b4023a9c60179172790a29f4f7cb92aba6251648",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Threading.Tasks.Extensions.dll",
    bytes: 15696,
    sha256: "f148e3a1414b7c2763ae21529ad79ad759f7cfd3c885256b64b0d2209dec2613",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Threading.Tasks.Parallel.dll",
    bytes: 20264,
    sha256: "97f9ccb69d9f1d4d86df2869e1ef667c4c68285b04f336b1188e633c8f814d05",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Threading.Tasks.dll",
    bytes: 16680,
    sha256: "f80b21f7dae04377b73945456cabe25e2ab1f4b564095aed546c2aa571644567",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Threading.Thread.dll",
    bytes: 23888,
    sha256: "fff2281f039c07e564bcb198e041627082702beda24dccc8df39683701ea25a0",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Threading.ThreadPool.dll",
    bytes: 18216,
    sha256: "12fedf2de6449bfec4c1a08d762493bc0188e1b9b0a58028289105ed81b983f5",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Threading.Timer.dll",
    bytes: 15144,
    sha256: "9e4620846572f49aeb476aa99405071b4bbd0df4323e4e232787ed73642b1ee5",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Threading.dll",
    bytes: 33576,
    sha256: "0c2a3b4fddb2d732b8ebd0bca9ac57a8c66c9d4f5fbcb55fcd17e3cbcf678a4b",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Transactions.Local.dll",
    bytes: 25896,
    sha256: "c9faffc186d677de7800ff7d4d1b0d204ae7614e6b8518add582c840d7532a3b",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Transactions.dll",
    bytes: 16720,
    sha256: "56abfca0350c111d077b3d86a2469ea3da4fccc1871f7c51a8b4fdb664bb0ede",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.ValueTuple.dll",
    bytes: 15696,
    sha256: "07a5347f6a597e5e0d72109efa1a525697e8c3f74fb0029005500f8ebbf9187a",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Web.HttpUtility.dll",
    bytes: 17192,
    sha256: "f26b0586048fdf472e0fb33ca9435b163c91325de4281fce8684251cacc304cc",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Web.dll",
    bytes: 15144,
    sha256: "bc260b3db247ad9a6e4a82a275da85c3691a41272cc745cb7eaefcf1f31cc817",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Windows.dll",
    bytes: 15696,
    sha256: "716eee98ceee87d38f0b301224462f8442aa793f4b1b9c3ffac315753320ab37",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Xml.Linq.dll",
    bytes: 15696,
    sha256: "ae04903b25717fa4695e7e63489091f0d461e791e0bd264c6c85250d668f540d",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Xml.ReaderWriter.dll",
    bytes: 116008,
    sha256: "942964d32f72ba10288593f212e3a52c4811b65ca4d5f1a3979c92d2d526aa4c",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Xml.Serialization.dll",
    bytes: 16208,
    sha256: "489694401c60905cb6dca8ef0bf738cb609cd45b337126a01c825b913086ba43",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Xml.XDocument.dll",
    bytes: 34088,
    sha256: "05f6380411a81245960714a9fd81f6134f7bd279cd70b248a1e1586977798f1a",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Xml.XPath.XDocument.dll",
    bytes: 16168,
    sha256: "b8f74e198c3c2cd00ccc90549579f1b69c6ae1655f8b348ace414fd9075c921f",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Xml.XPath.dll",
    bytes: 16680,
    sha256: "0e68260b4c36d00c9a77c30a270100461123c0e7e1a37402bb7f67174051b8f3",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Xml.XmlDocument.dll",
    bytes: 15656,
    sha256: "a50b9b3a03596e36e73e7a7d54f4d018e8dcfaa7fe79e8cf900af8838ef3ec36",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Xml.XmlSerializer.dll",
    bytes: 50984,
    sha256: "f957611b80e082a453264a13bf27b5b251faf598f377f948195123a374b2e8f6",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.Xml.dll",
    bytes: 23376,
    sha256: "277a84ba155fe7808a514f32694a8157ec9f0eeeef00ef9643e5250004054ff0",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/System.dll",
    bytes: 49448,
    sha256: "ff11e2ab9009ef141e315187254f8327dd1e2591e44b8bf158730869028f1f0e",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/WindowsBase.dll",
    bytes: 16208,
    sha256: "0ec46a38f29a234b9a4d0ae9364c8322f661a47c831c5b948f2787b7ca12dbbd",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/mscorlib.dll",
    bytes: 55592,
    sha256: "894d95d82126559637417b4f14c48ed20bb1168b13a0e65bd1337cdc2a981d1b",
  },
  {
    file: "packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0/netstandard.dll",
    bytes: 100648,
    sha256: "3dc81dbc9dacd28261632c94410859eda24c2db50cd6c14309cbb2a434b50c57",
  },
  {
    file: "sdk/10.0.401/Roslyn/bincore/Microsoft.CodeAnalysis.CSharp.dll",
    bytes: 22065488,
    sha256: "7de783edc103adda2be3e7529f6a94eb7d541dc34b24e4180b3ad07a141d2d35",
  },
  {
    file: "sdk/10.0.401/Roslyn/bincore/Microsoft.CodeAnalysis.VisualBasic.dll",
    bytes: 4860200,
    sha256: "3683c42b44a261185e6f2b0131cbc3d9a844e5cfe613da40e6ff6f22325d99a6",
  },
  {
    file: "sdk/10.0.401/Roslyn/bincore/Microsoft.CodeAnalysis.dll",
    bytes: 9430864,
    sha256: "841b0eda2d97324ccd9d6e5b96176ed65221b4b2c4900809db9ba6d724d8b354",
  },
  {
    file: "sdk/10.0.401/Roslyn/bincore/VBCSCompiler.deps.json",
    bytes: 7832,
    sha256: "ca3a028c075875edef9529e36f64b6a9945becebd82e28fcc714b4ed76c3f34f",
  },
  {
    file: "sdk/10.0.401/Roslyn/bincore/VBCSCompiler.dll",
    bytes: 310568,
    sha256: "56f4786d9f632e79f9cdbd4c1aa8348325f0e31eff2701e5cb955e216e3739f5",
  },
  {
    file: "sdk/10.0.401/Roslyn/bincore/VBCSCompiler.runtimeconfig.json",
    bytes: 391,
    sha256: "29a1fe16a1a2c5728b1b526fe1e273e5978049946cfd6b70c26617bb05e992cb",
  },
  {
    file: "sdk/10.0.401/Roslyn/bincore/csc.deps.json",
    bytes: 5789,
    sha256: "bb3c7c6cde340201441d3d06bb1eef2b29ae24ab7f5d3e655be735516b568b03",
  },
  {
    file: "sdk/10.0.401/Roslyn/bincore/csc.dll",
    bytes: 152360,
    sha256: "981093bca59d77c85b22d5035a799e4e97c45694a531af61695aeb4e74fe1885",
  },
  {
    file: "sdk/10.0.401/Roslyn/bincore/csc.runtimeconfig.json",
    bytes: 391,
    sha256: "29a1fe16a1a2c5728b1b526fe1e273e5978049946cfd6b70c26617bb05e992cb",
  },
  {
    file: "sdk/10.0.401/Roslyn/bincore/vbc.deps.json",
    bytes: 5874,
    sha256: "19726a419f6d197110e05da4459d26ead35ccd37144ff7b6088e5ce96ee7a940",
  },
  {
    file: "sdk/10.0.401/Roslyn/bincore/vbc.dll",
    bytes: 152360,
    sha256: "ad4f737b0c72b489abc80d586d713d873932bc9d2139d6541b6620a1383ab178",
  },
  {
    file: "sdk/10.0.401/Roslyn/bincore/vbc.runtimeconfig.json",
    bytes: 391,
    sha256: "29a1fe16a1a2c5728b1b526fe1e273e5978049946cfd6b70c26617bb05e992cb",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/Microsoft.CSharp.dll",
    bytes: 893224,
    sha256: "dbf3216a3a6581cdcd69df801f0492d11067de87d2ef779324bc56f76d034959",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/Microsoft.NETCore.App.deps.json",
    bytes: 33937,
    sha256: "344135ec1fc1f20d4690550916ed3f1651866e16aa2bfa4c5bed174644e2e181",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/Microsoft.NETCore.App.runtimeconfig.json",
    bytes: 50,
    sha256: "b0389faed3531f74a620de69039790f308c6e08affe1ebd21bc51c3b80cde8b5",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/Microsoft.VisualBasic.Core.dll",
    bytes: 1335080,
    sha256: "d49fc36cc7b0cd9858334ed35c096f715b73829672d49957e667c4c80f789c9b",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/Microsoft.VisualBasic.dll",
    bytes: 17232,
    sha256: "76928c8e157f849b6e9d5433fed1e3d7a948d65a5f8011f3c0e6b54c2fd328b7",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/Microsoft.Win32.Primitives.dll",
    bytes: 15696,
    sha256: "d44a272523cab98de1576dbb012c92cbc6e87655cf4ff4adfd516383f565fae5",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/Microsoft.Win32.Registry.dll",
    bytes: 34600,
    sha256: "80371cb9613c8b8ee8f76239877d8e12ec8d7b0946ac2c7137f3784c62057014",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.AppContext.dll",
    bytes: 15184,
    sha256: "4e89e5998b1eee68784c3bc60181b21ac6def80a0b2980e91f09f9b48abb0595",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Buffers.dll",
    bytes: 15144,
    sha256: "b7e64555cb2228968f8b74d82dbb03289898f42022884ee7ffe2315b096d3b9a",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Collections.Concurrent.dll",
    bytes: 218920,
    sha256: "487d4efe7b4b369d44c4e55dc749d1fa42213f10fba64ebad889153663f86dba",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Collections.Immutable.dll",
    bytes: 1082664,
    sha256: "4ed6a837f1960f78eed0d7efe3f28b2136780724acf87abdc5f3728a69653a5c",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Collections.NonGeneric.dll",
    bytes: 104232,
    sha256: "bd0076142e304cc5eaa5510ccfed6e440e9a36f3814cbfed9e92b8a4dec0182a",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Collections.Specialized.dll",
    bytes: 105256,
    sha256: "bf8bf3bc62e3528fbd058fd1c16b6c7ee338156542514f34ff312c56ae5b5e8f",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Collections.dll",
    bytes: 329000,
    sha256: "3a8577365c6875db3955dd52ca5c9b297d5186c7ce5897566f8361d3cb7cc639",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.ComponentModel.Annotations.dll",
    bytes: 215888,
    sha256: "685ca589a974b3f1e78b5e4bbaab41329085cb4cac590a81a29b5ede63e2317e",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.ComponentModel.DataAnnotations.dll",
    bytes: 16680,
    sha256: "c17704f416819de727a542e043d225bb77b41aa181f108ecb3d5cf2a9c27cdb8",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.ComponentModel.EventBasedAsync.dll",
    bytes: 39208,
    sha256: "d2a2aee5b0e93a0063e9a78cb476e6aefe7b4ecec2a3a67b3eb298c99e220b97",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.ComponentModel.Primitives.dll",
    bytes: 80168,
    sha256: "ae4bd0c57bb36a494f2736dcafbba85eac8f9d6d448dfe497f314407c43f2efe",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.ComponentModel.TypeConverter.dll",
    bytes: 874320,
    sha256: "8cf0671101c2ca0d89cf35910f9329f2aced9763383ae478f962a05755aaaa40",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.ComponentModel.dll",
    bytes: 17704,
    sha256: "0b50c7583ddab8ef38f6115336bea95570374230e6c47e30a246979fb3b2f711",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Configuration.dll",
    bytes: 19280,
    sha256: "a4e870153038780d847a0d8f42fc0a79567e3ce4b2a255be29f9dc09af740196",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Console.dll",
    bytes: 226640,
    sha256: "aa44c872056be61e25e99819ab67b156b499a698e95173b372f49cc39ff21ad4",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Core.dll",
    bytes: 23376,
    sha256: "3e6baa4ddc37a07a0c8e6bb80ca78fbdbb6ebe8ced92cbaa3fcf42109960f0b0",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Data.Common.dll",
    bytes: 3228968,
    sha256: "806c14a1ecd36e4a01c1539bb7918c45b07a57469938ad983d82907a793cee46",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Data.DataSetExtensions.dll",
    bytes: 15656,
    sha256: "4a890df09a24df93954bc6a80ca956248f95896e74b88bdf60bee516fe5899f5",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Data.dll",
    bytes: 25384,
    sha256: "3820fe039b331219a3921a23a369b9cf85aeb7b240874227b07dac29cf0e575b",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Diagnostics.Contracts.dll",
    bytes: 16168,
    sha256: "e9d4f12bc29c9125b8c9351d4084c08d93c3fa387f14dabb013c5116de0b34e1",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Diagnostics.Debug.dll",
    bytes: 15656,
    sha256: "40d594a8c740a907f66c35a7340de693ebac1cc92aef99c7d577e35b255acbd5",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Diagnostics.DiagnosticSource.dll",
    bytes: 558376,
    sha256: "866723af31e4d145cb4b8ade2907c983e5cb3a1be15ea19c90c23de6350f8495",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Diagnostics.FileVersionInfo.dll",
    bytes: 46416,
    sha256: "31a659267a2a2860741258ab7cf0d7f176c1ba697e6c54bb7d91ecb66b62c7ba",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Diagnostics.Process.dll",
    bytes: 312616,
    sha256: "3dc6d0a3f541ce849cb5a0181ca734ee4e2ec1987a415ea90efb759b260177f9",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Diagnostics.StackTrace.dll",
    bytes: 30544,
    sha256: "fb41053fe5ad5be54de57715657ba80f35c870bb943c165bfde5982745dbcdeb",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Diagnostics.TextWriterTraceListener.dll",
    bytes: 65872,
    sha256: "2f0f817ad13baeb5ba5276b9b3843d1875e6afb0fe0ca611d8a129c871a0dd8b",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Diagnostics.Tools.dll",
    bytes: 15144,
    sha256: "0f7503cee4149aaa70445044bf1ff271cfa89aeff874a8c14f0db2925c892d40",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Diagnostics.TraceSource.dll",
    bytes: 152400,
    sha256: "120accef57bd85fc661c4d91863ff2dd1032874aad381607b3df747961bcde73",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Diagnostics.Tracing.dll",
    bytes: 16208,
    sha256: "3d4a9acc24ed1c53f5e579a89ce06785d0999f09e5edf79094cfce7ec515c69c",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Drawing.Primitives.dll",
    bytes: 128808,
    sha256: "ad043d48b8d2e6e64ecba1f832b0b198601d77d7161f0e23a221c5afa8525e7c",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Drawing.dll",
    bytes: 20264,
    sha256: "c8001b2bbf23d097bc3578b2d50e2491de117cd4f9578f64d574b6e6e8119aaa",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Dynamic.Runtime.dll",
    bytes: 16168,
    sha256: "5c4133f133d05686403f2abc698df271a8421214cf5c0ee6c74610fe9bca619c",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Formats.Asn1.dll",
    bytes: 251688,
    sha256: "964f1ccb23f77a03433846d0ad206c6fb6b9440e335b0ff00d6aae2e1c9764d5",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Formats.Tar.dll",
    bytes: 310608,
    sha256: "9ffa27a426debd612a85f3700d7efaff1743165260ffcff9fe78a099dc93ca14",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Globalization.Calendars.dll",
    bytes: 15656,
    sha256: "aa1c6f2166f952459333c625fdecee88a11cce2512d0f42311c0208110b8da39",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Globalization.Extensions.dll",
    bytes: 15184,
    sha256: "f4ffbe07918b2492a91ceb989a733531663316991756575dc25f0a43bbdfd670",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Globalization.dll",
    bytes: 15656,
    sha256: "ab2b1367ee010bdcca5185bd30685d5bae1d96aa0149ca4bb3d04ef6072e5a33",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.IO.Compression.Brotli.dll",
    bytes: 81704,
    sha256: "ec622b73ea23578045d21d515e793f90bb15d8e152c136348fefe137a080966c",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.IO.Compression.FileSystem.dll",
    bytes: 15144,
    sha256: "8021b0dd0e11e609409805c91a1d788680fc5473770a1637e2e2effe07e263bd",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.IO.Compression.ZipFile.dll",
    bytes: 105768,
    sha256: "6aaf4141839a7747b05bba12b38d1a4bd0a78ebbc64df763201250267f359556",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.IO.Compression.dll",
    bytes: 464168,
    sha256: "be603ce902685813d847251d5e5f80227651c63fa379b08cc26060dcc32c523c",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.IO.FileSystem.AccessControl.dll",
    bytes: 33616,
    sha256: "5047333d7d7712d0caa0e31953c15cf0084c0272dcb010fe9752118e2bdb4492",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.IO.FileSystem.DriveInfo.dll",
    bytes: 97064,
    sha256: "c4d91de4713a170c3c40509815ac069a770d57f24dbee812cace1a6b3f58fcc7",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.IO.FileSystem.Primitives.dll",
    bytes: 15184,
    sha256: "37394824b8c3a4fb015546b36b796e4a4e6259a4dd63f9914b6f733a2a1e1c45",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.IO.FileSystem.Watcher.dll",
    bytes: 114000,
    sha256: "58232db27d6a43e9cd4f0a664ee815ffdfec3a84a6755b2f826be26efbe6bf43",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.IO.FileSystem.dll",
    bytes: 15696,
    sha256: "f442b439785b3afca77bb3b1bddd45ff0d5ec5ebc00230335ec01a8fd7ae3bcc",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.IO.IsolatedStorage.dll",
    bytes: 84264,
    sha256: "83e6fb63b07e5719a8bf8032733f9f2b8a718e3bc1b04ccf32f2234632640f52",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.IO.MemoryMappedFiles.dll",
    bytes: 97064,
    sha256: "bdaabcba038e4f0be3912176fef0270be572aea10ca2ed891f163818df6d6964",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.IO.Pipelines.dll",
    bytes: 197928,
    sha256: "c2496490397d5112fa74aff423974ae4176193be5b26a606e78626b64819cda0",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.IO.Pipes.AccessControl.dll",
    bytes: 24872,
    sha256: "87d3c542364c36a7b9641528e453c45a9f260a9d553eeda5be9f3a48197226f9",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.IO.Pipes.dll",
    bytes: 146216,
    sha256: "77b4e72f0638d8742948a649f639e451c5dc12c9cd0b2bb9fc2ae44f1fd07ecd",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.IO.UnmanagedMemoryStream.dll",
    bytes: 15656,
    sha256: "9c49361f9f3ec55d589398a43db5fb40284bda4d41ec27b9dd9ae042b01a66ba",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.IO.dll",
    bytes: 15656,
    sha256: "80baddb2ead3b1cecd0d4f68b145370fb53e11b859425acd4639ea1e0c18fd20",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Linq.AsyncEnumerable.dll",
    bytes: 1493328,
    sha256: "8719ab645c2b2af190ed0e2767fe45b0c678f3360c9764f889e09e56aec4e25c",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Linq.Expressions.dll",
    bytes: 4650792,
    sha256: "5ab62b2d7778c80838c17220f35cab8033542451fc38a8db6a20544a87665a5c",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Linq.Parallel.dll",
    bytes: 892712,
    sha256: "f0e499087831bb412c84bb687b144e7edd47e8904e47c0646b24c53a35b1b1ae",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Linq.Queryable.dll",
    bytes: 213800,
    sha256: "1dd1ee66ec8b7fe446200b2195bd50493fc1fb213d34a06393898485a96f366d",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Linq.dll",
    bytes: 795432,
    sha256: "98073e1b98b6212e426813979ebe415ab83f7149a4a6fe96ab19a252600d459a",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Memory.dll",
    bytes: 164648,
    sha256: "0995f1219f084bf33cda821109614094d053a1265426ad605b3e6e805b3ac7d5",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Net.Http.Json.dll",
    bytes: 129872,
    sha256: "c5fe90babaedbcddb75aa767f21e6018c3c67f8029f206c41e4bded6775c74fc",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Net.Http.dll",
    bytes: 1926992,
    sha256: "588fb0bf39f138f2bd82f3e56eac214ccff1ee483387f7095af9d624dccf8f87",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Net.HttpListener.dll",
    bytes: 329552,
    sha256: "93d4b7ea76b17103272b4618f10b858e49f5cadc01be2b252ae4d90f4581cbaa",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Net.Mail.dll",
    bytes: 544552,
    sha256: "6c1bdb4994a5b5d15f70cbfb37be8fbc677bdbe319a1d8473ab17176afd19b8c",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Net.NameResolution.dll",
    bytes: 110416,
    sha256: "b442b040b891878908190af96932782dd40d9e8b86bff16cda1b3da73a761d78",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Net.NetworkInformation.dll",
    bytes: 189224,
    sha256: "40459ae2e2a7e80c0ed661cb55274374af58cc85c8b7336c3ce7563274c481f2",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Net.Ping.dll",
    bytes: 116008,
    sha256: "e4886a7cb02751ad85751d6d6c2a1d56131febd64967f4913685c01caab4ce73",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Net.Primitives.dll",
    bytes: 245032,
    sha256: "366509bacdf92c642ed1c4c145462e7027d22f34a6093403f237e199d0b44e61",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Net.Quic.dll",
    bytes: 398672,
    sha256: "e5f5dd3bd61381185f6d02b09eb5acd4c0107e35fd437041839391201f020677",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Net.Requests.dll",
    bytes: 420688,
    sha256: "6a2ab6d1ea318ca0e362528fcb33aabd4326040af1ee30d59607fc5243ed79b1",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Net.Security.dll",
    bytes: 954664,
    sha256: "33f157fdc6cf5e10fd9a9c7aafdb0a7359cdfa64f1b13ed5ab81e4be9be0cff7",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Net.ServerSentEvents.dll",
    bytes: 77608,
    sha256: "7913a1e5e48a72ece44234fae47d99a63adfde2be7b90a933e06bc6ac061f68a",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Net.ServicePoint.dll",
    bytes: 15184,
    sha256: "fa811c4a3e0cfff827ff3eeab96f8806d44f96d5da031d03af9775c7f2e393fd",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Net.Sockets.dll",
    bytes: 701776,
    sha256: "9eff3b7707ceabd6c06e58dfa8556b2304078853748fab35d6953695075637c5",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Net.WebClient.dll",
    bytes: 176424,
    sha256: "efeed6723fed633fd772f5bfc74ff30b51fd0cd036f6db1f090acc6d8e9dcc4a",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Net.WebHeaderCollection.dll",
    bytes: 62288,
    sha256: "606c1dd61c690d33cd60f0d4555c0d06a3df057166834163577cdff7348517a1",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Net.WebProxy.dll",
    bytes: 35112,
    sha256: "68a09dd33bf157b727f4972070d6887595b6f2d9fc710296e3c993090edaa629",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Net.WebSockets.Client.dll",
    bytes: 100136,
    sha256: "d1deb5464e91e50037f1199fd571c78d56120548f5eaeab746b4f35314d703d8",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Net.WebSockets.dll",
    bytes: 259880,
    sha256: "b931a12ffd1fca79da0592cd26efdff584537f635dce9f29345596f04b315e83",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Net.dll",
    bytes: 17192,
    sha256: "765eda7271bd85f7f577721ad93fe5623b004b3976ddb570cfc2dd1c21156d13",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Numerics.Vectors.dll",
    bytes: 15656,
    sha256: "b34977b06740f7cee68c7d88acccb6a538313d2bf997742862d2cd355f307b3a",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Numerics.dll",
    bytes: 15184,
    sha256: "abc376f54dd327cf9e53e723f660f49d90f4c6b43069075a848b97bd2a9656fc",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.ObjectModel.dll",
    bytes: 77608,
    sha256: "36d2a7954bf9a8b558474f76e36480d9cc54ad6c2c1698a17730cb4cb2086288",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Private.CoreLib.dll",
    bytes: 17080104,
    sha256: "6bc4e12523d7355829e75dbc4e2bc15367fb5e6a599d1130300d9a925ab4eda6",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Private.DataContractSerialization.dll",
    bytes: 2397480,
    sha256: "cf70fbf25461d253be58b8b4372fd45097c8db56d0ea8294bb231e9763c4a70b",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Private.Uri.dll",
    bytes: 265512,
    sha256: "7435b938af0a2306df30a350fdbc04a0c92cedcd7a783078e556cfa0e857a6fb",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Private.Xml.Linq.dll",
    bytes: 441128,
    sha256: "8979117478842bb8c99f4eb5b9488ff961747e034e31f9f35ed2a324d0fb756d",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Private.Xml.dll",
    bytes: 9003856,
    sha256: "81c714c0b7e58d5e69bb7a30e77fa9556c68d06997bc479c2e6c745035556d21",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Reflection.DispatchProxy.dll",
    bytes: 73000,
    sha256: "07d6b69a861cb665c990b2d0b9642613cc5b34d967ec3b713cd7b0eb5eefb101",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Reflection.Emit.ILGeneration.dll",
    bytes: 15656,
    sha256: "ca9244c6768fb2575c87ef39993827b284d45e6bc959206af51c088fe7142a59",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Reflection.Emit.Lightweight.dll",
    bytes: 15656,
    sha256: "a9be8cf2cacff2b632519fe43afd28e151520a0ccb2b111f4065d1ca358ad20a",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Reflection.Emit.dll",
    bytes: 344360,
    sha256: "66399f29233b0ea21465a6cb045365a2c5f769e28033a89ea4991a09970f2517",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Reflection.Extensions.dll",
    bytes: 15144,
    sha256: "0d285264b5e16a6281a05f04f40c808712c8334e8283a71743f89f7f996fee59",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Reflection.Metadata.dll",
    bytes: 1269584,
    sha256: "8af86335fccea0072f8c37ea4bf6196c63d7770a0dcf62d9de44f55dba7afa8d",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Reflection.Primitives.dll",
    bytes: 15696,
    sha256: "882f60e8400e94e335ccb2f2e45cad6bdd60d15bc0e4be33ddeae7aadf41c9db",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Reflection.TypeExtensions.dll",
    bytes: 34600,
    sha256: "45ca39bc766b3424841c1c8db2fa0dea6d5e378195748dc1f99c0959ee34b2aa",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Reflection.dll",
    bytes: 16168,
    sha256: "291715eee5e5f44e6b48e377ee905cffded634b709659336df7fd28a6870ea8c",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Resources.Reader.dll",
    bytes: 15144,
    sha256: "515fba22d59c4cef2fa31a39113d54a91a6b497d197c5c34ddb62271875ed0da",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Resources.ResourceManager.dll",
    bytes: 15656,
    sha256: "e0844971e49ea13e2d1530ede9ef9d30ab6dd8014b4f7dc1deeabea49c247852",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Resources.Writer.dll",
    bytes: 45864,
    sha256: "9516c84e4fc491bf02f639c8f2493daa2f36b91bcf307ea50893112e4f324d99",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Runtime.CompilerServices.Unsafe.dll",
    bytes: 15184,
    sha256: "19593575de84a66189f58164e9ffcd279ed166c7ff5f55cf56a18e235ce6776d",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Runtime.CompilerServices.VisualC.dll",
    bytes: 19240,
    sha256: "3d931fd5b84b07a100f2bad74ae7184611074af72efbb0de94bb29812016afd2",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Runtime.Extensions.dll",
    bytes: 17744,
    sha256: "7752b34042613fe940bab5d71894a399fa5c690a66861e125befd1d056b4a635",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Runtime.Handles.dll",
    bytes: 15656,
    sha256: "5267b93e50c9eb1c8f155b3aa7a92dc391dc3967b3f8977b31d00d7021d391f2",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Runtime.InteropServices.JavaScript.dll",
    bytes: 40232,
    sha256: "c138f78bc8f16413ac8ec382746412dac6b766c1ceb5ee9ff9a7c4ea6ca97f34",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Runtime.InteropServices.RuntimeInformation.dll",
    bytes: 15696,
    sha256: "6971e607c1f4702a13086b407441cf5d03502a862ff91f398f31c4d009ae4c44",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Runtime.InteropServices.dll",
    bytes: 111440,
    sha256: "9b6d41d71080275728dcb70bb61bc18f3ebbbfaa35a7eada98d366b54cd7710d",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Runtime.Intrinsics.dll",
    bytes: 17192,
    sha256: "22e9b4c2198f20ec25e6452fb6f46ca4f459b3cbd84e2307183445a810842bb2",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Runtime.Loader.dll",
    bytes: 15656,
    sha256: "ad35f9ab5c48f691ab5757bd7e9c87c9cdbaec6b40d4f0b401e6553cbd4b2752",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Runtime.Numerics.dll",
    bytes: 366888,
    sha256: "e17fd0537476f4f5b977b92d4ea5ffeba8ad1f7ce5a08dd46559e1008213836a",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Runtime.Serialization.Formatters.dll",
    bytes: 129360,
    sha256: "060e891cac02495047aae22d0bd8a54447f5ed5039dccba386df2335fcb812d7",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Runtime.Serialization.Json.dll",
    bytes: 15696,
    sha256: "a9e4076115c66f0951cb260046523d130e4e20c376445a406f598398cec3e0fa",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Runtime.Serialization.Primitives.dll",
    bytes: 30544,
    sha256: "f32df8418b6188724e2ac8af2c3baf57c9846d2192a1f2be01d127dc089c2ed7",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Runtime.Serialization.Xml.dll",
    bytes: 16680,
    sha256: "468f5f3cb550907c3132a9397f709130d4cf98fa00fc1bc26b82bb526ea633f8",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Runtime.Serialization.dll",
    bytes: 16720,
    sha256: "ee06911338356f01095b1f560138e51287f0a113117a47bce23ae7a8e1675ad2",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Runtime.dll",
    bytes: 44840,
    sha256: "72d735ce704ee6d20b8e6627e651cb02539e0cf013024037edf1e0aab6a90256",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Security.AccessControl.dll",
    bytes: 60240,
    sha256: "5f8c85d4a85aa2b3c47df86d11c404a7c72390df612c38fd1c56b86264b48a2c",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Security.Claims.dll",
    bytes: 102696,
    sha256: "9b1393e12b30eb90dc0062fca58d8b0cdf44245d11c7f91042de03ca71d060bf",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Security.Cryptography.Algorithms.dll",
    bytes: 17192,
    sha256: "9e1288a2d1e5525f93f4c84e7e0e5f543df7af2cda3b25aee335d5824a2ea505",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Security.Cryptography.Cng.dll",
    bytes: 16168,
    sha256: "cf923f3b0a3d4846b7e823711714e78f278dd80c0318707c058189b952d9e0db",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Security.Cryptography.Csp.dll",
    bytes: 16168,
    sha256: "501a06963afe1918e7342e86ae9c353992c950f946494e6af70c45dfeed0a4a1",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Security.Cryptography.Encoding.dll",
    bytes: 15656,
    sha256: "1c0637ba3de6f955cac23d25cee340f726256287e8f1966e351c180103d9857a",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Security.Cryptography.OpenSsl.dll",
    bytes: 15656,
    sha256: "b183593785e3899c08011e27071028f34b2b9679c0b929fa56055bf64a66e8c8",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Security.Cryptography.Primitives.dll",
    bytes: 15656,
    sha256: "e18c1d3f5547b83a719cf6a5abc2a1301dd7d0e41b561009af76f9e35544c04c",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Security.Cryptography.X509Certificates.dll",
    bytes: 16720,
    sha256: "a6be1d533a2672741743434bdb9b9c2ea173aa41c68f522c752a30f48b74c323",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Security.Cryptography.dll",
    bytes: 3115816,
    sha256: "87dab927056fcad0886d7ef2adf8a88dfd59b9ae4909d8293b91758e1b075176",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Security.Principal.Windows.dll",
    bytes: 39208,
    sha256: "3e72eb1f572dca89c08d2cebe4362a42784626280d7cf2cba4477dd192335097",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Security.Principal.dll",
    bytes: 15184,
    sha256: "a22a9e9549b65526a4835c830ee8976d70074fe1e4ddabb91537e0488a08c3d9",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Security.SecureString.dll",
    bytes: 15696,
    sha256: "06483f8bbd74f1840aa820bbb3bf020e4475db89fa3edd41b6a4b37346703223",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Security.dll",
    bytes: 18216,
    sha256: "0efa1a6d3979689448f5e66a0865315d6cb383035e7c7d2d3c356e16185068e3",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.ServiceModel.Web.dll",
    bytes: 16680,
    sha256: "bb5a4a84641ca934e234259e3a84ec4fad39e2d48c26973468d7f75b681d8ff6",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.ServiceProcess.dll",
    bytes: 15696,
    sha256: "a0ee8d1ae9e8855f5e68bf39de3271b1426d933b93908aee87f607e89fef475d",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Text.Encoding.CodePages.dll",
    bytes: 869200,
    sha256: "312dc1649953c3ff34f9be617e8187e1ee4471a42762b18b0df4d97c33b4ce24",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Text.Encoding.Extensions.dll",
    bytes: 15696,
    sha256: "68df046a176982d7eefc4460e5d474b74523e4d39be54204adbf76e5663ac038",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Text.Encoding.dll",
    bytes: 15696,
    sha256: "14e336777490605723571511fac2549accdaa3ca119b901c2e5002806c628000",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Text.Encodings.Web.dll",
    bytes: 122192,
    sha256: "523296142d1a287fc1d7b490589f59e53fbb404d60e8481cc91b71357c4985b9",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Text.Json.dll",
    bytes: 2102056,
    sha256: "6d7a71766ebf87de599f31d776613be254f9262f6628235b8127ac40fb8c21f4",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Text.RegularExpressions.dll",
    bytes: 1158992,
    sha256: "e60c4cb1858875c48f50cfeda321a9357d0cac0b881417ed052d98d66b9d35ed",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Threading.AccessControl.dll",
    bytes: 35152,
    sha256: "64d1cab2a9ddb8802f652c8544cc515d53d4567f2c559594d068ee0c5864d076",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Threading.Channels.dll",
    bytes: 165712,
    sha256: "6382c3233898c6f7430d1e44a333a87fe043e91724eaae573fd78927069c5eb3",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Threading.Overlapped.dll",
    bytes: 15656,
    sha256: "173c9ce41e42eedb6174c478d6472b5674ca88bfad3873997fe8fb8a88c7abaf",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Threading.Tasks.Dataflow.dll",
    bytes: 532816,
    sha256: "87e686e27f0e5c48448e04fcd9aa21f92626ca147c5fbfa1191d3264889bf427",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Threading.Tasks.Extensions.dll",
    bytes: 15656,
    sha256: "3bc9d4ae93904d03be6ed6c30e63421ead648226aafe1f09a5c39b1278f9558e",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Threading.Tasks.Parallel.dll",
    bytes: 134480,
    sha256: "3c5557704ff552f5629989cda9a2869cf9538a0f2a94da1c6ac89ffa712c451c",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Threading.Tasks.dll",
    bytes: 16680,
    sha256: "916d04cc6e8c957569a7694006dc0c3a0735e37f5df372fafdf358281cf995b6",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Threading.Thread.dll",
    bytes: 15656,
    sha256: "d5a062600ad1d58e7fe327ca26ecd1d79001f6f638c84c3798b25dae247f5972",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Threading.ThreadPool.dll",
    bytes: 15696,
    sha256: "8739261035985fa3258a8ef9d77f1255f79b98cced92403b4582b942819e855c",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Threading.Timer.dll",
    bytes: 15184,
    sha256: "bb370d5bc43e5440fe20286092e13bc3cd1cdb9535933418751bc5c46eef9823",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Threading.dll",
    bytes: 80680,
    sha256: "fd780a8dac7abd638d5bf86b67b9f6adf6601f09937eb1adee81c73ee9368d61",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Transactions.Local.dll",
    bytes: 401232,
    sha256: "8324d1e50445d0965ccef682c6b24012af4f1f69922e921f81763013ebf1f900",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Transactions.dll",
    bytes: 16680,
    sha256: "dcbfa0a9e44891dc755c724d245fa361f3fc2d3e9136583057b6baee4e988b1e",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.ValueTuple.dll",
    bytes: 15656,
    sha256: "42455951daa9bfbe1332fc64ee8d2f6258b5886668502a76ddeee79fdd9278dd",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Web.HttpUtility.dll",
    bytes: 57128,
    sha256: "0ab885107e5c5fbcf756efacc6b3295211f6738187dc538432b37a8b3ae79e65",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Web.dll",
    bytes: 15144,
    sha256: "77894d1aa3c5051a32655f9e21681c70eedd894be6129161515de9edb73c34cb",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Windows.dll",
    bytes: 15656,
    sha256: "faca68dae82fe0239f153d2708ce311e7c1aa0da1efce41fbf329959a6e46994",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Xml.Linq.dll",
    bytes: 15696,
    sha256: "e222d5155fa69232cc2514adf094a733f24082597695ecff5b81c8862f5a1726",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Xml.ReaderWriter.dll",
    bytes: 21840,
    sha256: "2224267337b361ed34a56f50fffe39ef5c675ae5c5704b9809f1ed07548f9f70",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Xml.Serialization.dll",
    bytes: 16168,
    sha256: "4f713a10243417454a9738b4046282c49ed11da1523221a7540df366c14c0c92",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Xml.XDocument.dll",
    bytes: 15696,
    sha256: "f49f6c8f07e1bbdcff0df9a25a32f8a5f7efe9f5c92818724077540270df7e4a",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Xml.XPath.XDocument.dll",
    bytes: 17192,
    sha256: "731689317874ef7525afb8d07da8d469a43f4318696b6ddc470cecbec42210a1",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Xml.XPath.dll",
    bytes: 15696,
    sha256: "c3393f9d5bed1eda22965e7ed15a666e50b8e5eddfb90ff847d653b26a241819",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Xml.XmlDocument.dll",
    bytes: 15656,
    sha256: "b5f5765a3ef19d679238d48e7df2ffa9848ca8148e45a0d84bcaf360984d01ae",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Xml.XmlSerializer.dll",
    bytes: 17704,
    sha256: "9f9a2f9a876193feaea0e2110e58e5c48ecf21b54367adaba2cd46212015dd87",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.Xml.dll",
    bytes: 23336,
    sha256: "21d82f50b8beb1293ff3649cf4dcb931c2d879c5b8468d087ff5a459ec9f8a7e",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/System.dll",
    bytes: 50472,
    sha256: "dfe4778ce9a8b629d7f5e68e84505077277d5e2946515513250cc0c17f8618d4",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/WindowsBase.dll",
    bytes: 16168,
    sha256: "28dc08dfaacfeebddde677c20beb08354b90f0ffe6c17ac0ebf8d3fbdf0dbfff",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/libSystem.Globalization.Native.so",
    bytes: 64600,
    sha256: "1d662d5279eb88163630aba1285fe5a3855f1170dd471f97822e3fccf5e32d04",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/libSystem.IO.Compression.Native.so",
    bytes: 920648,
    sha256: "8365346ef76144ac1c3bc5f1696931257fe24d3ed6e270b66ecac0754e669227",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/libSystem.Native.so",
    bytes: 96648,
    sha256: "52e79ba9c25b20c549c6badf6f58567c85fe1735f1a6c4b2819001e6e52d72f9",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/libSystem.Net.Security.Native.so",
    bytes: 14008,
    sha256: "ebb9362d37174b158518ede016ba82787b3a95b1c5497200f5b1b7a649555acd",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/libSystem.Security.Cryptography.Native.OpenSsl.so",
    bytes: 217144,
    sha256: "9b41917345722f1044fa81f6bf6daf9b0e1b733df3be1fdd0d31052c5cdfbf60",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/libclrgc.so",
    bytes: 778512,
    sha256: "31daa986d8ea3a25724d6a106e8f60f9b505ac65c46d0336af3a81c9ca90e9d4",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/libclrgcexp.so",
    bytes: 841824,
    sha256: "4f91c3a1ca536254c7a56f352aa5985c05a3dea11137eb7f712d7283b4296b81",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/libclrjit.so",
    bytes: 3783976,
    sha256: "627537775e09cf086e345e6e657c038100ad42c0ce1ec4363d26927c3d3faa28",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/libcoreclr.so",
    bytes: 6878344,
    sha256: "7900cfd6ab369686c0eb23f6967a07571623d8df5430444d878ec6ed0b9cb339",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/libcoreclrtraceptprovider.so",
    bytes: 622200,
    sha256: "6234c966ff5740be339c8744dc78242271eb4a6531236c46b88d0e4c8feba56e",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/libhostpolicy.so",
    bytes: 300216,
    sha256: "4c56fdd534ef4c40e98fd389d44ac2cc74357611681bd75dd31cb71ab977c2ae",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/libmscordaccore.so",
    bytes: 2379096,
    sha256: "02c9ef63a0eeac9a55be31b722b87993347c7f43dbd72d668e03e780062e83ca",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/libmscordbi.so",
    bytes: 1705760,
    sha256: "ee9c247387ed1e70d1bf7c1912b7f9d1ea35804ad349213e41d059c8bea133ef",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/mscorlib.dll",
    bytes: 59728,
    sha256: "a15bcf65ad1f2dae364d7dfdfadf7cf950cb3c4af428240c9a0e120230ce1897",
  },
  {
    file: "shared/Microsoft.NETCore.App/10.0.12/netstandard.dll",
    bytes: 100648,
    sha256: "ecd6eb5cd89e191ef266d2bd5684e19d916707f713388555291ddbb63bd87e85",
  },
] as const;
