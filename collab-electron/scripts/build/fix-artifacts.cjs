const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

module.exports = async function fixArtifacts(context) {
  const artifacts = (context?.artifactPaths || [])
    .filter((file) => fs.existsSync(file))
    .sort();

  if (artifacts.length === 0) {
    return [];
  }

  const lines = [];
  for (const artifactPath of artifacts) {
    const hash = crypto.createHash("sha256");
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(artifactPath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    lines.push(`${hash.digest("hex")}  ${path.basename(artifactPath)}`);
  }

  const checksumPath = path.join(context.outDir, "SHA256SUMS.txt");
  fs.writeFileSync(checksumPath, `${lines.join("\n")}\n`, "utf8");
  return [checksumPath];
};
