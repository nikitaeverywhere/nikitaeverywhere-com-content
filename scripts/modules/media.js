import { readFile, readdir, lstat, exists, mkdirp } from "fs-extra";
import { createHash } from "crypto";
import exif from "exif-reader";
import parseWithFrontMatter from "front-matter";
import { marked } from "marked";
import Jimp from "jimp";
import sharp from "sharp";

const MAX_THUMBNAIL_SIZE_PX = 256;
const MAX_PICTURE_SIZE_PX = 1024;
const MAX_PANORAMA_SIZE_PX = 1024;
const WATERMARK_LOCATION = `${__dirname}/watermark-vertical.png`;
const MAX_CONCURRENT_IMAGE_PROCESSES = 1;

const imageProcessingQueue = [];
const findMedia = (json, existingSrc) => {
  for (const { media } of json) {
    if (!media) {
      continue;
    }
    for (const data of media) {
      if (data.src === existingSrc) {
        return data;
      }
    }
  }
  return null;
};
const getElapsedTimeStringFromMillis = (millis) =>
  `${Math.floor(millis / 1000 / 60)}min ${Math.floor(millis / 1000) % 60}sec`;
const parseExif = (buffer) => (buffer ? exif(buffer) : {});

const renderer = new marked.Renderer();
const originalLinkRenderer = renderer.link;
renderer.link = (href, title, text) => {
  const html = originalLinkRenderer.call(renderer, href, title, text);
  return html.replace(/^<a/, '<a target="_blank"');
};
marked.setOptions({
  targetBlank: true,
  renderer,
});

export const processMedia = async ({
  directory = "content/timeline",
  destDir = "build/img/auto", // Where files will go
  destDirClient = "/img/auto", // Where links on a client side will point
  referencedOnly = true, // Process only files which are referenced in index.md. Otherwise all files
  previousMedia = [], // Used for caching purposes
} = {}) => {
  const startTime = Date.now();
  const timelineFiles = await readdir(directory);
  const groupedFileNames = await Promise.all(
    timelineFiles.map(async (file) => {
      const filename = `${directory}/${file}`;
      if ((await lstat(filename)).isDirectory()) {
        const files = await readdir(filename);
        return files.map((f) => `${directory}/${file}/${f}`);
      }
      return null;
    })
  );
  // -> [['content/timeline/name/file.md', '...'], ...]

  let totalMediaProcessed = 0;
  let totalMediaToProcess = 0;
  const logStatus = (relativeFileName, status = "processing") =>
    console.log(
      `[${
        totalMediaProcessed + 1
      }/${totalMediaToProcess} ~ ${getElapsedTimeStringFromMillis(
        Date.now() - startTime
      )}] ${status} ${relativeFileName}`
    );
  const createdImages = [];
  const allTags = new Set();
  const unprocessedMedia = [];
  let { width: watermarkWidth, height: watermarkHeight } = await sharp(
    WATERMARK_LOCATION
  ).metadata();
  const watermarkScale = 0.2;
  watermarkWidth = Math.floor(watermarkWidth * watermarkScale);
  watermarkHeight = Math.floor(watermarkHeight * watermarkScale);
  const watermarkBuffer = await sharp(WATERMARK_LOCATION)
    .resize({
      width: watermarkWidth,
      height: watermarkHeight,
    })
    .toBuffer();

  await mkdirp(destDir); // Required for the first run

  const data = await Promise.all(
    groupedFileNames.map(async (filegroup, i) => {
      if (!filegroup) {
        return;
      }

      const filesPrefix = `${directory}/${timelineFiles[i]}`;

      const mdFileName = filegroup.find((f) => /\.md$/.test(f));
      if (!mdFileName && referencedOnly) {
        return;
      }

      const mdFileContent = mdFileName
        ? await readFile(mdFileName, "utf8")
        : "";
      const { attributes, body: markdownFileBody } =
        parseWithFrontMatter(mdFileContent);
      const imageFiles = new Set(
        filegroup.filter((f) => /\.jp(?:e)?g|\.png$/.test(f))
      );
      const parsedTags = attributes.tags && attributes.tags.split(/,\s*/g);

      if (parsedTags) {
        for (const tag of parsedTags) {
          allTags.add(tag);
        }
      }

      const media = referencedOnly
        ? attributes.media instanceof Array && attributes.media
        : (attributes.media || []).concat(
            // Concat with files from directory
            Array.from(imageFiles)
              .map((f) => ({
                src: f.replace(filesPrefix + "/", (s, i) => (i === 0 ? "" : s)),
              }))
              .filter(
                (
                  { src } // But not those which are already in media
                ) => !(attributes.media || []).find((o) => o.src === src)
              )
          );

      ["date", "date-start", "date-end"].forEach((attr) => {
        if (!attributes[attr]) {
          return;
        }
        const time = Date.parse(
          attributes[attr].replace(/(?:\sUTC)?$/, " UTC")
        );
        if (isNaN(time)) {
          delete attributes[attr];
        } else {
          attributes[attr] = time;
        }
      });

      const processedData = {
        ...Object.assign(attributes, {
          tags: parsedTags,
          media:
            ((media && media.length) || undefined) &&
            (
              await Promise.all(
                media.map(async (data) => {
                  if (!data.src) {
                    return null;
                  }

                  ++totalMediaToProcess;
                  if (
                    imageProcessingQueue.length < MAX_CONCURRENT_IMAGE_PROCESSES
                  ) {
                    imageProcessingQueue.push(() => {});
                  } else {
                    await new Promise((r) => imageProcessingQueue.push(r));
                  }

                  const relativeFileName = `${filesPrefix}/${data.src}`; // Support only relative file names
                  let dataToReturn = null;

                  c: if (imageFiles.has(relativeFileName)) {
                    // Process local media files
                    // image processing
                    const fileBuffer = await readFile(relativeFileName);
                    const sum = createHash("sha256").update(fileBuffer);
                    const finalName = `${sum.digest("hex").slice(0, 16)}`;
                    const finalExt = data.src.replace(/.*\.([^\.]+)$/, "$1");
                    const imageDestination = `${destDir}/${finalName}.${finalExt}`;
                    const thumbnailDestination = `${destDir}/${finalName}.thumbnail.${finalExt}`;
                    const imageClientDestination = `${destDirClient}/${finalName}.${finalExt}`;
                    const thumbnailClientDestionation = `${destDirClient}/${finalName}.thumbnail.${finalExt}`;
                    const prev = findMedia(
                      previousMedia,
                      imageClientDestination
                    );
                    dataToReturn = {
                      ...prev,
                      ...{
                        // Make md file's first line as a caption
                        caption:
                          markdownFileBody
                            .replace(/^[\s\n\r]*(?:#+)?(?:\s+)?/, "")
                            .replace(/[\r\n]+[\s\S]*$/, "") || undefined,
                      },
                      ...data,
                      type: "image",
                      src: imageClientDestination,
                      thumbnail: thumbnailClientDestionation,
                    };
                    createdImages.push(imageDestination);
                    createdImages.push(thumbnailDestination);

                    const lstats = await Promise.all(
                      [imageDestination, thumbnailDestination].map(exists)
                    );
                    if (lstats.reduce((exists, acc) => acc && exists, true)) {
                      logStatus(relativeFileName, "cached");
                      break c; // Cache - do not build it again if both file and thumbnail exist
                    }
                    logStatus(relativeFileName);

                    let image = sharp(fileBuffer);
                    let exifMeta;
                    const imgMeta = await image.metadata();
                    try {
                      exifMeta = parseExif(imgMeta.exif);
                    } catch (e) {
                      console.info(
                        `[i] No exif metadata for ${dataToReturn.src}`,
                        e.message || e
                      );
                    }
                    let { width, height } = imgMeta;
                    const isPanorama = width >= height * 2.73;
                    const maxSize = isPanorama
                      ? MAX_PANORAMA_SIZE_PX
                      : MAX_PICTURE_SIZE_PX;

                    dataToReturn.w = width;
                    dataToReturn.h = height;
                    if (exifMeta && exifMeta.exif) {
                      const exifData = exifMeta.exif;
                      const dateTaken =
                        exifData.DateTimeOriginal || exifData.DateTimeDigitized;
                      if (dateTaken) {
                        dataToReturn.d = new Date(dateTaken).getTime();
                      }
                    }

                    const horizontalThumbnail = width < height;
                    await image
                      .clone()
                      .resize({
                        width: horizontalThumbnail
                          ? Math.min(MAX_THUMBNAIL_SIZE_PX, width)
                          : undefined,
                        height: horizontalThumbnail
                          ? undefined
                          : Math.min(MAX_THUMBNAIL_SIZE_PX, height),
                      })
                      .toFile(thumbnailDestination);
                    if (
                      (isPanorama && height > maxSize) ||
                      (!isPanorama && width > maxSize)
                    ) {
                      const ratio =
                        width > height ? maxSize / height : maxSize / width;
                      image = image.resize({
                        width: width > height ? undefined : maxSize,
                        height: width > height ? maxSize : undefined,
                      });
                      width = Math.floor(width * ratio);
                      height = Math.floor(height * ratio);
                    }
                    const composite = [];
                    composite.push({
                      input: watermarkBuffer,
                      left: Math.max(0, width - watermarkWidth - 5),
                      top: Math.max(
                        0,
                        Math.floor(height / 2 - watermarkHeight / 2)
                      ),
                    });
                    await image.composite(composite).toFile(imageDestination);
                  } else if (/youtu(?:be\.com|\.be)\//.test(data.src)) {
                    // Process YouTube media

                    const videoId = (data.src.match(
                      /youtu(?:be\.com|\.be)\/(?:embed\/|watch\?v=)?([^\/\&\?]+)/
                    ) || [])[1];
                    if (!videoId) {
                      break c;
                    }
                    const src = `https://www.youtube-nocookie.com/embed/${videoId}`;
                    const prev = findMedia(previousMedia, src);

                    dataToReturn = {
                      ...prev,
                      ...data,
                      src,
                      type: "youtube",
                      thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
                      link: `https://www.youtube.com/watch?v=${videoId}`,
                    };

                    if (prev) {
                      // Cache
                      logStatus(src, "cached");
                      break c;
                    }
                    logStatus(src);

                    try {
                      const image = await Jimp.read(dataToReturn.thumbnail);
                      const [w, h] = [image.getWidth(), image.getHeight()];

                      dataToReturn.w = w;
                      dataToReturn.h = h;
                    } catch (e) {
                      console.error(
                        `Error when processing ${dataToReturn.thumbnail}`,
                        e
                      );
                      dataToReturn = null;
                      break c;
                    }
                  } else if (
                    /^https\:\/\/.*\.(?:jpe?g|png|gif)(?:\?.*)?$/.test(data.src)
                  ) {
                    // Process links to images

                    const prev = findMedia(previousMedia, data.src);

                    dataToReturn = {
                      ...data,
                      src: data.src,
                      type: "image",
                      // todo: add a local thumbnail/sizes and possibly copy?
                    };

                    if (prev) {
                      // Cache
                      logStatus(dataToReturn.src, "cached");
                      break c;
                    }
                    logStatus(dataToReturn.src);

                    try {
                      const image = await Jimp.read(dataToReturn.src);
                      const [w, h] = [image.getWidth(), image.getHeight()];

                      dataToReturn.w = w;
                      dataToReturn.h = h;
                    } catch (e) {
                      console.error(
                        `Error when processing ${dataToReturn.src}`,
                        e
                      );
                      dataToReturn = null;
                      break c;
                    }
                  }
                  if (!dataToReturn) {
                    unprocessedMedia.push([
                      filesPrefix,
                      data,
                      `unrecognized media or not found '${data.src}' (see scripts/data-update.js for supported media types)`,
                    ]);
                  }

                  ++totalMediaProcessed;
                  imageProcessingQueue.pop()(); // Resolve promises

                  return dataToReturn;
                })
              )
            ).filter((a) => !!a),
        }),
        html: marked(markdownFileBody) || undefined,
      };

      return processedData;
    })
  );

  console.log(`All parsed tags: ${Array.from(allTags).sort().join(", ")}`);
  if (unprocessedMedia.length) {
    console.warn(
      `⚠ WARNING! These media entries were not processed:\n${unprocessedMedia
        .map(([path, { src }, r]) => ` - ${src} at ${path} (${r})`)
        .join("\n")}`
    );
  }

  return {
    result: data
      .filter((a) => !!a)
      .sort(
        (a, b) =>
          new Date(a.date || a["date-start"]) <
          new Date(b.date || b["date-start"])
      ),
    outputFiles: createdImages,
  };
};
