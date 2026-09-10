import metadata from "../../../package.json";
import compatibility from "./compatibility.json";
export const BUILD_VERSION = metadata.version;
export const SHELL_API = compatibility.shellApi;
export const CONFIGURATION_SCHEMA = compatibility.schema;
