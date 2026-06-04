import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, "dist");
const zipPath = join(root, "dist.zip");

const crcTable = new Uint32Array(256);

for (let i = 0; i < crcTable.length; i += 1) {
  let value = i;

  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }

  crcTable[i] = value >>> 0;
}

function crc32(buffer) {
  let value = 0xffffffff;

  for (const byte of buffer) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }

  return (value ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

  return { dosDate, dosTime };
}

function uint16(value) {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function uint32(value) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

async function collectEntries(directory) {
  const entries = [];

  async function walk(path) {
    const pathStat = await stat(path);
    const name = relative(root, path).split(sep).join("/");

    if (pathStat.isDirectory()) {
      entries.push({ name: `${name}/`, path, stat: pathStat, type: "directory" });

      const children = await readdir(path);
      children.sort();

      for (const child of children) {
        await walk(join(path, child));
      }

      return;
    }

    if (pathStat.isFile()) {
      entries.push({ name, path, stat: pathStat, type: "file" });
    }
  }

  await walk(directory);
  return entries;
}

function localFileHeader(entry) {
  const name = Buffer.from(entry.name);
  const { dosDate, dosTime } = dosDateTime(entry.stat.mtime);

  return Buffer.concat([
    uint32(0x04034b50),
    uint16(20),
    uint16(0),
    uint16(entry.compressionMethod),
    uint16(dosTime),
    uint16(dosDate),
    uint32(entry.crc),
    uint32(entry.compressedSize),
    uint32(entry.uncompressedSize),
    uint16(name.length),
    uint16(0),
    name,
  ]);
}

function centralDirectoryHeader(entry) {
  const name = Buffer.from(entry.name);
  const { dosDate, dosTime } = dosDateTime(entry.stat.mtime);
  const externalAttributes = entry.type === "directory" ? 0x10 : 0;

  return Buffer.concat([
    uint32(0x02014b50),
    uint16(20),
    uint16(20),
    uint16(0),
    uint16(entry.compressionMethod),
    uint16(dosTime),
    uint16(dosDate),
    uint32(entry.crc),
    uint32(entry.compressedSize),
    uint32(entry.uncompressedSize),
    uint16(name.length),
    uint16(0),
    uint16(0),
    uint16(0),
    uint16(0),
    uint32(externalAttributes),
    uint32(entry.offset),
    name,
  ]);
}

function endOfCentralDirectory(entryCount, centralDirectorySize, centralDirectoryOffset) {
  return Buffer.concat([
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(entryCount),
    uint16(entryCount),
    uint32(centralDirectorySize),
    uint32(centralDirectoryOffset),
    uint16(0),
  ]);
}

async function createZip() {
  const distStat = await stat(distDir);

  if (!distStat.isDirectory()) {
    throw new Error(`${basename(distDir)} is not a directory`);
  }

  const entries = await collectEntries(distDir);
  const output = [];
  let offset = 0;

  for (const entry of entries) {
    const content = entry.type === "file" ? await readFile(entry.path) : Buffer.alloc(0);
    const compressedContent =
      entry.type === "file" && content.length > 0 ? deflateRawSync(content) : content;

    entry.compressionMethod = entry.type === "file" && content.length > 0 ? 8 : 0;
    entry.crc = crc32(content);
    entry.compressedSize = compressedContent.length;
    entry.uncompressedSize = content.length;
    entry.offset = offset;

    const header = localFileHeader(entry);
    output.push(header, compressedContent);
    offset += header.length + compressedContent.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectory = entries.map(centralDirectoryHeader);
  const centralDirectorySize = centralDirectory.reduce((size, header) => size + header.length, 0);
  const end = endOfCentralDirectory(
    entries.length,
    centralDirectorySize,
    centralDirectoryOffset,
  );

  await rm(zipPath, { force: true });
  await writeFile(zipPath, Buffer.concat([...output, ...centralDirectory, end]));
}

await createZip();
console.log(`Created ${relative(root, zipPath)}`);
