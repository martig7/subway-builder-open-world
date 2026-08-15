import fs from "node:fs";
import path from "node:path";

const [archive, command = "list", target = "", outputRoot = ""] = process.argv.slice(2);

if (!archive || !["list", "extract"].includes(command)) {
  console.error("Usage: node tools/inspect-asar.mjs <archive> list [pattern]");
  console.error("   or: node tools/inspect-asar.mjs <archive> extract <path-or-prefix> <output-dir>");
  process.exit(2);
}

const fd = fs.openSync(archive, "r");
const prefix = Buffer.alloc(16);
fs.readSync(fd, prefix, 0, prefix.length, 0);
const outerHeaderSize = prefix.readUInt32LE(4);
const jsonSize = prefix.readUInt32LE(12);
const headerBuffer = Buffer.alloc(jsonSize);
fs.readSync(fd, headerBuffer, 0, jsonSize, 16);
const header = JSON.parse(headerBuffer.toString("utf8"));
const contentOffset = 8 + outerHeaderSize;

const entries = [];
function walk(node, parent = "") {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const relativePath = parent ? `${parent}/${name}` : name;
    if (entry.files) walk(entry, relativePath);
    else entries.push({ relativePath, ...entry });
  }
}
walk(header);

if (command === "list") {
  const pattern = target ? new RegExp(target, "i") : null;
  for (const entry of entries) {
    if (!pattern || pattern.test(entry.relativePath)) {
      console.log(`${entry.size}\t${entry.unpacked ? "unpacked" : entry.offset}\t${entry.relativePath}`);
    }
  }
  fs.closeSync(fd);
  process.exit(0);
}

if (!target || !outputRoot) {
  console.error("extract requires both a path-or-prefix and an output directory");
  process.exit(2);
}

const normalizedTarget = target.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
const selected = entries.filter(
  ({ relativePath }) => relativePath === normalizedTarget || relativePath.startsWith(`${normalizedTarget}/`),
);
if (!selected.length) {
  console.error(`No ASAR entries matched: ${target}`);
  process.exit(1);
}

const resolvedRoot = path.resolve(outputRoot);
for (const entry of selected) {
  const destination = path.resolve(resolvedRoot, ...entry.relativePath.split("/"));
  if (destination !== resolvedRoot && !destination.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Unsafe archive path: ${entry.relativePath}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (entry.unpacked) {
    const source = path.join(`${archive}.unpacked`, ...entry.relativePath.split("/"));
    fs.copyFileSync(source, destination);
  } else {
    const buffer = Buffer.alloc(entry.size);
    fs.readSync(fd, buffer, 0, entry.size, contentOffset + Number(entry.offset));
    fs.writeFileSync(destination, buffer);
  }
  console.log(entry.relativePath);
}
fs.closeSync(fd);
