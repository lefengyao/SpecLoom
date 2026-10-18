const version = "0.1.9";
const releaseDirectory = `../release/${version}`;

export const siteConfig = Object.freeze({
  version,
  platform: "Windows x64",
  downloads: Object.freeze({
    setup: `${releaseDirectory}/SpecLoom-${version}-Setup-x64.exe`,
    portable: `${releaseDirectory}/SpecLoom-${version}-Portable-x64.zip`,
  }),
});
