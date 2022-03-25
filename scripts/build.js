import "./init.js";
import { processMedia, updateSocialNetworksState } from "./modules/index.js";
import fetch from "node-fetch";
import execa from "execa";

import mkdirp from "mkdirp";
import { writeFile, readFile } from "fs-extra";

const DEST_DIR = "docs";
const TEMP_DIR = "temp";
const DEST_DIR_IMG = `${DEST_DIR}/img/auto`;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const generatedFilesSet = new Set();

const exec = async (cmd) => {
  console.log(`$ ${cmd}`);

  const start = Date.now();
  const execResult = execa.command(cmd, {
    cwd: process.cwd(),
    shell: true,
    buffer: false,
  });
  execResult.stdout.on("data", (data) => console.log(data));

  const result = await execResult;

  console.log(`[✔︎ ${Math.floor((Date.now() - start) / 100) / 10}s] ${cmd}`);

  return result;
};

(async () => {
  const dataObject = JSON.parse((await readFile("docs/data.json")).toString());
  console.log(
    `Original data.json: ${Object.entries(dataObject).length} properties`
  );

  for (const dir of [DEST_DIR, DEST_DIR_IMG, TEMP_DIR, DEST_DIR_IMG]) {
    console.log(`Creating ${dir}...`);
    await mkdirp(dir);
  }

  // Update social networks
  Object.assign(dataObject, {
    socialNetworks: await updateSocialNetworksState(dataObject),
  });

  let timelineArray = [];
  const processTimeline = async () => {
    const srcDir = `${TEMP_DIR}/content/timeline`;
    console.log(`Processing ${srcDir}...`);
    const { result, outputFiles } = await processMedia({
      directory: `${TEMP_DIR}/content/timeline`,
      destDir: DEST_DIR_IMG,
      referencedOnly: false,
      previousMedia: dataObject.timeline,
    });
    outputFiles.map(generatedFilesSet.add.bind(generatedFilesSet));
    timelineArray = timelineArray.concat(result);
  };

  if (GITHUB_TOKEN) {
    // For GitHub pipeline
    const repos = await getGitHubRepos();
    console.log(`Repositories to download:\n + ${repos.join("\n + ")}`);
    for (const repo of repos) {
      console.log(`Unpacking ${repo}...`);
      await exec(`rm -rf ${TEMP_DIR}`);
      await exec(
        `git clone '${repo.replace(
          "https://",
          // It will be hidden in GitHub workflow output.
          `https://zitros-bot:${GITHUB_TOKEN}@`
        )}' ${TEMP_DIR}`
      );
      await processTimeline();
    }
  } else {
    // For local testing
    await processTimeline();
  }

  // Update timeline array
  Object.assign(dataObject, {
    timeline: timelineArray,
  });

  // Update last update time
  Object.assign(dataObject, {
    lastUpdateAt: Date.now(),
  });

  console.log(`Writing ${DEST_DIR}/data.json...`);
  await writeFile(`${DEST_DIR}/data.json`, JSON.stringify(dataObject, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

const getGitHubRepos = async () => {
  const response = await fetch(`https://api.github.com/user/repos`, {
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
    },
  });

  const data = await response.json();

  if (!(data instanceof Array)) {
    console.warn("Unexpected response from GitHub list repositories:", data);
    return [];
  }

  return data
    .map((d) => d.clone_url)
    .filter((u) => u.includes("nikita-tk-timeline-"));
};

// Clean files in destDir which were not touched during the build
// await Promise.all(
//   (
//     await readdir(destDir)
//   )
//     .map((n) => `${destDir}/${n}`)
//     .filter((n) => !generatedFilesSet.has(n))
//     .map((f, i, arr) => {
//       console.log(`[${i + 1}/${arr.length}] deleting ${f}`);
//       remove(f);
//     })
// );
