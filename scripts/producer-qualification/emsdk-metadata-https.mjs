// Dormant direct HTTPS adapter. Importing or constructing it performs no I/O.
// Actual operator invocation requires separate review of the frozen catalog.
import assert from "node:assert/strict";
import https from "node:https";
import tls from "node:tls";
import { metadataUrl } from "./emsdk-metadata-values.mjs";
import { validateCatalog } from "./emsdk-metadata-collector.mjs";

export function directMetadataTransport(catalog) {
  const frozen = validateCatalog(catalog);
  const roles = new Map(frozen.roles.map((role) => [role.id, role]));
  return (role, { signal }) =>
    new Promise((resolve, reject) => {
      assert.deepEqual(
        role,
        roles.get(role.id),
        "Transport only admits a complete frozen catalog role",
      );
      const url = metadataUrl(role.url, role);
      // Explicit CA list and TLS verification avoid ambient extra-CA/proxy settings.
      // Node's intrinsic HTTPS Agent opens its own direct socket; no proxy package,
      // fetch dispatcher, environment proxy variable or inherited global agent is used.
      const agent = new https.Agent({
        keepAlive: false,
        maxSockets: 1,
        proxyEnv: {},
        rejectUnauthorized: true,
        ca: tls.rootCertificates,
      });
      const request = https.request(
        url,
        {
          method: "GET",
          agent,
          signal,
          rejectUnauthorized: true,
          servername: url.hostname,
          headers: {
            Accept: role.kind === "blob" ? "text/plain" : "application/json",
            "Accept-Encoding": "identity",
          },
        },
        (response) => {
          let closed = false;
          resolve({
            status: response.statusCode,
            // Never retain arbitrary headers (such as cookies), request headers or TLS keys.
            headers: {
              "content-length": response.headers["content-length"],
              "content-encoding": response.headers["content-encoding"],
            },
            body: response,
            close() {
              if (!closed) {
                closed = true;
                const errors = [];
                for (const close of [
                  () => response.destroy(),
                  () => request.destroy(),
                  () => agent.destroy(),
                ])
                  try {
                    close();
                  } catch (error) {
                    errors.push(error);
                  }
                if (errors.length)
                  throw new globalThis.AggregateError(
                    errors,
                    "Direct metadata HTTPS cleanup was incomplete",
                  );
              }
            },
          });
        },
      );
      request.once("error", (error) => {
        agent.destroy();
        reject(error);
      });
      request.end();
    });
}
