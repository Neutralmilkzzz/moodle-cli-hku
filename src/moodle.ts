import { runCli } from "./cli.js";

runCli().then(code => {
  process.exitCode = code || process.exitCode;
});
