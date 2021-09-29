const axios = require("axios");
const { SkynetClient: BrowserSkynetClient } = require("skynet-js");

const { makeUrl } = require("./utils.js");

class SkynetClient {
  /**
   * The Skynet Client which can be used to access Skynet.
   * @constructor
   * @param {string} [portalUrl="https://siasky.net"] - The portal URL to use to access Skynet, if specified. To use the default portal while passing custom options, use "".
   * @param {Object} [customOptions={}] - Configuration for the client.
   * @param {string} [customOptions.method] - HTTP method to use.
   * @param {string} [customOptions.APIKey] - Authentication password to use.
   * @param {string} [customCookie=""] - Custom cookie header to set.
   * @param {string} [customOptions.customUserAgent=""] - Custom user agent header to set.
   * @param {Object} [customOptions.data=null] - Data to send in a POST.
   * @param {string} [customOptions.endpointPath=""] - The relative URL path of the portal endpoint to contact.
   * @param {string} [customOptions.extraPath=""] - Extra path element to append to the URL.
   * @param {Function} [customOptions.onUploadProgress] - Optional callback to track progress.
   * @param {Object} [customOptions.params={}] - Query parameters to include in the URl.
   */
  constructor(portalUrl, customOptions = {}) {
    // Check if portal URL provided twice.

    if (portalUrl && customOptions.portalUrl) {
      throw new Error(
        "Both 'portalUrl' parameter provided and 'customOptions.portalUrl' provided. Please pass only one in order to avoid conflicts."
      );
    }

    // Add portal URL to options if given.

    this.customOptions = { ...customOptions };
    // If portal was not given, the default portal URL will be used.
    if (portalUrl) {
      // Set the portalUrl if given.
      this.customOptions.portalUrl = portalUrl;
    }

    // Re-export selected client methods from skynet-js.

    let browserClient = new BrowserSkynetClient(portalUrl);
    this.browserClient = browserClient;

    // Download
    this.getSkylinkUrl = browserClient.getSkylinkUrl.bind(browserClient);

    // File API
    this.file = {
      getJSON: browserClient.file.getJSON.bind(browserClient),
      getEntryData: browserClient.file.getEntryData.bind(browserClient),
      getEntryLink: browserClient.file.getEntryLink.bind(browserClient),
      getJSONEncrypted: browserClient.file.getJSONEncrypted.bind(browserClient),
    };

    // SkyDB
    this.db = {
      deleteJSON: browserClient.db.deleteJSON.bind(browserClient),
      getJSON: browserClient.db.getJSON.bind(browserClient),
      setJSON: browserClient.db.setJSON.bind(browserClient),
      setDataLink: browserClient.db.setDataLink.bind(browserClient),
      getRawBytes: browserClient.db.getRawBytes.bind(browserClient),
    };

    // Registry
    this.registry = {
      getEntry: browserClient.registry.getEntry.bind(browserClient),
      getEntryUrl: browserClient.registry.getEntryUrl.bind(browserClient),
      getEntryLink: browserClient.registry.getEntryLink.bind(browserClient),
      setEntry: browserClient.registry.setEntry.bind(browserClient),
      postSignedEntry: browserClient.registry.postSignedEntry.bind(browserClient),
    };
  }

  /**
   * Creates and executes a request.
   * @param {Object} config - Configuration for the request. See docs for constructor for the full list of options.
   */
  executeRequest(config) {
    let url = config.url;
    if (!url) {
      url = makeUrl(config.portalUrl, config.endpointPath, config.extraPath ? config.extraPath : "");
    }

    // Build headers.
    const headers = buildRequestHeaders(config.headers, config.customUserAgent, config.customCookie);

    return axios({
      url,
      method: config.method,
      data: config.data,
      params: config.params,
      headers,
      auth: config.APIKey && { username: "", password: config.APIKey },
      responseType: config.responseType,
      onUploadProgress:
        config.onUploadProgress &&
        function ({ loaded, total }) {
          const progress = loaded / total;

          config.onUploadProgress(progress, { loaded, total });
        },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
  }
}

/**
 * Helper function that builds the request headers.
 *
 * @param [baseHeaders] - Any base headers.
 * @param [customUserAgent] - A custom user agent to set.
 * @param [customCookie] - A custom cookie.
 * @returns - The built headers.
 */
function buildRequestHeaders(baseHeaders, customUserAgent, customCookie) {
  const returnHeaders = { ...baseHeaders };
  // Set some headers from common options.
  if (customUserAgent) {
    returnHeaders["User-Agent"] = customUserAgent;
  }
  if (customCookie) {
    returnHeaders["Cookie"] = customCookie;
  }
  return returnHeaders;
}

// Export the client.

module.exports = { SkynetClient, buildRequestHeaders };

// Get the following files to run or the client's methods won't be defined.
require("./download.js");
require("./encryption.js");
require("./upload.js");
