/**
 * IP rotation and proxy management for DeepLX
 * Handles proxy selection and request routing
 */

/**
 * Get available proxy endpoints from environment configuration
 * Parses and validates proxy URLs from environment variables
 * @param env Environment bindings containing proxy configuration
 * @returns ProxyEndpoint[] - Array of available proxy endpoints
 */
export function getProxyEndpoints(env: Env): ProxyEndpoint[] {
  // Get proxy URLs from environment variables
  const proxyUrls = env.PROXY_URLS
    ? env.PROXY_URLS.split(",").map((url) => url.trim())
    : [];

  // Return validated proxy endpoints
  return proxyUrls.map((url) => ({
    url,
  }));
}

/**
 * Select a random proxy from available endpoints
 * Implements random selection for load distribution
 * @param env Environment bindings containing proxy configuration
 * @returns Promise<ProxyEndpoint | null> - Selected proxy or null if none available
 */
export async function selectProxy(env: Env): Promise<ProxyEndpoint | null> {
  try {
    const proxies = getProxyEndpoints(env);

    if (proxies.length === 0) {
      return null;
    }

    // Random selection for load balancing
    const index = Math.floor(Math.random() * proxies.length);
    return proxies[index];
  } catch (error) {
    console.error("Failed to select proxy:", error);
    return null;
  }
}
