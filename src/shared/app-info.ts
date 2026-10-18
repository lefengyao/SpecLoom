import packageJson from "../../package.json";

export const APP_INFO = Object.freeze({
  name: "SpecLoom",
  version: packageJson.version,
  description: packageJson.description,
  author: packageJson.author,
});
