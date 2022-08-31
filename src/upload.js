"use strict";

const FormData = require("form-data");
const fs = require("fs");
const p = require("path");

const { DetailedError, Upload } = require("@skynetlabs/tus-js-client");

const { buildRequestHeaders, SkynetClient } = require("./client");
const { DEFAULT_UPLOAD_OPTIONS, TUS_CHUNK_SIZE } = require("./defaults");
const { getFileMimeType, makeUrl, walkDirectory, uriSkynetPrefix, formatSkylink } = require("./utils");
const { throwValidationError, validateInteger } = require("./utils_validation");

/**
 * Uploads in-memory data to Skynet.
 *
 * @param {string|Buffer} data - The data to upload, either a string or raw bytes.
 * @param {string} filename - The filename to use on Skynet.
 * @param {Object} [customOptions={}] - Configuration options.
 * @returns - The skylink.
 */
SkynetClient.prototype.uploadData = async function (data, filename, customOptions = {}) {
  const opts = { ...DEFAULT_UPLOAD_OPTIONS, ...this.customOptions, ...customOptions };

  const sizeInBytes = data.length;

  if (sizeInBytes < opts.largeFileSize) {
    return await uploadSmallFile(this, data, filename, opts);
  }
  return await uploadLargeFile(this, data, filename, sizeInBytes, opts);
};

SkynetClient.prototype.uploadFile = async function (path, customOptions = {}) {
  const opts = { ...DEFAULT_UPLOAD_OPTIONS, ...this.customOptions, ...customOptions };

  const stat = await fs.promises.stat(path);
  const sizeInBytes = stat.size;
  const filename = opts.customFilename ? opts.customFilename : p.basename(path);
  const stream = fs.createReadStream(path);

  if (sizeInBytes < opts.largeFileSize) {
    return await uploadSmallFile(this, stream, filename, opts);
  }
  return await uploadLargeFile(this, stream, filename, sizeInBytes, opts);
};

async function uploadSmallFile(client, stream, filename, opts) {
  const params = {};
  if (opts.dryRun) params.dryrun = true;

  const formData = new FormData();
  formData.append(opts.portalFileFieldname, stream, filename);
  const headers = formData.getHeaders();

  const response = await client.executeRequest({
    ...opts,
    method: "post",
    data: formData,
    headers,
    params,
  });

  const responsedSkylink = response.data.skylink;
  // Format the skylink.
  const skylink = formatSkylink(responsedSkylink);

  return `${skylink}`;
}

async function uploadLargeFile(client, stream, filename, filesize, opts) {
  // Validation.
  if (
    opts.staggerPercent !== undefined &&
    opts.staggerPercent !== null &&
    (opts.staggerPercent < 0 || opts.staggerPercent > 100)
  ) {
    throw new Error(`Expected 'staggerPercent' option to be between 0 and 100, was '${opts.staggerPercent}`);
  }
  if (opts.chunkSizeMultiplier < 1) {
    throwValidationError("opts.chunkSizeMultiplier", opts.chunkSizeMultiplier, "option", "greater than or equal to 1");
  }
  // It's crucial that we only use strict multiples of the base chunk size.
  validateInteger("opts.chunkSizeMultiplier", opts.chunkSizeMultiplier, "option");
  if (opts.numParallelUploads < 1) {
    throwValidationError("opts.numParallelUploads", opts.numParallelUploads, "option", "greater than or equal to 1");
  }
  validateInteger("opts.numParallelUploads", opts.numParallelUploads, "option");

  const url = makeUrl(opts.portalUrl, opts.endpointLargeUpload);
  // Build headers.
  const headers = buildRequestHeaders({}, opts.customUserAgent, opts.customCookie);

  // Set the number of parallel uploads as well as the part-split function. Note
  // that each part has to be chunk-aligned, so we may limit the number of
  // parallel uploads.
  let parallelUploads = opts.numParallelUploads;
  const chunkSize = TUS_CHUNK_SIZE * opts.chunkSizeMultiplier;
  // If we use `parallelUploads: 1` then these have to be set to null.
  //let splitSizeIntoParts: ((totalSize: number, partCount: number) => Array<{ start: number; end: number }>) | null = null;
  let splitSizeIntoParts = null;
  //let staggerPercent: number | null = null;
  let staggerPercent = null;

  // Limit the number of parallel uploads if some parts would end up empty,
  // e.g. 50mib would be split into 1 chunk-aligned part, one unaligned part,
  // and one empty part.
  const numChunks = Math.ceil(filesize / TUS_CHUNK_SIZE);
  if (parallelUploads > numChunks) {
    parallelUploads = numChunks;
  }

  if (parallelUploads > 1) {
    // Officially doing a parallel upload, set the parallel upload options.
    splitSizeIntoParts = (totalSize, partCount) => {
      return splitSizeIntoChunkAlignedParts(totalSize, partCount, chunkSize);
    };
    staggerPercent = opts.staggerPercent;
  }

  return new Promise((resolve, reject) => {
    const tusOpts = {
      endpoint: url,
      chunkSize: chunkSize,
      retryDelays: opts.retryDelays,
      metadata: {
        filename,
        filetype: getFileMimeType(filename),
      },
      //uploadSize: filesize,
      parallelUploads,
      staggerPercent,
      splitSizeIntoParts,
      headers,
      onError: (error = Error | DetailedError) => {
        // Return error body rather than entire error.
        const res = error.originalResponse;
        const newError = res ? new Error(res.getBody().trim()) || error : error;
        reject(newError);
      },
      onSuccess: async () => {
        if (!upload.url) {
          reject(new Error("'upload.url' was not set"));
          return;
        }

        // Call HEAD to get the metadata, including the skylink.
        const resp = await client.executeRequest({
          ...opts,
          url: upload.url,
          endpointPath: opts.endpointLargeUpload,
          method: "head",
          headers: { ...headers, "Tus-Resumable": "1.0.0" },
        });
        const skylink = resp.headers["skynet-skylink"];
        resolve(`${uriSkynetPrefix}${skylink}`);
      },
    };

    const upload = new Upload(stream, tusOpts);
    upload.start();
  });
}

const splitSizeIntoChunkAlignedParts = function (totalSize, partCount, chunkSize) {
  if (partCount < 1) {
    throwValidationError("partCount", partCount, "parameter", "greater than or equal to 1");
  }
  if (chunkSize < 1) {
    throwValidationError("chunkSize", chunkSize, "parameter", "greater than or equal to 1");
  }
  // NOTE: Unexpected code flow. `uploadLargeFileRequest` should not enable
  // parallel uploads for this case.
  if (totalSize <= chunkSize) {
    throwValidationError("totalSize", totalSize, "parameter", `greater than the size of a chunk ('${chunkSize}')`);
  }

  const partSizes = new Array(partCount).fill(0);

  // Assign chunks to parts in order, looping back to the beginning if we get to
  // the end of the parts array.
  const numFullChunks = Math.floor(totalSize / chunkSize);
  for (let i = 0; i < numFullChunks; i++) {
    partSizes[i % partCount] += chunkSize;
  }

  // The leftover size that must go into the last part.
  const leftover = totalSize % chunkSize;
  // If there is non-chunk-aligned leftover, add it.
  if (leftover > 0) {
    // Assign the leftover to the part after the last part that was visited, or
    // the last part in the array if all parts were used.
    //
    // NOTE: We don't need to worry about empty parts, tus ignores those.
    const lastIndex = Math.min(numFullChunks, partCount - 1);
    partSizes[lastIndex] += leftover;
  }

  // Convert sizes into parts.
  const parts = [];
  let lastBoundary = 0;
  for (let i = 0; i < partCount; i++) {
    parts.push({
      start: lastBoundary,
      end: lastBoundary + partSizes[i],
    });
    lastBoundary = parts[i].end;
  }

  return parts;
};

/**
 * Uploads a directory from the local filesystem to Skynet.
 *
 * @param {string} path - The path of the directory to upload.
 * @param {Object} [customOptions] - Configuration options.
 * @param {Object} [customOptions.disableDefaultPath=false] - If the value of `disableDefaultPath` is `true` no content is served if the skyfile is accessed at its root path.
 * @returns - The skylink.
 */
SkynetClient.prototype.uploadDirectory = async function (path, customOptions = {}) {
  const opts = { ...DEFAULT_UPLOAD_OPTIONS, ...this.customOptions, ...customOptions };

  // Check if there is a directory at given path.
  const stat = await fs.promises.stat(path);
  if (!stat.isDirectory()) {
    throw new Error(`Given path is not a directory: ${path}`);
  }

  const formData = new FormData();
  path = p.resolve(path);
  let basepath = path;
  // Ensure the basepath ends in a slash.
  if (!basepath.endsWith("/")) {
    basepath += "/";
    // Normalize the slash on non-Unix filesystems.
    basepath = p.normalize(basepath);
  }

  for (const file of walkDirectory(path)) {
    // Remove the dir path from the start of the filename if it exists.
    let filename = file;
    if (file.startsWith(basepath)) {
      filename = file.replace(basepath, "");
    }
    formData.append(opts.portalDirectoryFileFieldname, fs.createReadStream(file), { filepath: filename });
  }

  // Use either the custom dirname, or the last portion of the path.
  let filename = opts.customDirname || p.basename(path);
  if (filename.startsWith("/")) {
    filename = filename.slice(1);
  }
  const params = { filename };
  if (opts.tryFiles) {
    params.tryfiles = JSON.stringify(opts.tryFiles);
  }
  if (opts.errorPages) {
    params.errorpages = JSON.stringify(opts.errorPages);
  }
  if (opts.disableDefaultPath) {
    params.disableDefaultPath = true;
  }

  if (opts.dryRun) params.dryrun = true;

  const response = await this.executeRequest({
    ...opts,
    method: "post",
    data: formData,
    headers: formData.getHeaders(),
    params,
  });

  return `${uriSkynetPrefix}${response.data.skylink}`;
};
