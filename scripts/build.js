import "./init.js";
import { processMedia, updateSocialNetworksState } from "./modules/index.js";
import fetch from "node-fetch";
import execa from "execa";

import mkdirp from "mkdirp";
import { writeFile, readFile, readdir, remove } from "fs-extra";

const GIT_USERNAME = process.env.GIT_USERNAME || "zitros-bot";
const DEST_DIR = "docs";
const URL_CONTENT_PREFIX = "/content"; // Prefix relative to /docs that is prepended client-side.
const TEMP_DIR = "temp";
const DEST_DIR_IMG = `${DEST_DIR}/img/auto`;
const REFS_DIR = `${DEST_DIR}/refs`;
const GIT_TOKEN = process.env.GIT_TOKEN || "no-github-token";

const exec = async (cmd) => {
  console.log(`$ ${cmd}`);

  const start = Date.now();
  const execResult = execa.command(cmd, {
    cwd: process.cwd(),
    shell: true,
    buffer: false,
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  execResult.stdout.on("data", (data) => {
    const string = data.toString();
    stdoutChunks.push(string);
    console.log(string);
  });
  execResult.stderr.on("data", (data) => {
    const string = data.toString();
    stderrChunks.push(string);
    console.log(string);
  });

  let result;
  try {
    result = await execResult;
  } catch (e) {
    const err = stderrChunks.join("");
    console.error(`Error when executing $ ${cmd}`, err || e);
    throw new Error(err || e.message || e);
  }

  console.log(`[✔︎ ${Math.floor((Date.now() - start) / 100) / 10}s] ${cmd}`);

  return {
    ...result,
    stdout: stdoutChunks.join("").replace(/\n?$/, ""),
    stderr: stderrChunks.join("").replace(/\n?$/, ""),
  };
};

(async () => {
  const dataObject = JSON.parse((await readFile("docs/data.json")).toString());
  console.log(
    `Original data.json: ${Object.entries(dataObject).length} properties`
  );

  for (const dir of [DEST_DIR, DEST_DIR_IMG, TEMP_DIR]) {
    console.log(`Creating ${dir}...`);
    await mkdirp(dir);
  }

  // Update social networks
  Object.assign(dataObject, {
    socialNetworks: await updateSocialNetworksState(dataObject),
  });

  let timelineArray = dataObject.timeline || [];
  const processTimeline = async ({ fromRepo } = {}) => {
    const srcDir = `${TEMP_DIR}/content/timeline`;
    console.log(`Processing ${srcDir}...`);
    const { result } = await processMedia({
      directory: `${TEMP_DIR}/content/timeline`,
      destDir: DEST_DIR_IMG,
      destDirClient: `${URL_CONTENT_PREFIX}/img/auto`,
      referencedOnly: false,
      previousMedia: dataObject.timeline,
      fromRepo,
    });

    // Join timeline
    timelineArray = timelineArray
      // Remove all media generated from {fromRepo}
      .filter((r) => r.fromRepo !== fromRepo)
      // Add newly generated media from {fromRepo}
      .concat(result);

    // Populate visitedAreas
    for (const post of result) {
      if (!post.location || !post.location.name || !post.location.code) {
        continue;
      }
      const isInVisitedAreas = (dataObject.visitedAreas || []).find(
        ({ code }) => code === post.location.code
      );
      if (!isInVisitedAreas) {
        (dataObject.visitedAreas = dataObject.visitedAreas || []).push({
          name: post.location.name,
          code: post.location.code,
        });
      }
    }
  };

  if (GIT_TOKEN) {
    // For GitHub pipeline
    const repos = await getGitHubRepos();
    console.log(`Repositories to download:\n + ${repos.join("\n + ")}`);
    for (const repo of repos) {
      const repoName = repo
        .replace(/^.*github.com\//, "")
        .replace(/\.git$/, "");
      const refFileName = `${REFS_DIR}/${repoName}`;
      console.log(`Checking whether we need to build ${repoName}...`);
      const fullRepoName = repo.replace(
        "https://",
        // It will be hidden in GitHub workflow output.
        `https://${GIT_TOKEN}@`
      );
      let currentRef;
      try {
        let x = await exec(
          `git ls-remote '${fullRepoName}' | grep -E -o -m 1 "[a-f0-9]+"`
        );
        currentRef = x.stdout;
      } catch (e) {
        if (e.toString().includes("not found")) {
          console.error(
            `Repository not found. Did you forget to add "${GIT_USERNAME}" as a collaborator to ${repo}?`
          );
        }
        throw e;
      }
      const repoRef = await (async () => {
        try {
          return (
            (await readFile(refFileName)).toString().match(/^\w+/) || []
          ).join("");
        } catch (e) {
          return "<no ref>";
        }
      })();

      if (currentRef === repoRef) {
        console.log(
          `Repository ${repoName} is up-to-date with ref=${currentRef}.`
        );
      } else {
        console.log(
          `Building repository ${repoName}, as its ref (${currentRef}) does not match ref in the current repo (${repoRef}).`
        );
        await exec(`rm -rf ${TEMP_DIR}`);
        await exec(`git clone '${fullRepoName}' ${TEMP_DIR}`);
        await processTimeline({ fromRepo: repoName });
        console.log(
          `Updating local ref of ${repoName} in ${refFileName} to be ${currentRef}...`
        );
        await exec(
          `mkdir -p ${refFileName.replace(
            /\/[^\/]+$/,
            ""
          )} && echo '${currentRef}' > ${refFileName}`
        );
      }
    }
  } else {
    // For local testing
    await processTimeline();
  }

  // Update timeline array
  Object.assign(dataObject, {
    timeline: timelineArray.sort((a, b) => (b.date || 0) - (a.date || 0)),
  });

  // Sort visitedAreas
  Object.assign(dataObject, {
    visitedAreas: (dataObject.visitedAreas || []).sort((a, b) =>
      (a.name + "").localeCompare(b.name)
    ),
  });

  // Update last update time
  Object.assign(dataObject, {
    lastUpdateAt: Date.now(),
  });

  // Write data.json
  console.log(`Writing ${DEST_DIR}/data.json...`);
  await writeFile(`${DEST_DIR}/data.json`, JSON.stringify(dataObject, null, 2));

  // Cleanup - delete all automatically generated files that are unused by data.json.
  const usedFiles = new Set(
    dataObject.timeline
      .reduce((acc, obj) => {
        for (const { src, thumbnail } of obj.media instanceof Array
          ? obj.media
          : []) {
          if (src) {
            acc.push(src);
          }
          if (thumbnail) {
            acc.push(thumbnail);
          }
        }
        return acc;
      }, [])
      // Take only those which are actual generated content (/content/img/auto/*.*), not external links.
      .filter((p) => p.startsWith(URL_CONTENT_PREFIX))
      // Make file paths corresponding to a local repo (=> docs/img/auto/*.*).
      .map((p) => p.replace(URL_CONTENT_PREFIX, DEST_DIR))
  );
  const allFiles = new Set(
    // A set of all file names currently present in a target dir docs/img/auto/*.*
    (await readdir(DEST_DIR_IMG)).map((f) => `${DEST_DIR_IMG}/${f}`)
  );
  console.log(
    `Deleting unused assets from ${DEST_DIR_IMG}, which are not present in data.json:`
  );
  for (const fileName of allFiles) {
    if (!usedFiles.has(fileName)) {
      console.log(`  + Deleting ${fileName}`);
      await remove(fileName);
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

const getGitHubRepos = async () => {
  const response = await fetch(`https://api.github.com/user/repos`, {
    headers: {
      Authorization: `token ${GIT_TOKEN}`,
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
