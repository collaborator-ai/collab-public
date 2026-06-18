const { notarize } = require("@electron/notarize");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function loadEnvLocal() {
  const envLocalPath = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(envLocalPath)) return;
  const content = fs.readFileSync(envLocalPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (key && rest.length > 0 && !(key.trim() in process.env)) {
      process.env[key.trim()] = rest.join("=").trim().replace(/^["']|["']$/g, "");
    }
  }
}

async function notarizeApp(context) {
  const { electronPlatformName, appOutDir, packager } = context;

  if (process.env.SKIP_NOTARIZE === "true") {
    console.log("Skipping notarization (SKIP_NOTARIZE is set)");
    return;
  }

  if (electronPlatformName !== "darwin") {
    console.log("Skipping notarization (not macOS)");
    return;
  }

  loadEnvLocal();

  const keychainProfile = process.env.KEYCHAIN_PROFILE;
  const appleId = process.env.APPLE_ID;
  const appleIdPassword =
    process.env.APPLE_ID_PASSWORD ||
    process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const appleTeamId = process.env.APPLE_TEAM_ID;

  if (!keychainProfile && !(appleId && appleIdPassword && appleTeamId)) {
    console.log("Skipping notarization (credentials not configured)");
    return;
  }

  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  if (!fs.existsSync(appPath)) {
    throw new Error(`App bundle not found: ${appPath}`);
  }

  console.log(`Notarizing ${appPath}`);

  const options = {
    appBundleId: packager.appInfo.id,
    appPath,
    tool: "notarytool",
  };

  if (keychainProfile) {
    console.log(`  Using keychain profile: ${keychainProfile}`);
    options.keychainProfile = keychainProfile;
  } else {
    console.log(`  Using Apple ID: ${appleId}`);
    options.appleId = appleId;
    options.appleIdPassword = appleIdPassword;
    options.teamId = appleTeamId;
  }

  const start = Date.now();
  await notarize(options);
  const seconds = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Notarization completed in ${seconds}s`);

  // Staple the ticket (retry up to 3 times)
  console.log("Stapling notarization ticket...");
  const maxAttempts = 3;
  const retryDelay = 30_000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = spawnSync("xcrun", ["stapler", "staple", appPath], {
      stdio: "pipe",
      encoding: "utf8",
    });

    if (result.status === 0) {
      console.log("Ticket stapled");
      return;
    }

    if (attempt < maxAttempts) {
      console.log(
        `Staple attempt ${attempt}/${maxAttempts} failed, ` +
          `retrying in ${retryDelay / 1000}s...`,
      );
      await new Promise((r) => setTimeout(r, retryDelay));
    } else {
      console.warn(
        `Could not staple after ${maxAttempts} attempts ` +
          "(app still valid via network check)",
      );
    }
  }
}

module.exports = notarizeApp;
