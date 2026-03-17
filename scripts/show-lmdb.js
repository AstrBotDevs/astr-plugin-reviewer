import fs from "node:fs";
import path from "node:path";
import { open } from "lmdb";

const dataDir = path.join(process.cwd(), "data");
const dbFileNames = ["plugin-publish-imdb.lmdb", "repo-trigger-counts.lmdb"];

async function readDb(fileName) {
  const dbPath = path.join(dataDir, fileName);
  if (!fs.existsSync(dbPath)) {
    return {
      file: fileName,
      path: dbPath,
      exists: false,
      count: 0,
      entries: [],
    };
  }

  const db = open({
    path: dbPath,
    readOnly: true,
  });

  try {
    const entries = [];
    for (const { key, value } of db.getRange()) {
      entries.push({ key, value });
    }

    return {
      file: fileName,
      path: dbPath,
      exists: true,
      count: entries.length,
      entries,
    };
  } finally {
    await db.close();
  }
}

const databases = await Promise.all(dbFileNames.map(readDb));

console.log(
  JSON.stringify(
    {
      dataDir,
      databases,
    },
    null,
    2
  )
);
