import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export function decodeMetroSave(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.subarray(0, 4).toString("ascii") !== "METR") {
    throw new Error(`Not a METR save: ${filePath}`);
  }

  const headerSize = buffer.readUInt32LE(8);
  const previewSize = buffer.readUInt32LE(20);
  const payloadOffset = buffer.readUInt32LE(24);
  if (payloadOffset !== headerSize + 2 + previewSize) {
    throw new Error(
      `Unexpected METR layout: payload=${payloadOffset}, header=${headerSize}, preview=${previewSize}`,
    );
  }

  const payload = zlib.gunzipSync(buffer.subarray(payloadOffset));
  return JSON.parse(payload.toString("utf8"));
}

function latestMetroSave(directory) {
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".metro"))
    .map((name) => {
      const filePath = path.join(directory, name);
      return { filePath, modified: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.modified - a.modified)[0]?.filePath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const requested = process.argv[2];
  const filePath = requested ?? latestMetroSave("D:\\SubwayBuilder");
  if (!filePath) throw new Error("No .metro save found");
  const save = decodeMetroSave(filePath);
  console.log(
    JSON.stringify(
      {
        filePath,
        keys: Object.keys(save),
        id: save.id,
        name: save.name,
        cityCode: save.cityCode ?? save.city,
        dataKeys: save.data ? Object.keys(save.data) : [],
      },
      null,
      2,
    ),
  );
}
