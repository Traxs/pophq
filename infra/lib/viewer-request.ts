/**
 * Source of the CloudFront viewer-request functions.
 *
 * A behavior takes one viewer-request function, so the www redirect and the client-side route
 * rewrite share one. The code is kept to ES5 because it runs in the CloudFront Functions
 * runtime, not Node; the tests evaluate the same string.
 */
export interface ViewerRequestOptions {
  /** The custom domain. Requests for www.<domain> are sent there permanently. */
  canonicalHost?: string | undefined;
  /** Serve index.html for client-side routes (/power, /callback, …); files keep their path. */
  spa: boolean;
}

export function viewerRequestCode(options: ViewerRequestOptions): string {
  const lines = ["function handler(event) {", "  var r = event.request;"];
  if (options.canonicalHost) {
    // Only www moves: the CloudFront name stays usable, because members signed in there keep
    // their session in that origin's storage and would be signed out by a redirect.
    lines.push(
      "  var host = r.headers.host ? r.headers.host.value : '';",
      `  if (host === ${JSON.stringify(`www.${options.canonicalHost}`)}) {`,
      "    var q = [];",
      "    for (var k in r.querystring) {",
      "      var p = r.querystring[k];",
      "      var vs = p.multiValue ? p.multiValue : [p];",
      "      for (var i = 0; i < vs.length; i++) { q.push(vs[i].value === '' ? k : k + '=' + vs[i].value); }",
      "    }",
      "    return {",
      "      statusCode: 301,",
      "      statusDescription: 'Moved Permanently',",
      "      headers: {",
      `        location: { value: ${JSON.stringify(`https://${options.canonicalHost}`)} + r.uri + (q.length ? '?' + q.join('&') : '') },`,
      "        'cache-control': { value: 'max-age=86400' },",
      "      },",
      "    };",
      "  }",
    );
  }
  if (options.spa) {
    lines.push("  if (r.uri.indexOf('.') === -1) { r.uri = '/index.html'; }");
  }
  lines.push("  return r;", "}");
  return lines.join("\n");
}
