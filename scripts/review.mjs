import { constants, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workingCopy = new URL("../data/relay-review-local.sqlite", import.meta.url);
if (resolve(process.env.RELAY_DB_PATH ?? "") === fileURLToPath(workingCopy)) {
  try {
    copyFileSync(new URL("../data/relay-review.sqlite", import.meta.url), workingCopy, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

await import("./run.mjs");
